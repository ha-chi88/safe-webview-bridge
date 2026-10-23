import { defineMessages } from "safe-webview-bridge";
import * as v from "valibot";

export const toNative = defineMessages({
  greet: v.object({ name: v.pipe(v.string(), v.maxLength(100)) }),
});
