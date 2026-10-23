import type { StandardSchemaV1 } from "@standard-schema/spec";

export type MessageSchemas = Readonly<Record<string, StandardSchemaV1>>;

export interface BridgeContract {
  readonly toNative: MessageSchemas;
  readonly toWeb: MessageSchemas;
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/** Preserve schema input types, including optional keys, while excluding non-JSON values. */
export type JsonInput<T> = unknown extends T
  ? JsonValue
  : T extends JsonPrimitive
    ? T
    : T extends readonly unknown[]
      ? { readonly [K in keyof T]: JsonInput<T[K]> }
      : T extends (...args: never[]) => unknown
        ? never
        : T extends object
          ? { [K in keyof T]: K extends string | number ? JsonInput<T[K]> : never }
          : never;

export type BridgeErrorCode =
  | "invalid_json"
  | "invalid_envelope"
  | "unknown_message"
  | "validation_failed"
  | "schema_failed"
  | "handler_failed"
  | "serialization_failed"
  | "transport_unavailable"
  | "transport_failed"
  | "timeout"
  | "queue_full"
  | "rate_limited"
  | "untrusted_origin"
  | "disposed";

export type BridgeError = {
  readonly phase: "send" | "receive" | "lifecycle";
  readonly message: string;
  readonly messageType?: string;
} & (
  | {
      readonly code: "validation_failed";
      readonly issues: readonly StandardSchemaV1.Issue[];
    }
  | {
      readonly code: Exclude<BridgeErrorCode, "validation_failed">;
      readonly cause?: unknown;
    }
);

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: BridgeError };

export interface BridgeLimits {
  /** Maximum serialized message length in UTF-16 code units, including its envelope. */
  readonly maxMessageLength: number;
  /** Maximum nesting depth of the entire JSON envelope. */
  readonly maxDepth: number;
  /** Maximum values visited while inspecting one JSON envelope. */
  readonly maxJsonNodes: number;
  /** Maximum outstanding operations per direction, including timed-out work still running. */
  readonly maxPendingMessages: number;
  /** Aggregate serialized UTF-16 length retained per direction, including timed-out work. */
  readonly maxPendingMessageLength: number;
  /** Incoming token bucket refill rate and maximum burst size. Rejected input also counts. */
  readonly maxMessagesPerSecond: number;
  /** Time allowed for an operation once it reaches the head of its queue. */
  readonly processingTimeoutMs: number;
}

export interface Transport {
  /** Return false when unavailable. Resolution means handed off, not acknowledged. */
  // Accept Promise<void> transports without an unnecessary wrapper.
  send(message: string): void | false | Promise<void | false>;
  /** Optional for transports whose host forwards messages to bridge.receive itself. */
  subscribe?(receive: (message: unknown) => void): () => void;
}

export interface BridgeOptions<Incoming extends MessageSchemas> {
  readonly receive: Incoming;
  readonly transport: Transport;
  readonly channel?: string;
  readonly limits?: Partial<BridgeLimits>;
  /** Observes receive/lifecycle failures. Observer exceptions cannot break delivery. */
  readonly onError?: (error: BridgeError) => void | Promise<void>;
}

type SendArguments<Outgoing extends MessageSchemas> = {
  [Name in keyof Outgoing & string]: [
    name: Name,
    payload: JsonInput<StandardSchemaV1.InferInput<Outgoing[Name]>>,
  ];
}[keyof Outgoing & string];

export interface Bridge<
  Incoming extends MessageSchemas,
  Outgoing extends MessageSchemas,
> {
  send(...args: SendArguments<Outgoing>): Promise<Result<void>>;
  on<Name extends keyof Incoming & string>(
    name: Name,
    handler: (
      payload: StandardSchemaV1.InferOutput<Incoming[Name]>,
    ) => void | Promise<void>,
  ): () => void;
  /** Accept untrusted transport data. Other channels are ignored. */
  receive(message: unknown): Promise<Result<void>>;
  /** Detach listeners and settle active/queued work. Safe to call repeatedly. */
  dispose(): void;
}
