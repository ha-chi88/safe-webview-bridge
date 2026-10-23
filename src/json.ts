import type { BridgeLimits, JsonValue } from "./types.js";

/** Snapshot data without invoking getters, toJSON, or prototype setters. */
export function snapshotJson(input: unknown, limits: BridgeLimits): JsonValue {
  const ancestors = new Set<object>();
  let nodes = 0;
  let length = 0;
  const consume = (amount: number) => {
    length += amount;
    if (length > limits.maxMessageLength)
      throw new TypeError("JSON exceeds maxMessageLength");
  };
  const stringLength = (value: string) => {
    // Bound the allocation performed by JSON.stringify even for an enormous input string.
    if (value.length > limits.maxMessageLength - length)
      throw new TypeError("JSON exceeds maxMessageLength");
    consume(JSON.stringify(value).length);
  };

  const visit = (value: unknown, depth: number): JsonValue => {
    if (++nodes > limits.maxJsonNodes) throw new TypeError("JSON exceeds maxJsonNodes");
    if (depth > limits.maxDepth) throw new TypeError("JSON nesting exceeds maxDepth");
    if (typeof value === "string") {
      stringLength(value);
      return value;
    }
    if (value === null || typeof value === "boolean") {
      consume(value === null || value ? 4 : 5);
      return value;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value) || Object.is(value, -0)) {
        throw new TypeError("JSON numbers must be finite and must not be negative zero");
      }
      consume(JSON.stringify(value).length);
      return value;
    }
    if (typeof value !== "object") throw new TypeError("Value is not JSON data");
    if (ancestors.has(value)) throw new TypeError("JSON data must not contain cycles");
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        if (value.length > limits.maxJsonNodes - nodes)
          throw new TypeError("JSON exceeds maxJsonNodes");
        consume(2 + Math.max(0, value.length - 1));
        const keys = Reflect.ownKeys(value);
        if (keys.length !== value.length + 1) {
          throw new TypeError(
            "JSON arrays must be dense and must not have extra properties",
          );
        }
        const output: JsonValue[] = [];
        for (let index = 0; index < value.length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          if (!descriptor?.enumerable || !("value" in descriptor)) {
            throw new TypeError(
              "JSON arrays must contain data properties at every index",
            );
          }
          output.push(visit(descriptor.value, depth + 1));
        }
        return output;
      }
      const prototype: unknown = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError("JSON objects must be plain objects");
      }
      const output: Record<string, JsonValue> = Object.create(null);
      const keys = Reflect.ownKeys(value);
      if (keys.length > limits.maxJsonNodes - nodes)
        throw new TypeError("JSON exceeds maxJsonNodes");
      consume(2 + Math.max(0, keys.length - 1));
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (
          typeof key !== "string" ||
          !descriptor?.enumerable ||
          !("value" in descriptor)
        ) {
          throw new TypeError(
            "JSON objects must contain enumerable string data properties",
          );
        }
        if (key === "__proto__" || key === "constructor" || key === "prototype")
          throw new TypeError("Reserved JSON object property");
        stringLength(key);
        consume(1);
        output[key] = visit(descriptor.value, depth + 1);
      }
      return output;
    } finally {
      ancestors.delete(value);
    }
  };

  return visit(input, 0);
}
