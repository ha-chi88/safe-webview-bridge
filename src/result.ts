import type { BridgeError, Result } from "./types.js";

export const success = (): Result<void> => ({ ok: true, value: undefined });
export const failure = (error: BridgeError): Result<never> => ({ ok: false, error });
