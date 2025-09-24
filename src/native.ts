import type { WebViewMessageEvent } from "react-native-webview";
import type WebView from "react-native-webview";
import type { z } from "zod";
import type React from "react";
import type { WebViewBridgeConfig } from "./types";

// Constant definitions
const FALLBACK_KEY = "_fallbackKey" as const;
const CONSOLE_MESSAGES = {
  SCHEMA_VALIDATION_ERROR: "Schema validation error:",
  PARSE_ERROR: "Failed to parse WebView message:",
  WEBVIEW_NOT_AVAILABLE: "WebView reference is not available",
} as const;

export const createNativeWebViewBridge = <T extends z.ZodType>({
  schema,
  webViewRef,
}: WebViewBridgeConfig<T> & {
  webViewRef: React.RefObject<WebView | null>;
}) => {
  // Handle message events from WebView
  const handleMessage = ({
    event,
    callback,
  }: {
    event: WebViewMessageEvent;
    callback: (message: z.infer<T>) => void;
  }) => {
    try {
      const originalData = parseMessageData(event.nativeEvent.data);
      const parsedResult = schema.safeParse(originalData);

      if (!parsedResult.success) {
        handleParseError({
          error: parsedResult.error,
          originalData,
          webViewRef,
        });
        return;
      }

      callback(parsedResult.data);

      // Clean up fallback if processed successfully
      const fallbackKey = getFallbackKey(originalData);
      if (fallbackKey) {
        cleanupFallbackInWebView({
          webViewRef,
          fallbackKey,
        });
      }
    } catch (error) {
      console.error(CONSOLE_MESSAGES.PARSE_ERROR, error);
    }
  };

  return {
    handleMessage,
  };
};

// Parse message data
const parseMessageData = (data: string): unknown => {
  return JSON.parse(data);
};

// Handle parse errors
const handleParseError = ({
  error,
  originalData,
  webViewRef,
}: {
  error: z.ZodError;
  originalData: unknown;
  webViewRef?: React.RefObject<WebView | null>;
}) => {
  // Log schema validation errors
  console.error(CONSOLE_MESSAGES.SCHEMA_VALIDATION_ERROR, error);

  // Notify WebView of schema validation errors
  sendParseErrorToWebView({
    webViewRef,
    fallbackKey: getFallbackKey(originalData),
  });
};

// Safely retrieve fallbackKey from object
const getFallbackKey = (data: unknown): string | undefined => {
  try {
    if (
      typeof data === "object" &&
      data !== null &&
      FALLBACK_KEY in data &&
      typeof (data as Record<string, unknown>)[FALLBACK_KEY] === "string"
    ) {
      return (data as Record<string, unknown>)[FALLBACK_KEY] as string;
    }
  } catch (error) {
    // Ignore property access errors
  }
  return undefined;
};

// Execute JavaScript in WebView (internal use only)
const injectJavaScriptInternal = (
  webViewRef: React.RefObject<WebView | null> | undefined,
  script: string,
) => {
  if (!webViewRef?.current) {
    console.warn(CONSOLE_MESSAGES.WEBVIEW_NOT_AVAILABLE);
    return;
  }
  webViewRef.current.injectJavaScript(script);
};

/**
 * Notify WebView of schema validation errors and trigger fallback
 *
 * @purpose Execute fallback function when message validation fails
 * @context Triggers the fallback that was defined on the Web side
 */
const sendParseErrorToWebView = ({
  webViewRef,
  fallbackKey,
}: {
  webViewRef: React.RefObject<WebView | null> | undefined;
  fallbackKey: string | undefined;
}) => {
  if (!shouldExecuteFallback(webViewRef, fallbackKey)) return;

  const script = createFallbackScript(fallbackKey, true);
  injectJavaScriptInternal(webViewRef, script);
};

/**
 * Clean up fallback function in WebView
 *
 * @purpose Prevent memory leaks when messages are processed successfully
 */
const cleanupFallbackInWebView = ({
  webViewRef,
  fallbackKey,
}: {
  webViewRef: React.RefObject<WebView | null> | undefined;
  fallbackKey: string | undefined;
}) => {
  if (!shouldExecuteFallback(webViewRef, fallbackKey)) return;

  const script = createFallbackScript(fallbackKey, false);
  injectJavaScriptInternal(webViewRef, script);
};

// Determine whether fallback processing should be executed
const shouldExecuteFallback = (
  webViewRef: React.RefObject<WebView | null> | undefined,
  fallbackKey: string | undefined,
): boolean => {
  return !!(webViewRef?.current && fallbackKey);
};

// Generate script for fallback processing
const createFallbackScript = (
  fallbackKey: string | undefined,
  executeFallback: boolean,
): string => {
  const serializedKey = JSON.stringify(fallbackKey);

  return `
    (function() {
      const fallbackKey = ${serializedKey};
      // If fallbackKey exists
      if (fallbackKey && window[fallbackKey]) {
        ${executeFallback ? "const fallback = window[fallbackKey];" : ""}
        window[fallbackKey] = undefined;
        ${executeFallback ? "fallback();" : ""}
      }
    })();
    true;
  `;
};
