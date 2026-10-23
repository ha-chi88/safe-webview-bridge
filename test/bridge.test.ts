import type { StandardSchemaV1 } from "@standard-schema/spec";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createBridge, defineMessages, type Result } from "../src/index.js";
import { deferred, schema, stringSchema, unknownSchema, wire } from "./helpers.js";

afterEach(() => vi.useRealTimers());

describe("contracts and dispatch", () => {
  it("sends schema inputs and invokes the receiver's transform exactly once", async () => {
    const validate = vi.fn((value: unknown) =>
      typeof value === "string"
        ? { value: new Date(value) }
        : { issues: [{ message: "Expected date string" }] },
    );
    const messages = defineMessages({ date: schema<string, Date>(validate) });
    const received: Date[] = [];
    const receiver = createBridge({ receive: messages, transport: { send() {} } });
    receiver.on("date", (value) => {
      received.push(value);
    });
    const raws: string[] = [];
    const sender = createBridge<Record<never, never>, typeof messages>({
      receive: {},
      transport: {
        send(raw) {
          raws.push(raw);
        },
      },
    });
    expect(await sender.send("date", "2026-01-01T00:00:00.000Z")).toEqual({
      ok: true,
      value: undefined,
    });
    expect(validate).not.toHaveBeenCalled();
    expect(await receiver.receive(raws[0])).toEqual({ ok: true, value: undefined });
    expect(validate).toHaveBeenCalledTimes(1);
    expect(received).toEqual([new Date("2026-01-01T00:00:00.000Z")]);
    sender.dispose();
    receiver.dispose();
  });

  it("keeps control metadata out of strict payload schemas", async () => {
    const validate = vi.fn((value: unknown) => {
      expect(Object.keys(value as object)).toEqual(["token"]);
      expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
      return { value };
    });
    const bridge = createBridge({
      receive: { login: schema(validate) },
      transport: { send() {} },
    });
    expect((await bridge.receive(wire("login", { token: "secret" }))).ok).toBe(true);
    bridge.dispose();
  });

  it("preserves standard issues and distinguishes exceptions from invalid inputs", async () => {
    const issues = [{ message: "invalid", path: ["items", { key: 2 }, Symbol("field")] }];
    const cause = new Error("bug");
    const errors = vi.fn();
    const bridge = createBridge({
      receive: {
        invalid: schema(() => ({ issues })),
        empty: schema(() => ({ issues: [] })),
        throws: schema(() => {
          throw cause;
        }),
        rejects: schema(async () => {
          throw cause;
        }),
        valid: unknownSchema,
      },
      transport: { send() {} },
      onError: errors,
    });
    const handler = vi.fn();
    bridge.on("invalid", handler);
    expect(await bridge.receive(wire("invalid", null))).toMatchObject({
      ok: false,
      error: { code: "validation_failed", issues },
    });
    expect(await bridge.receive(wire("empty", null))).toMatchObject({
      ok: false,
      error: { code: "validation_failed", issues: [] },
    });
    for (const name of ["throws", "rejects"]) {
      expect(await bridge.receive(wire(name, null))).toMatchObject({
        ok: false,
        error: { code: "schema_failed", cause },
      });
    }
    bridge.on("valid", () => {
      throw cause;
    });
    expect(await bridge.receive(wire("valid", null))).toMatchObject({
      ok: false,
      error: { code: "handler_failed", cause },
    });
    expect(errors).toHaveBeenCalledTimes(5);
    expect(handler).not.toHaveBeenCalled();
    bridge.dispose();
  });

  it("accepts callable schemas and preserves the validator receiver", async () => {
    const standard = {
      version: 1 as const,
      vendor: "callable",
      validate(value: unknown) {
        expect(this).toBe(standard);
        return { value };
      },
    };
    const callable = Object.assign(() => {}, { "~standard": standard });
    const bridge = createBridge({
      receive: defineMessages({ callable }),
      transport: { send() {} },
    });
    expect((await bridge.receive(wire("callable", 1))).ok).toBe(true);
    bridge.dispose();
  });

  it("fails fast on unsupported schemas and invalid configuration", () => {
    for (const value of [
      null,
      {},
      { "~standard": { version: 2, vendor: "future", validate() {} } },
    ]) {
      expect(() => defineMessages({ value: value as StandardSchemaV1 })).toThrow(
        TypeError,
      );
    }
    expect(() => defineMessages({ "": unknownSchema })).toThrow(TypeError);
    expect(() => defineMessages({ [Symbol()]: unknownSchema })).toThrow(TypeError);
    for (const limits of [
      { maxDepth: 257 },
      { maxPendingMessages: 0 },
      { processingTimeoutMs: Infinity },
      { processingTimeoutMs: 2 ** 31 },
      { maxMessageLength: -1 },
    ]) {
      expect(() =>
        createBridge({ receive: {}, transport: { send() {} }, limits }),
      ).toThrow(TypeError);
    }
    expect(() =>
      createBridge({ receive: {}, transport: { send() {} }, channel: "" }),
    ).toThrow(TypeError);
    for (const invalid of [
      { channel: null },
      { onError: "not a function" },
      { transport: { send() {}, subscribe: false } },
    ]) {
      expect(() =>
        Reflect.apply(createBridge, undefined, [
          { receive: {}, transport: { send() {} }, ...invalid },
        ]),
      ).toThrow(TypeError);
    }
  });

  it("snapshots the registry and safely handles prototype property names", async () => {
    const messages = { known: stringSchema, ["__proto__"]: stringSchema };
    const bridge = createBridge({ receive: messages, transport: { send() {} } });
    messages.known = schema(() => ({ issues: [] }));
    const received = vi.fn();
    bridge.on("__proto__", received);
    expect((await bridge.receive(wire("known", "ok"))).ok).toBe(true);
    expect((await bridge.receive(wire("__proto__", "ok"))).ok).toBe(true);
    expect(received).toHaveBeenCalledWith("ok");
    expect(await bridge.receive(wire("constructor", null))).toMatchObject({
      ok: false,
      error: { code: "unknown_message" },
    });
    bridge.dispose();
  });

  it("isolates channels and rejects malformed protocol envelopes", async () => {
    const bridge = createBridge({
      receive: { value: unknownSchema },
      transport: { send() {} },
      channel: "one",
    });
    const handler = vi.fn();
    bridge.on("value", handler);
    expect((await bridge.receive(wire("value", 1, "two"))).ok).toBe(true);
    expect(handler).not.toHaveBeenCalled();
    for (const data of [
      null,
      [],
      1,
      {},
      { version: 2, channel: "one", type: "value", payload: 1 },
      { version: 1, channel: "one", type: "value" },
      { version: 1, channel: "one", type: "value", payload: 1, extra: true },
    ]) {
      expect(await bridge.receive(JSON.stringify(data))).toMatchObject({
        ok: false,
        error: { code: "invalid_envelope" },
      });
    }
    for (const raw of ["{", "1e400", undefined, { data: "not a string" }]) {
      expect(await bridge.receive(raw)).toMatchObject({
        ok: false,
        error: { code: "invalid_json" },
      });
    }
    bridge.dispose();
  });

  it("does not let stale unsubscribe callbacks delete newer subscriptions", async () => {
    const bridge = createBridge({
      receive: { value: unknownSchema },
      transport: { send() {} },
    });
    const old = vi.fn();
    const off = bridge.on("value", old);
    off();
    const current = vi.fn();
    bridge.on("value", current);
    off();
    await bridge.receive(wire("value", 1));
    expect(old).not.toHaveBeenCalled();
    expect(current).toHaveBeenCalledOnce();
    bridge.dispose();
  });
});

describe("queues and lifecycle", () => {
  it("preserves asynchronous validation and handler order", async () => {
    const gate = deferred<void>();
    const order: string[] = [];
    const bridge = createBridge({
      receive: {
        value: schema<string>(async (value) => {
          if (value === "first") await gate.promise;
          return { value: String(value) };
        }),
      },
      transport: { send() {} },
    });
    bridge.on("value", async (value) => {
      order.push(value);
      await Promise.resolve();
    });
    const first = bridge.receive(wire("value", "first"));
    const second = bridge.receive(wire("value", "second"));
    await Promise.resolve();
    expect(order).toEqual([]);
    gate.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(["first", "second"]);
    bridge.dispose();
  });

  it("uses independent directions so a receiving handler can await a send", async () => {
    const sent = vi.fn();
    const messages = { value: stringSchema };
    const bridge = createBridge<typeof messages, typeof messages>({
      receive: messages,
      transport: { send: sent },
    });
    bridge.on("value", async (value) => {
      expect((await bridge.send("value", value)).ok).toBe(true);
    });
    expect((await bridge.receive(wire("value", "response"))).ok).toBe(true);
    expect(sent).toHaveBeenCalledOnce();
    bridge.dispose();
  });

  it("snapshots queued sends and preserves transport call order", async () => {
    const gate = deferred<void>();
    const sent: string[] = [];
    const messages = { value: unknownSchema };
    const bridge = createBridge<typeof messages, typeof messages>({
      receive: messages,
      transport: {
        async send(raw) {
          sent.push(raw);
          if (sent.length === 1) await gate.promise;
        },
      },
    });
    const first = bridge.send("value", "first");
    const input = { name: "before" };
    const second = bridge.send("value", input);
    input.name = "after";
    await Promise.resolve();
    expect(sent).toHaveLength(1);
    gate.resolve();
    await Promise.all([first, second]);
    expect(JSON.parse(sent[1] ?? "").payload).toEqual({ name: "before" });
    bridge.dispose();
  });

  it("bounds queue capacity, recovers from a timeout, and ignores late schema results", async () => {
    vi.useFakeTimers();
    const gate = deferred<StandardSchemaV1.Result<string>>();
    const validate = vi.fn((value: unknown) =>
      value === "slow" ? gate.promise : { value: String(value) },
    );
    const bridge = createBridge({
      receive: { value: schema<string>(validate) },
      transport: { send() {} },
      limits: { maxPendingMessages: 2, processingTimeoutMs: 20 },
    });
    const handler = vi.fn();
    bridge.on("value", handler);
    const first = bridge.receive(wire("value", "slow"));
    const second = bridge.receive(wire("value", "next"));
    expect(await bridge.receive(wire("value", "overflow"))).toMatchObject({
      ok: false,
      error: { code: "queue_full" },
    });
    await vi.advanceTimersByTimeAsync(20);
    expect(await first).toMatchObject({ ok: false, error: { code: "timeout" } });
    expect((await second).ok).toBe(true);
    gate.resolve({ value: "late" });
    await Promise.resolve();
    await Promise.resolve();
    expect(handler.mock.calls).toEqual([["next"]]);
    bridge.dispose();
  });

  it("settles active and queued work on dispose and releases transport subscriptions once", async () => {
    const gate = deferred<StandardSchemaV1.Result<unknown>>();
    const unsubscribe = vi.fn();
    let push: ((raw: unknown) => void) | undefined;
    const bridge = createBridge({
      receive: { value: schema(() => gate.promise) },
      transport: {
        send() {},
        subscribe(receive) {
          push = receive;
          return unsubscribe;
        },
      },
    });
    const handler = vi.fn();
    bridge.on("value", handler);
    const first = bridge.receive(wire("value", 1));
    const second = bridge.receive(wire("value", 2));
    await Promise.resolve();
    bridge.dispose();
    bridge.dispose();
    for (const result of await Promise.all([first, second]))
      expect(result).toMatchObject({ ok: false, error: { code: "disposed" } });
    gate.resolve({ value: "late" });
    push?.(wire("value", 3));
    await Promise.resolve();
    await Promise.resolve();
    expect(handler).not.toHaveBeenCalled();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(() => bridge.on("value", handler)).toThrow("disposed");
  });

  it("does not start queued work disposed before its first microtask", async () => {
    const validate = vi.fn(() => ({ value: null }));
    const send = vi.fn();
    const messages = { value: schema(validate) };
    const bridge = createBridge<typeof messages, typeof messages>({
      receive: messages,
      transport: { send },
    });
    const receive = bridge.receive(wire("value", null));
    const sent = bridge.send("value", null);
    bridge.dispose();
    await Promise.all([receive, sent]);
    expect(validate).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("isolates failing error observers and continues after handler failures", async () => {
    const bridge = createBridge({
      receive: { value: stringSchema },
      transport: { send() {} },
      onError: async () => {
        throw new Error("observer");
      },
    });
    const handler = vi.fn((value: string) => {
      if (value === "bad") throw new Error("handler");
    });
    bridge.on("value", handler);
    expect(await bridge.receive(wire("value", "bad"))).toMatchObject({
      ok: false,
      error: { code: "handler_failed" },
    });
    expect((await bridge.receive(wire("value", "good"))).ok).toBe(true);
    bridge.dispose();
  });

  it("distinguishes unavailable transports and thrown/rejected sends", async () => {
    const messages = { value: stringSchema };
    const cause = new Error("transport");
    for (const send of [
      () => {
        throw cause;
      },
      async () => {
        throw cause;
      },
    ]) {
      const bridge = createBridge<typeof messages, typeof messages>({
        receive: messages,
        transport: { send },
      });
      expect(await bridge.send("value", "x")).toMatchObject({
        ok: false,
        error: { code: "transport_failed", cause },
      });
      bridge.dispose();
    }
    const bridge = createBridge<typeof messages, typeof messages>({
      receive: messages,
      transport: { send: () => false },
    });
    expect(await bridge.send("value", "x")).toMatchObject({
      ok: false,
      error: { code: "transport_unavailable" },
    });
    bridge.dispose();
    expect(await bridge.send("value", "x")).toMatchObject({
      ok: false,
      error: { code: "disposed" },
    });
  });
});

describe("JSON boundary", () => {
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- Keep this fixture local to the JSON boundary suite.
  const makeBridge = () =>
    createBridge<{ value: typeof unknownSchema }, { value: typeof unknownSchema }>({
      receive: { value: unknownSchema },
      transport: { send() {} },
    });
  const sendUntyped = (bridge: ReturnType<typeof makeBridge>, value: unknown) =>
    Reflect.apply(bridge.send, bridge, ["value", value]) as Promise<Result<void>>;

  it.each([
    undefined,
    NaN,
    Infinity,
    -Infinity,
    -0,
    1n,
    Symbol("x"),
    () => {},
    new Date(),
    new Map(),
    new Set(),
    new Uint8Array([1]),
    [undefined],
    [NaN],
    { a: undefined },
    Array(1),
    Object.assign([], { extra: 1 }),
    { [Symbol("key")]: 1 },
    Object.defineProperty({}, "hidden", { value: 1 }),
  ])("rejects non-JSON input %s at runtime", async (input) => {
    const bridge = makeBridge();
    expect(await sendUntyped(bridge, input)).toMatchObject({
      ok: false,
      error: { code: "serialization_failed" },
    });
    bridge.dispose();
  });

  it("never calls getters/toJSON and rejects cycles without rejecting shared references", async () => {
    const bridge = makeBridge();
    const getter = vi.fn();
    const toJSON = vi.fn();
    const accessor = Object.defineProperty({}, "a", { enumerable: true, get: getter });
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    for (const value of [accessor, { toJSON }, cycle]) {
      expect((await sendUntyped(bridge, value)).ok).toBe(false);
    }
    expect(getter).not.toHaveBeenCalled();
    expect(toJSON).not.toHaveBeenCalled();
    const shared = { value: 1 };
    expect((await bridge.send("value", { a: shared, b: shared })).ok).toBe(true);
    bridge.dispose();
  });

  it("rejects prototype pollution keys before downstream handlers can merge them", async () => {
    const received = vi.fn();
    const messages = { value: unknownSchema };
    let raw = "";
    const bridge = createBridge<typeof messages, typeof messages>({
      receive: messages,
      transport: {
        send(value) {
          raw = value;
        },
      },
    });
    bridge.on("value", received);
    const input = JSON.parse('{"__proto__":{"polluted":true},"constructor":"data"}') as {
      [key: string]: string;
    };
    expect((await bridge.send("value", input)).ok).toBe(false);
    expect(raw).toBe("");
    expect((await bridge.receive(wire("value", input))).ok).toBe(false);
    expect(received).not.toHaveBeenCalled();
    expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
    bridge.dispose();
  });

  it("enforces equal send/receive depth and length limits", async () => {
    const messages = { value: unknownSchema };
    const bridge = createBridge<typeof messages, typeof messages>({
      receive: messages,
      transport: { send() {} },
      limits: { maxDepth: 2, maxMessageLength: 120 },
    });
    expect((await bridge.send("value", { a: 1 })).ok).toBe(true);
    expect((await bridge.receive(wire("value", { a: 1 }))).ok).toBe(true);
    expect(await bridge.send("value", { a: { b: 1 } })).toMatchObject({
      ok: false,
      error: { code: "serialization_failed" },
    });
    expect(await bridge.receive(wire("value", { a: { b: 1 } }))).toMatchObject({
      ok: false,
      error: { code: "invalid_json" },
    });
    expect((await bridge.send("value", "x".repeat(120))).ok).toBe(false);
    expect((await bridge.receive(wire("value", "x".repeat(120)))).ok).toBe(false);
    bridge.dispose();
  });
});
