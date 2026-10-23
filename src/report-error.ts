import { createRateLimit } from "./rate-limit.js";
import type { BridgeError, BridgeOptions, MessageSchemas } from "./types.js";

/** Error reporting must not create an unbounded queue of application work. */
export function createErrorReporter(observer: BridgeOptions<MessageSchemas>["onError"]) {
  if (observer !== undefined && typeof observer !== "function")
    throw new TypeError("onError must be a function");
  const admit = createRateLimit(10);
  let pending = false;
  return (error: BridgeError): void => {
    if (!observer || pending || !admit()) return;
    pending = true;
    try {
      const result = observer(error);
      if (result === undefined) {
        pending = false;
      } else {
        void Promise.resolve(result).then(
          () => {
            pending = false;
          },
          () => {
            pending = false;
          },
        );
      }
    } catch {
      pending = false;
    }
  };
}
