import { useCallback, useEffect, useRef, useState } from "react";
import { WebView } from "react-native-webview";
import {
  createNativeBridge,
  createOriginPolicy,
  type NativeBridge,
} from "safe-webview-bridge/react-native";

import type { AppBridge } from "./messages/contract.js";
import { toNative } from "./messages/to-native.js";

const PAGE = "https://your-app.example/greeting";
const allowedOrigins = ["https://your-app.example"];
const isAllowed = createOriginPolicy(allowedOrigins);

/** A single-document shell. The served page must also enforce the CSP in SECURITY.md. */
export function SecureWebView() {
  const webView = useRef<WebView<unknown>>(null);
  const bridge = useRef<NativeBridge<AppBridge> | null>(null);
  const currentUrl = useRef<string | null>(null);
  const [ready, setReady] = useState(false);

  const closeSession = useCallback(() => {
    currentUrl.current = null;
    bridge.current?.dispose();
    bridge.current = null;
  }, []);

  const beginSession = useCallback(
    (url: string) => {
      closeSession();
      if (!isAllowed(url) || url !== PAGE) return;
      currentUrl.current = url;
      const current = createNativeBridge<AppBridge>({
        receive: toNative,
        allowedOrigins,
        getCurrentUrl: () => currentUrl.current,
        getWebView: () => webView.current,
        onError: (error) => {
          console.warn("bridge", error.code);
        },
      });
      current.on("greet", async ({ name }) => {
        // Privileged handlers must additionally check current login state and permissions.
        const result = await current.send("greeting", `Hello, ${name}!`);
        if (!result.ok) console.warn("bridge", result.error.code);
      });
      bridge.current = current;
    },
    [closeSession],
  );

  useEffect(() => {
    // Delay the WebView until Strict Mode's effect setup/cleanup replay has completed.
    // oxlint-disable-next-line react/set-state-in-effect -- Mount the external WebView only after effect setup/cleanup replay.
    setReady(true);
    return closeSession;
  }, [closeSession]);

  return ready ? (
    <WebView<unknown>
      ref={webView}
      source={{ uri: PAGE }}
      originWhitelist={allowedOrigins}
      onShouldStartLoadWithRequest={(request) => {
        if (
          request.isTopFrame === false ||
          !isAllowed(request.url) ||
          request.url !== PAGE
        )
          return false;
        closeSession();
        return true;
      }}
      onLoadStart={(event) => beginSession(event.nativeEvent.url)}
      onMessage={(event) => {
        void bridge.current?.onMessage(event);
      }}
      onError={closeSession}
      onHttpError={closeSession}
      onRenderProcessGone={closeSession}
      onContentProcessDidTerminate={closeSession}
      onOpenWindow={() => {
        /* External windows have no bridge. */
      }}
      javaScriptCanOpenWindowsAutomatically={false}
      setSupportMultipleWindows={true}
      mixedContentMode="never"
      allowFileAccess={false}
      allowFileAccessFromFileURLs={false}
      allowUniversalAccessFromFileURLs={false}
      webviewDebuggingEnabled={false}
    />
  ) : null;
}
