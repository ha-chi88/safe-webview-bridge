import type { toNative } from "./to-native.js";
import type { toWeb } from "./to-web.js";

export type Contract = { toNative: typeof toNative; toWeb: typeof toWeb };
