import { snapshotJson } from "./json.js";
import { createQueue } from "./queue.js";
import { createRateLimit } from "./rate-limit.js";
import { createErrorReporter } from "./report-error.js";
import { failure, success } from "./result.js";
import { collectSchemas } from "./schema.js";
import type {
  Bridge,
  BridgeError,
  BridgeLimits,
  BridgeOptions,
  JsonValue,
  MessageSchemas,
  Result,
} from "./types.js";

export const DEFAULT_LIMITS: Readonly<BridgeLimits> = Object.freeze({
  maxMessageLength: 65_536,
  maxDepth: 64,
  maxJsonNodes: 10_000,
  maxPendingMessages: 128,
  maxPendingMessageLength: 1_048_576,
  maxMessagesPerSecond: 100,
  processingTimeoutMs: 10_000,
});

function resolveLimits(options: Partial<BridgeLimits> | undefined): BridgeLimits {
  const limits = { ...DEFAULT_LIMITS, ...options };
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new TypeError(`${key} must be a positive safe integer`);
  }
  if (limits.maxDepth > 256) throw new TypeError("maxDepth must not exceed 256");
  if (limits.processingTimeoutMs > 2_147_483_647)
    throw new TypeError("processingTimeoutMs is too large");
  return limits;
}

export function createBridge<
  Incoming extends MessageSchemas,
  Outgoing extends MessageSchemas = Record<never, never>,
>(options: BridgeOptions<Incoming>): Bridge<Incoming, Outgoing> {
  const schemas = collectSchemas(options.receive);
  const limits = resolveLimits(options.limits);
  const channel = options.channel === undefined ? "safe-webview-bridge" : options.channel;
  if (typeof channel !== "string" || channel.length === 0)
    throw new TypeError("channel must be a non-empty string");
  const { transport, onError } = options;
  if (typeof transport?.send !== "function")
    throw new TypeError("transport.send must be a function");
  if (transport.subscribe !== undefined && typeof transport.subscribe !== "function")
    throw new TypeError("transport.subscribe must be a function");
  const sending = createQueue(limits);
  const receiving = createQueue(limits);
  const handlers = new Map<string, Set<(value: unknown) => void | Promise<void>>>();
  let disposed = false;
  let unsubscribe: (() => void) | undefined;
  const notify = createErrorReporter(onError);
  const admit = createRateLimit(limits.maxMessagesPerSecond);

  const receive = async (raw: unknown): Promise<Result<void>> => {
    if (disposed)
      return failure({
        code: "disposed",
        phase: "receive",
        message: "Bridge has been disposed",
      });
    if (!admit()) {
      const error: BridgeError = {
        code: "rate_limited",
        phase: "receive",
        message: "Incoming message rate exceeded maxMessagesPerSecond",
      };
      notify(error);
      return failure(error);
    }
    if (typeof raw !== "string" || raw.length > limits.maxMessageLength) {
      const error: BridgeError = {
        code: "invalid_json",
        phase: "receive",
        message: "Message must be a string within maxMessageLength",
      };
      notify(error);
      return failure(error);
    }
    const context: { phase: "receive"; messageType?: string } = { phase: "receive" };
    const result = await receiving.run(context, raw.length, async (isActive) => {
      let data: JsonValue;
      try {
        const parsed: unknown = JSON.parse(raw);
        snapshotJson(parsed, limits);
        // Preserve normal JSON.parse object prototypes for user-defined schemas.
        data = parsed as JsonValue;
      } catch {
        return failure({
          code: "invalid_json",
          phase: "receive",
          message: "Message is not supported JSON data",
        });
      }
      if (typeof data !== "object" || data === null || Array.isArray(data)) {
        return failure({
          code: "invalid_envelope",
          phase: "receive",
          message: "Message envelope must be an object",
        });
      }
      const envelope = data as { readonly [key: string]: JsonValue };
      if (typeof envelope.channel === "string" && envelope.channel !== channel)
        return success();
      const name = envelope.type;
      if (
        Object.keys(envelope).length !== 4 ||
        !["version", "channel", "type", "payload"].every((key) =>
          Object.hasOwn(envelope, key),
        ) ||
        envelope.version !== 1 ||
        envelope.channel !== channel ||
        typeof name !== "string" ||
        name.length === 0
      ) {
        return failure({
          code: "invalid_envelope",
          phase: "receive",
          message: "Invalid bridge protocol envelope",
        });
      }
      const schema = schemas.get(name);
      context.messageType = name;
      if (!schema)
        return failure({
          code: "unknown_message",
          phase: "receive",
          messageType: name,
          message: "Message name is not registered",
        });
      let value: unknown;
      try {
        const parsed = await schema.validate(envelope.payload);
        if (!isActive()) return success();
        if (parsed === null || typeof parsed !== "object")
          throw new TypeError("Invalid Standard Schema result");
        if (parsed.issues !== undefined) {
          if (!Array.isArray(parsed.issues))
            throw new TypeError("Invalid Standard Schema issues");
          return failure({
            code: "validation_failed",
            phase: "receive",
            messageType: name,
            message: "Payload failed schema validation",
            issues: parsed.issues,
          });
        }
        if (!("value" in parsed))
          throw new TypeError("Standard Schema result has no value");
        value = parsed.value;
      } catch (cause) {
        return failure({
          code: "schema_failed",
          phase: "receive",
          messageType: name,
          message: "Schema execution failed",
          cause,
        });
      }
      const listeners = handlers.get(name);
      // oxlint-disable-next-line unicorn/no-useless-spread -- Snapshot listeners so handlers added during delivery wait for the next message.
      for (const handler of [...(listeners ?? [])]) {
        if (!isActive()) break;
        if (!listeners?.has(handler)) continue;
        try {
          await handler(value);
        } catch (cause) {
          return failure({
            code: "handler_failed",
            phase: "receive",
            messageType: name,
            message: "Message handler failed",
            cause,
          });
        }
      }
      return success();
    });
    if (!result.ok && result.error.code !== "disposed") notify(result.error);
    return result;
  };

  const bridge: Bridge<Incoming, Outgoing> = {
    async send(...[name, payload]) {
      if (disposed)
        return failure({
          code: "disposed",
          phase: "send",
          message: "Bridge has been disposed",
        });
      let serialized: string;
      try {
        if (typeof name !== "string" || name.length === 0)
          throw new TypeError("Message name must be a non-empty string");
        // Snapshot before entering the queue; later caller mutations cannot change the wire value.
        serialized = JSON.stringify(
          snapshotJson({ version: 1, channel, type: name, payload }, limits),
        );
        if (serialized.length > limits.maxMessageLength)
          throw new TypeError("Message exceeds maxMessageLength");
      } catch (cause) {
        return failure({
          code: "serialization_failed",
          phase: "send",
          message: "Payload could not be serialized",
          cause,
        });
      }
      return sending.run(
        { phase: "send", messageType: name },
        serialized.length,
        async () => {
          try {
            const sent = await transport.send(serialized);
            return sent === false
              ? failure({
                  code: "transport_unavailable",
                  phase: "send",
                  messageType: name,
                  message: "Transport is unavailable",
                })
              : success();
          } catch (cause) {
            return failure({
              code: "transport_failed",
              phase: "send",
              messageType: name,
              message: "Transport send failed",
              cause,
            });
          }
        },
      );
    },
    on(name, handler) {
      if (disposed) throw new Error("Bridge has been disposed");
      if (!schemas.has(name)) throw new TypeError("Message name is not registered");
      if (typeof handler !== "function")
        throw new TypeError("Message handler must be a function");
      let listeners = handlers.get(name);
      if (!listeners) {
        listeners = new Set();
        handlers.set(name, listeners);
      }
      // Name and payload are tied by the public generic signature; storage erases only that pair.
      const listener = handler as (value: unknown) => void | Promise<void>;
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && handlers.get(name) === listeners)
          handlers.delete(name);
      };
    },
    receive,
    dispose() {
      if (disposed) return;
      disposed = true;
      sending.dispose();
      receiving.dispose();
      handlers.clear();
      try {
        unsubscribe?.();
      } catch (cause) {
        notify({
          code: "transport_failed",
          phase: "lifecycle",
          message: "Transport unsubscribe failed",
          cause,
        });
      }
    },
  };
  if (transport.subscribe) {
    try {
      unsubscribe = transport.subscribe((raw) => {
        void receive(raw);
      });
    } catch (cause) {
      bridge.dispose();
      throw cause;
    }
    if (typeof unsubscribe !== "function") {
      bridge.dispose();
      throw new TypeError("transport.subscribe must return an unsubscribe function");
    }
  }
  return bridge;
}
