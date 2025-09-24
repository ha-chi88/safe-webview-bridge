// Web-side bridge
export { createWebViewBridge } from "./web";

// Native-side bridge
export { createNativeWebViewBridge } from "./native";

// Type definitions
export type {
  SendMessageOptions,
  WebViewBridgeConfig,
} from "./types";
