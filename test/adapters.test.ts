import { expect, it, vi } from "vitest";

import { createNativeBridge, type WebViewHandle } from "../src/react-native.js";
import { createWebBridge, type WebMessageEvent, type WebViewWindow } from "../src/web.js";
import { stringSchema, wire } from "./helpers.js";

const toNative = { request: stringSchema };
const toWeb = { response: stringSchema };
type Contract = { toNative: typeof toNative; toWeb: typeof toWeb };
const trusted = {
  allowedOrigins: ["https://app.example"],
  getCurrentUrl: () => "https://app.example/page",
};

function target() {
  const listeners = new Set<(event: WebMessageEvent) => void>();
  return {
    listeners,
    addEventListener(_type: "message", listener: (event: WebMessageEvent) => void) {
      listeners.add(listener);
    },
    removeEventListener(_type: "message", listener: (event: WebMessageEvent) => void) {
      listeners.delete(listener);
    },
    dispatch(event: WebMessageEvent) {
      for (const listener of listeners) listener(event);
    },
  };
}

it("connects Web and Native in both platform event locations", async () => {
  for (const platform of ["ios", "android"] as const) {
    const webWindow = target();
    const document = target();
    const native = createNativeBridge<Contract>({
      ...trusted,
      receive: toNative,
      getWebView: () => ({
        postMessage(data) {
          (platform === "ios" ? webWindow : document).dispatch({
            type: "message",
            data,
            origin: "",
            source: null,
          });
        },
      }),
    });
    const window: WebViewWindow = {
      ...webWindow,
      document,
      ReactNativeWebView: {
        postMessage(data) {
          void native.onMessage({ nativeEvent: { data, url: trusted.getCurrentUrl() } });
        },
      },
    };
    const web = createWebBridge<Contract>({ receive: toWeb, getWindow: () => window });
    const seen = vi.fn();
    const response = new Promise<void>((resolve) => {
      web.on("response", (value) => {
        seen(value);
        resolve();
      });
    });
    native.on("request", async (value) => {
      expect((await native.send("response", `${value}!`)).ok).toBe(true);
    });
    expect((await web.send("request", "hello")).ok).toBe(true);
    await response;
    expect(seen).toHaveBeenCalledWith("hello!");
    web.dispose();
    native.dispose();
    expect(webWindow.listeners.size).toBe(0);
    expect(document.listeners.size).toBe(0);
  }
});

it("processes a bubbling message once", async () => {
  const webWindow = target();
  const document = target();
  const web = createWebBridge<Contract>({
    receive: toWeb,
    getWindow: () => ({ ...webWindow, document }),
  });
  const seen = vi.fn();
  web.on("response", seen);
  const event = {
    type: "message",
    data: wire("response", "once"),
    origin: "",
    source: null,
  };
  document.dispatch(event);
  webWindow.dispatch(event);
  // A manual receive is queued after all transport events and acts as a deterministic barrier.
  await web.receive(wire("response", "barrier"));
  expect(seen.mock.calls).toEqual([["once"], ["barrier"]]);
  web.dispose();
});

it("is SSR-safe and reports missing transports without touching global window", async () => {
  const web = createWebBridge<Contract>({ receive: toWeb });
  expect(await web.send("request", "x")).toMatchObject({
    ok: false,
    error: { code: "transport_unavailable" },
  });
  web.dispose();
});

it("reads the current Native ref for every send and reports detached refs", async () => {
  let ref: WebViewHandle | null = null;
  const native = createNativeBridge<Contract>({
    ...trusted,
    receive: toNative,
    getWebView: () => ref,
  });
  expect(await native.send("response", "x")).toMatchObject({
    ok: false,
    error: { code: "transport_unavailable" },
  });
  const first = vi.fn();
  ref = { postMessage: first };
  expect((await native.send("response", "one")).ok).toBe(true);
  const second = vi.fn();
  ref = { postMessage: second };
  expect((await native.send("response", "two")).ok).toBe(true);
  expect(first).toHaveBeenCalledOnce();
  expect(second).toHaveBeenCalledOnce();
  native.dispose();
});

it("routes malformed native events through onError", async () => {
  const onError = vi.fn();
  const native = createNativeBridge<Contract>({
    ...trusted,
    receive: toNative,
    getWebView: () => null,
    onError,
  });
  await native.onMessage({
    nativeEvent: { data: "{invalid", url: trusted.getCurrentUrl() },
  });
  expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: "invalid_json" }));
  native.dispose();
});
