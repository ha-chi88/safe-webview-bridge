import { Schema } from "effect";

import { defineMessages } from "../../src/index.js";

export const toNative = defineMessages({
  request: Schema.toStandardSchemaV1(Schema.Struct({ name: Schema.String })),
});
