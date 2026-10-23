import { type } from "arktype";
import { Schema } from "effect";
import type { WebView, WebViewProps } from "react-native-webview";
import * as v from "valibot";
import { expectTypeOf } from "vitest";
import { z } from "zod";
import * as zm from "zod/mini";

import {
  createBridge,
  defineMessages,
  type JsonInput,
  type Result,
} from "../src/index.js";
import { createNativeBridge } from "../src/react-native.js";
import { createWebBridge } from "../src/web.js";

const toNative = defineMessages({
  transformed: z.string().transform((input) => input.length),
  optional: z.object({
    name: z.string().default("default"),
    extra: z.string().optional(),
  }),
  valibot: v.pipe(
    v.string(),
    v.transform((input) => input.length),
  ),
  arktype: type("string").pipe((input) => input.length),
  mini: zm.object({ name: zm.string() }),
  effect: Schema.toStandardSchemaV1(Schema.DateFromString),
  union: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("a"), value: z.string() }),
    z.object({ kind: z.literal("b"), value: z.number() }),
  ]),
  anything: z.unknown(),
  branded: z.string().brand<"Id">(),
  tuple: z.tuple([z.string(), z.number()]),
  dateInput: z.date(),
});
const toWeb = defineMessages({ response: v.object({ ok: v.boolean() }) });
type Contract = { toNative: typeof toNative; toWeb: typeof toWeb };

// Compile-only assertions. This function is deliberately never called.
function checkTypes(
  webView: WebView<unknown> | null,
  dynamicName: "transformed" | "mini",
  correlated: ["transformed", string] | ["mini", { name: string }],
) {
  const web = createWebBridge<Contract>({ receive: toWeb, getWindow: () => window });
  const native = createNativeBridge<Contract>({
    allowedOrigins: ["https://app.example"],
    getCurrentUrl: () => "https://app.example/page",
    receive: toNative,
    getWebView: () => webView,
  });
  const props: Pick<WebViewProps, "onMessage"> = { onMessage: native.onMessage };
  expectTypeOf(props.onMessage).not.toBeNever();
  // @ts-expect-error native messages must pass the metadata-aware onMessage boundary
  native.receive("untrusted raw input");
  expectTypeOf(web.send("transformed", "abc")).toEqualTypeOf<Promise<Result<void>>>();
  web.send("optional", {});
  web.send("valibot", "abc");
  web.send("arktype", "abc");
  web.send("mini", { name: "abc" });
  web.send("effect", "2026-01-01");
  web.send("union", { kind: "a", value: "text" });
  web.send("union", { kind: "b", value: 123 });
  web.send("anything", { nested: [null, true, 1, "x"] });
  web.send("tuple", ["x", 1]);
  web.send(...correlated);
  native.on("transformed", (value) => {
    expectTypeOf(value).toEqualTypeOf<number>();
  });
  native.on("valibot", (value) => {
    expectTypeOf(value).toEqualTypeOf<number>();
  });
  native.on("arktype", (value) => {
    expectTypeOf(value).toEqualTypeOf<number>();
  });
  native.on("effect", (value) => {
    expectTypeOf(value).toEqualTypeOf<Date>();
  });
  native.on("optional", (value) => {
    expectTypeOf(value.name).toEqualTypeOf<string>();
  });
  native.on("branded", (value) => {
    expectTypeOf(value).toEqualTypeOf<z.output<typeof toNative.branded>>();
  });
  web.on("response", (value) => {
    expectTypeOf(value.ok).toEqualTypeOf<boolean>();
  });
  // @ts-expect-error send accepts the schema's input, not its transformed output
  web.send("transformed", 123);
  // @ts-expect-error direction is part of the contract
  web.send("response", { ok: true });
  // @ts-expect-error only incoming messages can be observed
  web.on("transformed", () => {});
  // @ts-expect-error discriminated union correlation must survive JSON projection
  web.send("union", { kind: "a", value: 123 });
  // @ts-expect-error the payload must correspond to the actual message name
  web.send(dynamicName, "abc");
  // @ts-expect-error explicit undefined is not JSON, even for optional fields
  web.send("optional", { extra: undefined });
  // @ts-expect-error unknown input still requires JSON data
  web.send("anything", { bad: undefined });
  // @ts-expect-error rich output must be explicitly encoded before sending
  web.send("effect", new Date());
  // @ts-expect-error schemas requiring non-JSON inputs cannot be sent by the JSON bridge
  web.send("dateInput", new Date());
  // @ts-expect-error incorrect tuple item
  web.send("tuple", [1, "x"]);
  // @ts-expect-error contract type is required for platform adapters
  createWebBridge({ receive: toWeb });
  const core = createBridge({ receive: toNative, transport: { send() {} } });
  core.on("transformed", (value) => {
    expectTypeOf(value).toEqualTypeOf<number>();
  });
  // @ts-expect-error outgoing contract is empty unless explicitly provided
  core.send("transformed", "x");
  expectTypeOf<JsonInput<{ readonly optional?: string | undefined }>>().toEqualTypeOf<{
    readonly optional?: string;
  }>();
}
void checkTypes;
