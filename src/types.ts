import type { z } from "zod";

/**
 * Options for sending WebView messages
 */
export interface SendMessageOptions<T> {
  message: T;
  fallback?: () => void;
}

/**
 * WebView bridge configuration
 */
export interface WebViewBridgeConfig<T extends z.ZodType> {
  schema: T;
}
