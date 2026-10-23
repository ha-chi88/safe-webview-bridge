import type { StandardSchemaV1 } from "@standard-schema/spec";
import { afterEach, expect, it, vi } from "vitest";

import { createBridge, type JsonValue } from "../src/index.js";
import { createNativeBridge, createOriginPolicy } from "../src/react-native.js";
import { deferred, schema, unknownSchema, wire } from "./helpers.js";

afterEach(() => vi.useRealTimers());

it("checks elapsed deadlines before delivery even when synchronous schema work delayed timers", async () => {
  vi.useFakeTimers();
  const bridge = createBridge({
    receive: {
      value: schema((value: unknown) => {
        vi.setSystemTime(Date.now() + 30);
        return { value };
      }),
    },
    transport: { send() {} },
    limits: { processingTimeoutMs: 20 },
  });
  const handler = vi.fn();
  bridge.on("value", handler);
  expect(await bridge.receive(wire("value", null))).toMatchObject({
    ok: false,
    error: { code: "timeout" },
  });
  expect(handler).not.toHaveBeenCalled();
  bridge.dispose();
});

it.each(["__proto__", "constructor", "prototype"])(
  "rejects nested %s keys before schemas or merge handlers",
  async (key) => {
    const validate = vi.fn((value: unknown) => ({ value }));
    const messages = { value: schema(validate) };
    const send = vi.fn();
    const bridge = createBridge<typeof messages, typeof messages>({
      receive: messages,
      transport: { send },
    });
    const merged = {};
    const handler = vi.fn((value: unknown) => {
      Object.assign(merged, value);
    });
    bridge.on("value", handler);
    const input: JsonValue = JSON.parse(`{"items":[{"${key}":{"polluted":true}}]}`);
    expect(await bridge.send("value", input)).toMatchObject({
      ok: false,
      error: { code: "serialization_failed" },
    });
    expect(await bridge.receive(wire("value", input))).toMatchObject({
      ok: false,
      error: { code: "invalid_json" },
    });
    expect(
      await bridge.receive(
        wire("value", input).replace(
          key,
          `\\u${key.charCodeAt(0).toString(16).padStart(4, "0")}${key.slice(1)}`,
        ),
      ),
    ).toMatchObject({ ok: false, error: { code: "invalid_json" } });
    expect(validate).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
    bridge.dispose();
  },
);

it("bounds shared-reference expansion and node counts before serializing or validating", async () => {
  const validate = vi.fn((value: unknown) => ({ value }));
  const messages = { value: schema(validate) };
  const bridge = createBridge<typeof messages, typeof messages>({
    receive: messages,
    transport: { send() {} },
    limits: { maxJsonNodes: 64 },
  });
  let dag: JsonValue = "leaf";
  for (let index = 0; index < 30; index++) dag = [dag, dag];
  expect(await bridge.send("value", dag)).toMatchObject({
    ok: false,
    error: { code: "serialization_failed" },
  });
  expect(await bridge.receive(wire("value", Array(100).fill(null)))).toMatchObject({
    ok: false,
    error: { code: "invalid_json" },
  });
  expect(validate).not.toHaveBeenCalled();
  bridge.dispose();
});

it("accounts for escaped string lengths without invoking object hooks", async () => {
  const messages = { value: unknownSchema };
  const send = vi.fn();
  const bridge = createBridge<typeof messages, typeof messages>({
    receive: messages,
    transport: { send },
    limits: { maxMessageLength: 160 },
  });
  for (const value of [
    "x".repeat(200),
    "\u0000".repeat(20),
    "\ud800".repeat(20),
    { ["\u0000".repeat(20)]: 1 },
  ]) {
    expect(await bridge.send("value", value)).toMatchObject({
      ok: false,
      error: { code: "serialization_failed" },
    });
  }
  expect(send).not.toHaveBeenCalled();
  expect((await bridge.send("value", "日本語😀")).ok).toBe(true);
  expect(JSON.parse(send.mock.calls[0]?.[0] ?? "").payload).toBe("日本語😀");
  bridge.dispose();
});

it("does not expose JSON parser excerpts containing secrets", async () => {
  const observer = vi.fn();
  const bridge = createBridge({
    receive: {},
    transport: { send() {} },
    onError: observer,
  });
  const result = await bridge.receive('{"secret":"private-token-123",BAD}');
  expect(result).toMatchObject({ ok: false, error: { code: "invalid_json" } });
  expect(JSON.stringify([result, observer.mock.calls])).not.toContain(
    "private-token-123",
  );
  if (!result.ok) expect("cause" in result.error).toBe(false);
  bridge.dispose();
});

it("charges malformed input against the receive rate and refills over time", async () => {
  vi.useFakeTimers();
  const bridge = createBridge({
    receive: { value: unknownSchema },
    transport: { send() {} },
    limits: { maxMessagesPerSecond: 2 },
  });
  for (let index = 0; index < 2; index++)
    expect(await bridge.receive("{")).toMatchObject({
      ok: false,
      error: { code: "invalid_json" },
    });
  expect(await bridge.receive(wire("value", null))).toMatchObject({
    ok: false,
    error: { code: "rate_limited" },
  });
  await vi.advanceTimersByTimeAsync(500);
  expect((await bridge.receive(wire("value", null))).ok).toBe(true);
  expect(await bridge.receive(wire("value", null))).toMatchObject({
    ok: false,
    error: { code: "rate_limited" },
  });
  bridge.dispose();
});

it.each(["send", "receive"] as const)(
  "bounds retained %s data independently of message count",
  async (direction) => {
    const gate = deferred<void>();
    const messages = {
      value: schema(async (value: unknown) => {
        await gate.promise;
        return { value };
      }),
    };
    const raw = wire("value", "first");
    const bridge = createBridge<typeof messages, typeof messages>({
      receive: messages,
      transport: {
        async send() {
          await gate.promise;
        },
      },
      limits: { maxPendingMessageLength: raw.length * 2, maxPendingMessages: 10 },
    });
    const run = () =>
      direction === "send" ? bridge.send("value", "first") : bridge.receive(raw);
    const first = run();
    const second = run();
    expect(await run()).toMatchObject({ ok: false, error: { code: "queue_full" } });
    gate.resolve();
    expect((await first).ok).toBe(true);
    expect((await second).ok).toBe(true);
    expect((await run()).ok).toBe(true);
    bridge.dispose();
  },
);

it.each(["send", "receive"] as const)(
  "keeps timed-out %s work charged until it actually settles",
  async (direction) => {
    vi.useFakeTimers();
    const gate = deferred<void>();
    const work = vi.fn(async (value: unknown) => {
      if (value === "slow") await gate.promise;
      return { value };
    });
    const messages = { value: schema(work) };
    const bridge = createBridge<typeof messages, typeof messages>({
      receive: messages,
      transport: {
        async send(raw) {
          await work(JSON.parse(raw).payload);
        },
      },
      limits: { processingTimeoutMs: 20, maxPendingMessages: 2 },
    });
    const handler = vi.fn();
    bridge.on("value", handler);
    const run = (value: string) =>
      direction === "send"
        ? bridge.send("value", value)
        : bridge.receive(wire("value", value));
    for (let index = 0; index < 2; index++) {
      const result = run("slow");
      await vi.advanceTimersByTimeAsync(20);
      expect(await result).toMatchObject({ ok: false, error: { code: "timeout" } });
    }
    expect(await run("blocked")).toMatchObject({
      ok: false,
      error: { code: "queue_full" },
    });
    expect(work).toHaveBeenCalledTimes(2);
    gate.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(handler).not.toHaveBeenCalled();
    expect((await run("recovered")).ok).toBe(true);
    bridge.dispose();
  },
);

it("bounds both asynchronous and synchronous error observers", async () => {
  vi.useFakeTimers();
  const gate = deferred<void>();
  for (const asynchronous of [false, true]) {
    const observer = vi.fn(() => (asynchronous ? gate.promise : undefined));
    const bridge = createBridge({
      receive: {},
      transport: { send() {} },
      onError: observer,
    });
    for (let index = 0; index < 30; index++) await bridge.receive("{");
    expect(observer).toHaveBeenCalledTimes(asynchronous ? 1 : 10);
    bridge.dispose();
  }
  gate.resolve();
});

it("uses exact immutable origins and rejects ambiguous URLs", () => {
  const origins = ["https://app.example", "http://localhost:3000"];
  const allowed = createOriginPolicy(origins);
  origins.push("https://evil.example");
  expect(allowed("https://app.example/path?q=value#hash")).toBe(true);
  expect(allowed("http://localhost:3000/page")).toBe(true);
  for (const url of [
    undefined,
    "",
    "https://evil.example",
    "https://app.example.evil.test",
    "https://app.example@evil.test",
    "https://name:password@app.example",
    "https://app.example:444",
    "http://app.example",
    "blob:https://app.example/forged-document",
    "blob:http://localhost:3000/forged-document",
    "file:///app.example",
    "javascript:void(0)",
    "https://app.ex\nample",
    " https://app.example",
    "https:\\app.example",
    "null",
  ]) {
    expect(allowed(url), String(url)).toBe(false);
  }
  for (const invalid of [
    [],
    ["*"],
    ["https://*.example"],
    ["https://app.example/path"],
    ["https://app.example/"],
    ["http://app.example"],
    ["null"],
    ["file://"],
  ]) {
    expect(() => createOriginPolicy(invalid)).toThrow();
  }
});

it("gates both Native directions on host-owned trust state and verifies incoming URL metadata", async () => {
  const messages = { value: unknownSchema };
  type Contract = { toNative: typeof messages; toWeb: typeof messages };
  let currentUrl: string | null = "https://app.example/page";
  const sent = vi.fn();
  const bridge = createNativeBridge<Contract>({
    receive: messages,
    allowedOrigins: ["https://app.example"],
    getCurrentUrl: () => currentUrl,
    getWebView: () => ({ postMessage: sent }),
  });
  const handler = vi.fn();
  bridge.on("value", handler);
  const deliver = (url: string) =>
    bridge.onMessage({ nativeEvent: { url, data: wire("value", null) } });
  for (const url of [
    "https://evil.example",
    "https://app.example.evil.test",
    "blob:https://app.example/forged-document",
    "",
  ]) {
    expect(await deliver(url)).toMatchObject({
      ok: false,
      error: { code: "untrusted_origin" },
    });
  }
  expect((await deliver(currentUrl)).ok).toBe(true);
  expect((await bridge.send("value", null)).ok).toBe(true);
  currentUrl = null;
  expect(await deliver("https://app.example/page")).toMatchObject({
    ok: false,
    error: { code: "untrusted_origin" },
  });
  expect(await bridge.send("value", null)).toMatchObject({
    ok: false,
    error: { code: "transport_unavailable" },
  });
  expect(handler).toHaveBeenCalledTimes(1);
  expect(sent).toHaveBeenCalledTimes(1);
  expect("receive" in bridge).toBe(false);
  bridge.dispose();
});

it("disposal during navigation suppresses late Native validation results", async () => {
  const gate = deferred<StandardSchemaV1.Result<unknown>>();
  const messages = { value: schema(() => gate.promise) };
  const bridge = createNativeBridge<{
    toNative: typeof messages;
    toWeb: typeof messages;
  }>({
    receive: messages,
    allowedOrigins: ["https://app.example"],
    getCurrentUrl: () => "https://app.example",
    getWebView: () => null,
  });
  const handler = vi.fn();
  bridge.on("value", handler);
  const result = bridge.onMessage({
    nativeEvent: { url: "https://app.example", data: wire("value", null) },
  });
  await Promise.resolve();
  bridge.dispose();
  expect(await result).toMatchObject({ ok: false, error: { code: "disposed" } });
  gate.resolve({ value: "late" });
  await Promise.resolve();
  await Promise.resolve();
  expect(handler).not.toHaveBeenCalled();
});
