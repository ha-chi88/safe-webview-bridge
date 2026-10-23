import type { StandardSchemaV1 } from "@standard-schema/spec";
import { type } from "arktype";
import { Effect, Schema, SchemaGetter } from "effect";
import * as v from "valibot";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import * as zm from "zod/mini";

import { createBridge, defineMessages } from "../src/index.js";
import { wire } from "./helpers.js";

const objectCases: { name: string; schema: StandardSchemaV1 }[] = [
  { name: "Zod", schema: z.object({ name: z.string() }) },
  { name: "Zod Mini", schema: zm.object({ name: zm.string() }) },
  { name: "Valibot", schema: v.object({ name: v.string() }) },
  { name: "ArkType", schema: type({ name: "string" }) },
  {
    name: "Effect",
    schema: Schema.toStandardSchemaV1(Schema.Struct({ name: Schema.String })),
  },
];

describe.each(objectCases)("$name interoperability", ({ schema }) => {
  it("delivers valid data and preserves nested validation paths", async () => {
    const bridge = createBridge({
      receive: defineMessages({ value: schema }),
      transport: { send() {} },
    });
    const handler = vi.fn();
    bridge.on("value", handler);
    expect((await bridge.receive(wire("value", { name: "Ada" }))).ok).toBe(true);
    expect(handler).toHaveBeenCalledWith({ name: "Ada" });
    const invalid = await bridge.receive(wire("value", { name: 123 }));
    expect(invalid).toMatchObject({ ok: false, error: { code: "validation_failed" } });
    if (!invalid.ok && invalid.error.code === "validation_failed") {
      const path = Array.from(invalid.error.issues[0]?.path ?? [], (part) =>
        typeof part === "object" ? part.key : part,
      );
      expect(path).toEqual(["name"]);
    }
    expect(handler).toHaveBeenCalledOnce();
    bridge.dispose();
  });
});

it("mixes schema vendors in one contract", async () => {
  const receive = defineMessages({
    zod: z.string(),
    valibot: v.number(),
    arktype: type("boolean"),
    effect: Schema.toStandardSchemaV1(Schema.Null),
    mini: zm.literal("mini"),
  });
  const bridge = createBridge({ receive, transport: { send() {} } });
  for (const [name, value] of [
    ["zod", "text"],
    ["valibot", 42],
    ["arktype", true],
    ["effect", null],
    ["mini", "mini"],
  ] as const) {
    expect((await bridge.receive(wire(name, value))).ok).toBe(true);
  }
  bridge.dispose();
});

it("applies defaults, stripping, brands, and transforms on the receive side", async () => {
  const receive = defineMessages({
    zod: z.object({ name: z.string().default("default") }),
    valibot: v.pipe(
      v.string(),
      v.transform((value) => value.length),
    ),
    arktype: type("string").pipe((value) => value.length),
    effect: Schema.toStandardSchemaV1(Schema.DateFromString),
    branded: z.string().brand<"Id">(),
  });
  const bridge = createBridge({ receive, transport: { send() {} } });
  const values: unknown[] = [];
  for (const name of Object.keys(receive) as (keyof typeof receive)[])
    bridge.on(name, (value) => {
      values.push(value);
    });
  await bridge.receive(wire("zod", { extra: "stripped" }));
  await bridge.receive(wire("valibot", "abc"));
  await bridge.receive(wire("arktype", "abcd"));
  await bridge.receive(wire("effect", "2026-01-01T00:00:00.000Z"));
  await bridge.receive(wire("branded", "id"));
  expect(values).toEqual([
    { name: "default" },
    3,
    4,
    new Date("2026-01-01T00:00:00.000Z"),
    "id",
  ]);
  bridge.dispose();
});

it("awaits async Zod, Valibot, and Effect schemas", async () => {
  const receive = defineMessages({
    zod: z.string().transform(async (value) => value.length),
    valibot: v.pipeAsync(
      v.string(),
      v.transformAsync(async (value) => value.length),
    ),
    effect: Schema.toStandardSchemaV1(
      Schema.String.pipe(
        Schema.decodeTo(Schema.Number, {
          decode: SchemaGetter.transformEffect((value) =>
            Effect.promise(async () => value.length),
          ),
          encode: SchemaGetter.transform((value) => String(value)),
        }),
      ),
    ),
  });
  const bridge = createBridge({ receive, transport: { send() {} } });
  const values: number[] = [];
  bridge.on("zod", (value) => {
    values.push(value);
  });
  bridge.on("valibot", (value) => {
    values.push(value);
  });
  bridge.on("effect", (value) => {
    values.push(value);
  });
  for (const name of ["zod", "valibot", "effect"]) {
    expect((await bridge.receive(wire(name, "abc"))).ok).toBe(true);
  }
  expect(values).toEqual([3, 3, 3]);
  bridge.dispose();
});
