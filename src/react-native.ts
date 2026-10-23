import { createBridge, DEFAULT_LIMITS } from "./bridge.js";
import { createOriginPolicy } from "./origin.js";
import { createRateLimit } from "./rate-limit.js";
import { createErrorReporter } from "./report-error.js";
import { failure } from "./result.js";
import type {
  Bridge,
  BridgeContract,
  BridgeError,
  BridgeOptions,
  Result,
} from "./types.js";

export { createOriginPolicy } from "./origin.js";

/** Structural types keep React and react-native-webview out of the package's dependencies. */
export interface WebViewHandle {
  postMessage(message: string): void;
}
export interface NativeMessageEvent {
  readonly nativeEvent: { readonly data: string; readonly url: string };
}
export type NativeBridgeOptions<Contract extends BridgeContract> = Omit<
  BridgeOptions<Contract["toNative"]>,
  "transport"
> & {
  readonly getWebView: () => WebViewHandle | null | undefined;
  readonly allowedOrigins: readonly string[];
  /** Host-owned navigation state. Return null while navigating or when the document is untrusted. */
  readonly getCurrentUrl: () => string | null | undefined;
};

export type NativeBridge<Contract extends BridgeContract> = Omit<
  Bridge<Contract["toNative"], Contract["toWeb"]>,
  "receive"
> & {
  readonly onMessage: (event: NativeMessageEvent) => Promise<Result<void>>;
};

export function createNativeBridge<Contract extends BridgeContract = never>(
  options: NativeBridgeOptions<NoInfer<Contract>>,
): NativeBridge<Contract> {
  if (typeof options.getWebView !== "function")
    throw new TypeError("getWebView must be a function");
  if (typeof options.getCurrentUrl !== "function")
    throw new TypeError("getCurrentUrl must be a function");
  const { getWebView, getCurrentUrl } = options;
  const allowed = createOriginPolicy(options.allowedOrigins);
  const report = createErrorReporter(options.onError);
  const admit = createRateLimit(
    options.limits?.maxMessagesPerSecond ?? DEFAULT_LIMITS.maxMessagesPerSecond,
  );
  let disposed = false;
  const reject = (error: BridgeError) => {
    if (error.code !== "disposed") report(error);
    return failure(error);
  };
  const bridge = createBridge<Contract["toNative"], Contract["toWeb"]>({
    ...options,
    onError: report,
    transport: {
      send(message) {
        if (!allowed(getCurrentUrl())) return false;
        const target = getWebView();
        if (!target) return false;
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- WebView's single-argument transport; the active origin is checked above.
        target.postMessage(message);
      },
    },
  });
  return {
    send: bridge.send,
    on: bridge.on,
    dispose() {
      disposed = true;
      bridge.dispose();
    },
    async onMessage(event) {
      if (disposed)
        return reject({
          code: "disposed",
          phase: "receive",
          message: "Bridge has been disposed",
        });
      if (!admit())
        return reject({
          code: "rate_limited",
          phase: "receive",
          message: "Incoming message rate exceeded maxMessagesPerSecond",
        });
      try {
        if (!allowed(getCurrentUrl()) || !allowed(event?.nativeEvent?.url))
          return reject({
            code: "untrusted_origin",
            phase: "receive",
            message: "Message does not belong to an allowed active document",
          });
        return bridge.receive(event?.nativeEvent?.data);
      } catch (cause) {
        return reject({
          code: "transport_failed",
          phase: "receive",
          message: "Could not read document trust state",
          cause,
        });
      }
    },
  };
}
