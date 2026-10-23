import { createBridge } from "./bridge.js";
import type { Bridge, BridgeContract, BridgeOptions } from "./types.js";

export interface WebMessageEvent {
  readonly type: string;
  readonly data?: unknown;
  readonly origin: string;
  readonly source: unknown;
}
export interface WebMessageTarget {
  addEventListener(type: "message", listener: (event: WebMessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: WebMessageEvent) => void): void;
}
export interface WebViewWindow extends WebMessageTarget {
  readonly ReactNativeWebView?: { postMessage(message: string): void };
  readonly document?: WebMessageTarget;
}

export type WebBridgeOptions<Contract extends BridgeContract> = Omit<
  BridgeOptions<Contract["toWeb"]>,
  "transport"
> & {
  /** Defaults to window. Evaluated at creation for listeners, and again for each send. */
  readonly getWindow?: () => WebViewWindow | undefined;
};

/** Import is SSR-safe. Create a new instance after mounting/hydrating the WebView page. */
export function createWebBridge<Contract extends BridgeContract = never>(
  options: WebBridgeOptions<NoInfer<Contract>>,
): Bridge<Contract["toWeb"], Contract["toNative"]> {
  if (options.getWindow !== undefined && typeof options.getWindow !== "function")
    throw new TypeError("getWindow must be a function");
  const getWindow: () => WebViewWindow | undefined =
    options.getWindow ?? (() => (typeof window === "undefined" ? undefined : window));
  return createBridge<Contract["toWeb"], Contract["toNative"]>({
    ...options,
    transport: {
      send(message) {
        const target = getWindow()?.ReactNativeWebView;
        if (!target) return false;
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- ReactNativeWebView is a single-argument native transport, not window.postMessage.
        target.postMessage(message);
      },
      subscribe(receive) {
        const target = getWindow();
        if (!target) return () => {};
        const seen = new WeakSet<WebMessageEvent>();
        const listener = (event: WebMessageEvent) => {
          // RN WebView dispatches a synthetic MessageEvent with these defaults.
          // Browser postMessage (including cross-origin frames) is a different transport.
          if (event.origin !== "" || event.source !== null) return;
          // Android dispatches on document; iOS dispatches on window. A bubbling event is one message.
          if (seen.has(event)) return;
          seen.add(event);
          receive(event.data);
        };
        target.addEventListener("message", listener);
        try {
          target.document?.addEventListener("message", listener);
        } catch (cause) {
          target.removeEventListener("message", listener);
          throw cause;
        }
        return () => {
          try {
            target.removeEventListener("message", listener);
          } finally {
            target.document?.removeEventListener("message", listener);
          }
        };
      },
    },
  });
}
