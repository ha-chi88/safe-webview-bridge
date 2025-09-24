import type { z } from "zod";
import type { SendMessageOptions, WebViewBridgeConfig } from "./types";

// Extend Window type to define webkit property
declare global {
  interface Window {
    webkit?: {
      messageHandlers?: {
        ReactNativeWebView?: {
          postMessage: (message: string) => void;
        };
      };
    };
    ReactNativeWebView?: {
      postMessage: (message: string) => void;
    };
    // Type definition for temporarily storing fallback functions
    [key: string]: unknown;
  }
}

// Constant definitions
const FALLBACK_KEY_PREFIX = "_webview_fallback_";
const FALLBACK_CLEANUP_DELAY = 3000; // 3 seconds
const CONSOLE_MESSAGES = {
  INVALID_MESSAGE: "Invalid message format:",
} as const;

export const createWebViewBridge = <T extends z.ZodType>({
  schema,
}: WebViewBridgeConfig<T>) => {
  // Send message to WebView
  const sendMessage = ({
    message,
    fallback,
  }: SendMessageOptions<z.infer<T>>) => {
    // Validation
    const result = schema.safeParse(message);
    if (!result.success) {
      console.error(CONSOLE_MESSAGES.INVALID_MESSAGE, result.error);
      return;
    }

    // Setup fallback handling
    const fallbackKey = fallback ? setupFallback(fallback) : undefined;

    // Create message payload
    const payload = createPayload(message, fallbackKey);

    // Detect WebView environment and send
    const messageSent = sendToWebView(payload);

    // Execute fallback if message couldn't be sent (not in WebView environment)
    if (!messageSent && fallback && fallbackKey) {
      executeFallback(fallbackKey);
    }
  };

  /**
   * Determine if running in WebView environment
   */
  const isWebViewEnvironment = () => {
    return canUseWebkitHandler() || canUseReactNativeHandler();
  };

  return {
    sendMessage,
    isWebViewEnvironment,
  };
};

// Setup fallback function
const setupFallback = (fallback: () => void): string => {
  const fallbackKey = generateFallbackKey();

  try {
    // Temporarily store fallback function in window
    window[fallbackKey] = fallback;

    // Automatically clean up (prevent memory leaks)
    scheduleFallbackCleanup(fallbackKey);
  } catch (error) {
    console.error("Failed to setup fallback:", error);
  }

  return fallbackKey;
};

// Generate unique fallback key
const generateFallbackKey = (): string => {
  return `${FALLBACK_KEY_PREFIX}${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
};

// Schedule fallback cleanup
const scheduleFallbackCleanup = (fallbackKey: string) => {
  setTimeout(() => {
    try {
      if (window[fallbackKey]) {
        delete window[fallbackKey];
      }
    } catch (error) {
      // Ignore cleanup errors
    }
  }, FALLBACK_CLEANUP_DELAY);
};

// Create message payload
const createPayload = <T>(
  message: T,
  fallbackKey: string | undefined,
): T | (T & { _fallbackKey: string }) => {
  if (fallbackKey) {
    return Object.assign({}, message, { _fallbackKey: fallbackKey });
  }
  return message;
};

// Send message to WebView
const sendToWebView = (payload: unknown): boolean => {
  const serializedPayload = JSON.stringify(payload);

  if (canUseWebkitHandler()) {
    const handler = window.webkit?.messageHandlers?.ReactNativeWebView;
    if (handler?.postMessage) {
      handler.postMessage(serializedPayload);
      return true;
    }
  }

  if (canUseReactNativeHandler()) {
    const webView = window.ReactNativeWebView;
    if (webView?.postMessage) {
      webView.postMessage(serializedPayload);
      return true;
    }
  }

  return false;
};

// Check if webkit handler is available
const canUseWebkitHandler = (): boolean => {
  return !!window.webkit?.messageHandlers?.ReactNativeWebView?.postMessage;
};

// Check if ReactNativeWebView handler is available
const canUseReactNativeHandler = (): boolean => {
  return !!window.ReactNativeWebView?.postMessage;
};

// Execute fallback
const executeFallback = (fallbackKey: string) => {
  try {
    const fallback = window[fallbackKey] as (() => void) | undefined;
    if (fallback && typeof fallback === "function") {
      delete window[fallbackKey];
      fallback();
    }
  } catch (error) {
    console.error("Failed to execute fallback:", error);
  }
};
