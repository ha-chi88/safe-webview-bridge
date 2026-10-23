import * as v from "valibot";

import { createNativeBridge } from "../../src/react-native.js";
import { createWebBridge } from "../../src/web.js";

const toNative = {
  request: v.pipeAsync(
    v.string(),
    v.transformAsync(async (value) => value.length),
  ),
};
const toWeb = { response: v.object({ length: v.number(), text: v.string() }) };
type Contract = { toNative: typeof toNative; toWeb: typeof toWeb };

export async function roundtrip(platform: "ios" | "android" | "bubbling") {
  const host = window as Window & {
    ReactNativeWebView?: { postMessage(data: string): void };
  };
  const received: unknown[] = [];
  const errors: string[] = [];
  const native = createNativeBridge<Contract>({
    allowedOrigins: [window.location.origin],
    getCurrentUrl: () => window.location.href,
    receive: toNative,
    onError: (error) => {
      errors.push(error.code);
    },
    getWebView: () => ({
      postMessage(data) {
        const event = new MessageEvent("message", {
          data,
          bubbles: platform === "bubbling",
        });
        (platform === "ios" ? window : document).dispatchEvent(event);
      },
    }),
  });
  host.ReactNativeWebView = {
    postMessage(data) {
      void native.onMessage({ nativeEvent: { data, url: window.location.href } });
    },
  };
  const web = createWebBridge<Contract>({
    receive: toWeb,
    onError: (error) => {
      errors.push(error.code);
    },
  });
  const text = "quotes: \" '\n</script>\u2028\u2029 日本語";
  native.on("request", async (length) => {
    const result = await native.send("response", { length, text });
    if (!result.ok) throw new Error(result.error.code);
  });
  let complete!: () => void;
  const done = new Promise<void>((resolve) => {
    complete = resolve;
  });
  web.on("response", (value) => {
    received.push(value);
    complete();
  });
  const sent = await web.send("request", text);
  await done;
  // Flush any duplicate/bubbling event, then verify teardown really detaches both listeners.
  await web.receive(
    JSON.stringify({ version: 1, channel: "other", type: "ignored", payload: null }),
  );
  web.dispose();
  native.dispose();
  window.dispatchEvent(new MessageEvent("message", { data: "bad json" }));
  document.dispatchEvent(
    new MessageEvent("message", { data: "bad json", bubbles: true }),
  );
  delete host.ReactNativeWebView;
  return { sent, received, errors, expected: { length: text.length, text } };
}

export async function rejectFrameMessages(frameUrl: string, opaque: boolean) {
  const messages = { value: v.string() };
  const bridge = createWebBridge<{ toNative: typeof messages; toWeb: typeof messages }>({
    receive: messages,
  });
  const received: string[] = [];
  bridge.on("value", (value) => {
    received.push(value);
  });
  const frame = document.createElement("iframe");
  if (opaque) frame.sandbox.add("allow-scripts");
  const origin = await new Promise<string>((resolve) => {
    const done = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow || event.data !== "attack-done") return;
      window.removeEventListener("message", done);
      resolve(event.origin);
    };
    window.addEventListener("message", done);
    frame.src = frameUrl;
    document.body.append(frame);
  });
  frame.remove();
  window.dispatchEvent(
    new MessageEvent("message", {
      data: JSON.stringify({
        version: 1,
        channel: "safe-webview-bridge",
        type: "value",
        payload: "native",
      }),
    }),
  );
  await bridge.receive(
    JSON.stringify({ version: 1, channel: "barrier", type: "ignored", payload: null }),
  );
  bridge.dispose();
  return { received, origin };
}
