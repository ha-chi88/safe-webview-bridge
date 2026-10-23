import type { StandardSchemaV1 } from "@standard-schema/spec";

import type { MessageSchemas } from "./types.js";

export function collectSchemas(
  messages: MessageSchemas,
): Map<string, StandardSchemaV1.Props> {
  if (messages === null || typeof messages !== "object") {
    throw new TypeError("receive must be a record of Standard Schema v1 schemas");
  }
  const prototype: unknown = Object.getPrototypeOf(messages);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("receive must be a plain record of message schemas");
  }
  const schemas = new Map<string, StandardSchemaV1.Props>();
  for (const key of Reflect.ownKeys(messages)) {
    if (typeof key !== "string" || key.length === 0) {
      throw new TypeError("Message names must be non-empty strings");
    }
    const descriptor = Object.getOwnPropertyDescriptor(messages, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new TypeError("Message schemas must be enumerable data properties");
    }
    const schema: unknown = descriptor.value;
    const standard =
      schema !== null &&
      (typeof schema === "object" || typeof schema === "function") &&
      "~standard" in schema
        ? (schema as StandardSchemaV1)["~standard"]
        : undefined;
    if (
      standard?.version !== 1 ||
      typeof standard.vendor !== "string" ||
      typeof standard.validate !== "function"
    ) {
      throw new TypeError(
        `Message ${JSON.stringify(key)} must implement Standard Schema v1`,
      );
    }
    schemas.set(key, standard);
  }
  return schemas;
}

/** Check the contract and freeze its names; schemas retain their own native APIs. */
export function defineMessages<const Messages extends MessageSchemas>(
  messages: Messages,
): Readonly<Messages> {
  collectSchemas(messages);
  return Object.freeze({ ...messages });
}
