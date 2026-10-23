# safe-webview-bridge

Typed, bidirectional messaging between a web page and React Native WebView. Accepts
[Standard Schema v1](https://standardschema.dev/schema) validators, including Zod,
Zod Mini, Valibot, ArkType, and Effect Schema.

Read the [security model and required WebView controls](SECURITY.md) before attaching
native capabilities. Validation is one part of the trust boundary.

- Infer outgoing **input** and incoming **output** types from schemas.
- Validate and transform once at the receiving boundary, including asynchronous schemas.
- Send strict JSON through a versioned envelope, with bounded queues and explicit errors.
- Import each platform separately. No runtime dependency on a schema vendor, React, or React Native.
- Keep outgoing schemas out of the sender's bundle using type-only contracts.

## Install

```sh
pnpm add safe-webview-bridge
# Add the schema library you use, for example:
pnpm add valibot
```

This package ships ESM and TypeScript declarations. Its only production dependency,
`@standard-schema/spec`, is imported exclusively as types. Use modern ES2022-capable
runtimes and a TypeScript compiler supporting `NoInfer` (TypeScript 5.4+).
The verification suite uses TypeScript 7 and React Native WebView 14.

## Define a directional contract

Each key is a message name; its schema describes that message's **payload**.
Keep the two directions in separate modules so each endpoint imports only its incoming validators.
Schemas from different vendors can also coexist within a single message map.
For a message without data, use a null schema and send `null` as its payload.

```ts
// messages/to-native.ts
import { defineMessages } from "safe-webview-bridge";
import * as v from "valibot";

export const toNative = defineMessages({
  greet: v.object({ name: v.pipe(v.string(), v.maxLength(100)) }),
});
```

```ts
// messages/to-web.ts
import { defineMessages } from "safe-webview-bridge";
import * as v from "valibot";

export const toWeb = defineMessages({
  greeting: v.string(),
});
```

```ts
// messages/contract.ts — no runtime imports
import type { toNative } from "./to-native.js";
import type { toWeb } from "./to-web.js";

export type AppBridge = {
  toNative: typeof toNative;
  toWeb: typeof toWeb;
};
```

`defineMessages` preserves concrete schema types and freezes a shallow copy of the map.
It checks Standard Schema compatibility without inspecting vendor-specific internals.
Plain schema maps are also accepted by the bridge factories and checked at creation.

## Web

```ts
import { createWebBridge } from "safe-webview-bridge/web";

import type { AppBridge } from "./messages/contract.js";
import { toWeb } from "./messages/to-web.js";

const bridge = createWebBridge<AppBridge>({
  receive: toWeb,
  onError: (error) => console.error(error.code, error.message),
});

const unsubscribe = bridge.on("greeting", (greeting) => {
  console.log(greeting); // string
});

const result = await bridge.send("greet", { name: "Ada" });
if (!result.ok) {
  // Includes transport_unavailable when outside React Native WebView.
  console.error(result.error.code);
}

// At the end of this page/session's lifetime:
unsubscribe();
bridge.dispose();
```

Web sends use the public `window.ReactNativeWebView.postMessage` API. Incoming
messages are received on `window` (iOS) and `document` (Android). A single event
that bubbles through both is processed once. Repeated distinct events are distinct messages.
The listener accepts only the native dispatch shape (`origin === ""`, `source === null`).
Ordinary browser `postMessage` events, including iframe messages, are ignored. Scripts
already running in the main document remain trusted; this is not protection against XSS.

Importing the module is SSR-safe. Construct the instance in the mounted browser
page: an instance created without a window does not attach listeners later.
`getWindow` optionally supplies a structural window target for embedding or testing.

## React Native

Attach `onMessage` to the WebView; React Native WebView injects its web-side messaging
API only when this prop is present. Both `allowedOrigins` and `getCurrentUrl` are
required. The latter reads host-owned navigation state and returns null while no
document is trusted. The `currentUrl` and `webView` refs below are managed by the host:

```ts
import { createNativeBridge } from "safe-webview-bridge/react-native";

import type { AppBridge } from "./messages/contract.js";
import { toNative } from "./messages/to-native.js";

const bridge = createNativeBridge<AppBridge>({
  receive: toNative,
  allowedOrigins: ["https://your-app.example"],
  getCurrentUrl: () => currentUrl.current,
  getWebView: () => webView.current,
  onError: (error) => console.warn("bridge", error.code),
});

bridge.on("greet", async ({ name }) => {
  const result = await bridge.send("greeting", `Hello, ${name}!`);
  if (!result.ok) console.warn("bridge", result.error.code);
});
```

Use the complete, type-checked [React Native example](examples/SecureWebView.tsx) for
navigation restrictions, document replacement/disposal, errors, process termination,
Strict Mode cleanup, and WebView settings. Its CSP requirements are in [SECURITY.md](SECURITY.md).

`createOriginPolicy(allowedOrigins)` returns an exact-origin predicate that can also
be used by the host. Origins must be canonical HTTPS origins without a trailing slash,
path, credentials, or wildcard. Explicit HTTP loopback origins are supported for local
development. The policy snapshots its allowlist. Native event URLs are checked before
their payloads are parsed; missing or disallowed URLs return `untrusted_origin`.
Document URLs must use HTTP(S); `blob:` URLs are rejected even when their embedded
origin is allowed.

`getWebView` and `getCurrentUrl` are read for every send. The handle is structurally
`{ postMessage(message: string): void }`; the adapter imports neither React nor React
Native WebView. A detached handle or untrusted/inactive current document produces
`transport_unavailable`. Native exposes `onMessage(event): Promise<Result<void>>` instead
of raw `receive`, so callers cannot accidentally bypass its URL checks.

Use one bridge per document/session. Dispose and recreate on every document navigation
or reload, even to the same URL. URL metadata does not reliably identify subframes on
every Android WebView path; never attach privileged bridges to untrusted content or frames.

## Schema interoperability

| Library          | Pass as a message's schema                                          |
| ---------------- | ------------------------------------------------------------------- |
| Zod 4            | `z.object({ name: z.string() })`                                    |
| Zod Mini         | `z.object({ name: z.string() })` from `zod/mini`                    |
| Valibot 1        | `v.object({ name: v.string() })`                                    |
| ArkType 2        | `type({ name: "string" })`                                          |
| Effect 4         | `Schema.toStandardSchemaV1(Schema.Struct({ name: Schema.String }))` |
| Other validators | Any `StandardSchemaV1<Input, Output>` implementation                |

No `safe-webview-bridge/zod`, `/valibot`, or other vendor adapter is required.
Effect's official adapter requires `DecodingServices` to be `never`; provide any
required services in the application before adapting. The bridge does not create
or own an Effect runtime. See [Effect's integration guide](https://effect.website/docs/v4/schema/standard-schema).

Schema-specific options belong to the schema/provider configuration. Payload handling
of extra properties, defaults, coercion, brands, and refinements follows the supplied
schema. The bridge does not impose a shared strict-object policy on payloads.

### Input, wire value, and output

```text
send(name, JsonInput<InferInput<Schema>>)
  → strict JSON snapshot → transport → JSON/envelope checks
  → await schema["~standard"].validate(payload)
  → handler(InferOutput<Schema>)
```

For a `string → Date` schema, send a string and receive a `Date`. The output does not
need to be JSON data. The bridge calls the receiver's validator once per message,
regardless of the number of handlers; schema internals may perform their own work.

**Sending does not execute the recipient's validator.** Static input types do not
prove refinements such as positive numbers or valid dates; these are checked on receipt.
Defaults, stripping, and sanitization are also receiver operations: the original JSON
input is what crosses the boundary. Perform any required sender-side sanitization
explicitly before calling `send`.

Standard Schema does not specify an encoder. To send a rich value, encode it to the
schema's JSON input explicitly (for example with a Zod Codec or Effect encoder).
Non-JSON input schemas such as `z.date()` cannot be used directly as outgoing JSON
contracts. Use a JSON-input decoder such as a string-to-date schema instead.

Standard JSON Schema is a separate schema-export specification. A JSON Schema
document or an object implementing only `StandardJSONSchemaV1` is not a validator
and is not accepted here.

## Strict JSON and protocol

Supported wire values are null, booleans, strings, finite numbers other than `-0`,
dense arrays, and plain objects with enumerable string data properties. Omitted
optional object keys are supported. Explicit `undefined`, `NaN`, infinity, negative
zero, bigint, symbols, functions, accessors, hidden properties, sparse arrays,
array properties, Date/Map/Set/class instances, and cycles are rejected. Shared
non-circular references are permitted and transferred as duplicated JSON values.
Input getters and `toJSON` methods are not invoked to produce a wire value.
Object keys `__proto__`, `constructor`, and `prototype` are reserved at every depth
and rejected in both directions before any schema runs. Length and node budgets are
enforced during traversal, including expansion of shared references.

The typed `JsonInput` projection excludes statically known non-JSON values and
preserves optional keys, tuples, unions, and primitive brands. Runtime checks remain
necessary for `any`, numeric limits, reserved keys, cycles, and JavaScript callers.

Every message has exactly four own properties:

```json
{
  "version": 1,
  "channel": "safe-webview-bridge",
  "type": "greet",
  "payload": { "name": "Ada" }
}
```

Set the same `channel` option on both endpoints to isolate multiple bridges. Valid
JSON envelopes carrying a different string channel are ignored. Messages on the
selected channel must have protocol version 1 and a registered incoming name.
The channel is public routing metadata and does not authenticate a sender.
Transport metadata is never inserted into the user payload. Neither validators,
callbacks, nor exception objects are transferred across the bridge.

## Delivery, errors, and lifecycle

`send`, core/Web `receive`, and Native `onMessage` resolve to `{ ok: true, value: undefined }` or
`{ ok: false, error: BridgeError }`. Invalid configuration and invalid `on` registrations
throw immediately. All message payloads from the transport are treated as untrusted.

| Error code              | Meaning                                                                        |
| ----------------------- | ------------------------------------------------------------------------------ |
| `serialization_failed`  | Outgoing data cannot be represented by the JSON protocol or exceeds its limits |
| `invalid_json`          | Incoming data is not a supported JSON string or exceeds its limits             |
| `invalid_envelope`      | Incorrect envelope shape or protocol version                                   |
| `unknown_message`       | Incoming message name is not registered                                        |
| `validation_failed`     | Standard Schema returned `issues`, preserved with their original paths         |
| `schema_failed`         | Validator threw, rejected, or returned a malformed result                      |
| `handler_failed`        | A handler threw or rejected                                                    |
| `transport_unavailable` | The transport reported that its endpoint is absent                             |
| `transport_failed`      | Sending or transport cleanup threw/rejected                                    |
| `queue_full`            | Outstanding operations reached the queue limit                                 |
| `rate_limited`          | Incoming messages exceeded the configured token bucket                         |
| `untrusted_origin`      | Native event URL or current host document is missing or disallowed             |
| `timeout`               | An active operation exceeded its processing deadline                           |
| `disposed`              | The instance has been disposed                                                 |

Errors include `phase`, `message`, and, when known, `messageType`. Validation errors
carry `issues`; other failures may carry a local `cause`. A provider can convert
its own internal failures into issues (Effect does this for defects); the bridge
cannot recover information absent from the Standard Schema result.
JSON parser causes are deliberately omitted to avoid leaking excerpts of invalid input.

`onError` observes receive and lifecycle failures, including failures arriving through
platform event listeners. Send errors are returned to the caller. Disposal is an
expected lifecycle result and is not reported to `onError`. Observer exceptions and
rejected promises are isolated; they do not change operation results or stop delivery.
Notifications use a 10-per-second token bucket, with at most one pending async observer.
Excess notifications are dropped, while operation Results remain available to callers.
The library does not log payloads or errors automatically.

- A successful `send` means the transport accepted the serialized string. It does
  **not** acknowledge remote validation, receipt, or handler completion. There is no
  implicit RPC, acknowledgement, retry, or readiness buffer.
- Messages are processed FIFO per direction. Send and receive queues are independent,
  so a receive handler may await a send. Awaiting a nested `receive` on the same
  bridge would wait behind the current handler and must be avoided.
- Handlers run sequentially in registration order. A failing handler aborts the
  remainder of that message's handlers; subsequent messages still run. Registering
  the same handler function for the same message is idempotent. `on` returns an
  idempotent unsubscribe function.
- `dispose` detaches listeners and promptly settles active and queued operations as
  disposed. Queued work is not started, and late validator results are not delivered.
- Timeout/disposal cannot cancel an already-running validator, handler, or transport
  send: Standard Schema has no common cancellation API. Such application work may
  still finish or have side effects. Further handlers for that operation are skipped.
  Unsettled timed-out work continues to occupy queue count/length capacity until it settles.
- Schemas validate data shape; applications own navigation/origin trust and authorization.

### Resource limits

Pass a partial `limits` object to any factory:

| Option                    |   Default | Meaning                                                                                                      |
| ------------------------- | --------: | ------------------------------------------------------------------------------------------------------------ |
| `maxMessageLength`        |    65,536 | Serialized UTF-16 code units, including the envelope                                                         |
| `maxDepth`                |        64 | Maximum JSON nesting depth; envelope root is depth 0, maximum configurable value 256                         |
| `maxJsonNodes`            |    10,000 | Values visited per envelope, counting every occurrence of shared references                                  |
| `maxPendingMessages`      |       128 | Outstanding operations per direction, including unsettled work after timeout                                 |
| `maxPendingMessageLength` | 1,048,576 | Aggregate serialized input length retained per direction, including unsettled work after timeout             |
| `maxMessagesPerSecond`    |       100 | Incoming token bucket refill rate and burst capacity; malformed input also consumes tokens                   |
| `processingTimeoutMs`     |    10,000 | Deadline starting when an operation becomes active, including async validation/handlers or transport sending |

Limits must be positive safe integers. `processingTimeoutMs` is at most 2,147,483,647.
Timers cannot preempt synchronous JavaScript. Timeout/disposal suppresses late delivery
and allows the next operation to proceed; it does not imply transport cancellation.
Capacity remains reserved for timed-out work. These bounds do not constrain arbitrary
allocations or side effects inside application validators/handlers.

## Custom transports

```ts
import { createBridge, type Transport } from "safe-webview-bridge";

const transport: Transport = {
  send(serialized) {
    // Forward the string; return false when the endpoint is unavailable.
  },
  subscribe(receive) {
    // Feed untrusted incoming strings to receive.
    return () => {
      /* detach the transport listener */
    };
  },
};

const bridge = createBridge<typeof incoming, typeof outgoing>({
  receive: incoming,
  transport,
});
```

`subscribe` is optional: a host can call `bridge.receive(raw)` itself and inspect its
result. `send` may return a promise. No outgoing schemas are required at runtime;
omitting the outgoing generic creates a receive-only typed bridge.

## Package surface

| Import                             | Exports                                                          |
| ---------------------------------- | ---------------------------------------------------------------- |
| `safe-webview-bridge`              | `createBridge`, `defineMessages`, `DEFAULT_LIMITS`, shared types |
| `safe-webview-bridge/web`          | `createWebBridge`, web adapter types                             |
| `safe-webview-bridge/react-native` | `createNativeBridge`, `createOriginPolicy`, native adapter types |

The root does not re-export platform adapters. All entrypoints are free of import-time
side effects and platform globals in their public types. The `exports` map, ESM output,
and `sideEffects: false` allow bundlers to retain only the used surface.

## Development and verification

```sh
corepack pnpm install
corepack pnpm check
corepack pnpm test:browser
corepack pnpm audit:production
```

`check` runs Oxlint, Oxfmt's formatting check, compile-time API assertions, runtime interoperability/queue/protocol
tests, compilation, and an isolated tarball consumer. The package test verifies public
declarations without DOM/React types, import safety without a browser, production
dependencies, a 6 KiB gzip budget for each bridge entrypoint, and executable Metro
bundles for both iOS and Android. Vendor fixtures measure schema-only bundles against
schema-plus-bridge bundles; results are written to `.artifacts/bundle-sizes.json`.

Run `pnpm format` to apply formatting and import sorting, or `pnpm format:check`
to verify formatting without writing files. `pnpm lint` runs the configured correctness
and suspicious rules as errors and fails on warnings. The Oxc configuration files exclude
dependencies, build output, test reports, and generated artifacts.
React's automatic JSX runtime needs no `React` binding. The package smoke test also
allows its two VM globals; intentional WebView transport and lifecycle exceptions are
documented at the affected lines.

The browser suite uses local Chrome, or Playwright Chromium when `CI` is set. In CI,
install it with `pnpm exec playwright install --with-deps chromium`. It exercises real
DOM message events at both platform dispatch locations and the bubbling case, including
async validation, Unicode/quotes, bidirectional delivery, disposal, and attempted iframe
message forgeries from same, different, and opaque origins. These fixtures
model React Native WebView's event dispatch; they are not device/emulator tests.

## License

MIT
