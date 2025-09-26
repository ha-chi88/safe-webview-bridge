# 🌉 safe-webview-bridge

A TypeScript library that enables type-safe communication between React Native WebView and Web using zod schemas for message type safety.

## Features

- 🔒 **Type Safety**: Complete type safety with zod schemas
- 🎯 **Flexibility**: Users can define their own schemas
- 🔄 **Bidirectional Communication**: Supports both Web-to-Native and Native-to-Web
- 🛡️ **Error Handling**: Proper handling of validation errors
- 🌐 **Environment Detection**: Automatic WebView environment detection and fallback handling

## Installation

```bash
npm install safe-webview-bridge zod
# or
yarn add safe-webview-bridge zod
# or
pnpm add safe-webview-bridge zod
```

## Usage

### 1. Define Message Schema

First, define your application-specific message schema:

```typescript
import { z } from "zod";

// Define message schema
const messageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("login"),
    data: z.object({
      token: z.string(),
      userId: z.string(),
    }),
  }),
  z.object({
    type: z.literal("logout"),
    data: z.object({
      userId: z.string(),
    }),
  }),
  z.object({
    type: z.literal("navigate"),
    data: z.object({
      screen: z.string(),
      params: z.record(z.unknown()).optional(),
    }),
  }),
]);
```

### 2. Web-side Implementation

```typescript
import { createWebViewBridge } from "safe-webview-bridge";

// Create bridge
const bridge = createWebViewBridge({
  schema: messageSchema,
});

// Send message
bridge.sendMessage({
  message: {
    type: "login",
    data: {
      token: "abc123",
      userId: "user-123",
    },
  },
  fallback: () => {
    // Handle cases where message cannot be delivered or validation fails
    console.log("Message could not be delivered or validation failed");
  },
});

// Check if in WebView environment
if (bridge.isWebViewEnvironment()) {
  console.log("Running in WebView");
}
```

### 3. Native-side Implementation (React Native)

```typescript
import React, { useRef } from "react";
import WebView from "react-native-webview";
import { createNativeWebViewBridge } from "safe-webview-bridge";

function MyWebView() {
  const webViewRef = useRef<WebView>(null);
  
  // Create bridge
  const bridge = createNativeWebViewBridge({
    schema: messageSchema,
    webViewRef: webViewRef,
  });

  // Message handler
  const handleMessage = (event) => {
    bridge.handleMessage({
      event,
      callback: (message) => {
        switch (message.type) {
          case "login":
            console.log("Login:", message.data);
            // Handle login
            break;
          case "logout":
            console.log("Logout:", message.data);
            // Handle logout
            break;
          case "navigate":
            console.log("Navigate:", message.data);
            // Handle navigation
            break;
        }
      }
    });
  };

  return (
    <WebView
      ref={webViewRef}
      source={{ uri: "https://example.com" }}
      onMessage={handleMessage}
    />
  );
}
```

### 4. Fallback Handling

Fallback functions are executed in the following cases:
- When not running in a WebView environment
- When message validation fails on the Native side

```typescript
// Web-side
bridge.sendMessage({
  message: { type: "login", data: { token: "abc", userId: "123" } },
  fallback: () => {
    console.log("Fallback executed: Message could not be delivered or validation failed");
    // Handle the fallback scenario appropriately
  },
});
```


## API Reference

### createWebViewBridge(config)

Creates a bridge on the Web side.

- `config.schema`: zod schema

Returns:
- `sendMessage(options)`: Send a message
- `isWebViewEnvironment()`: Check if running in WebView environment

### createNativeWebViewBridge(config)

Creates a bridge on the Native side.

- `config.schema`: zod schema
- `config.webViewRef`: WebView ref

Returns:
- `handleMessage(options)`: Process messages
  - `options.event`: WebViewMessageEvent
  - `options.callback`: Callback function to receive messages

## License

MIT
