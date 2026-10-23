# Security policy

## Supported versions

Security fixes target the latest stable version published on npm. Older versions
do not receive separate backports. Upgrade to the latest stable release before
assessing whether a problem remains. Unreleased branches are development code.

## Report a vulnerability privately

Use [GitHub's private vulnerability report form](https://github.com/ha-chi88/safe-webview-bridge/security/advisories/new).
Include the affected version, relevant platform and configuration, impact,
reproduction steps, and a minimal proof of concept when possible. Remove tokens,
personal data, and other secrets from the report.

Do not post unpatched vulnerability details in public issues, discussions, or
pull requests. The maintainer will assess the report and coordinate a fix and
disclosure through the private advisory. This is a volunteer-maintained project;
there is no guaranteed response or remediation deadline.

## Security model and integration

This bridge validates and bounds messages from untrusted input. It does not authenticate
a user, authorize native capabilities, sandbox JavaScript, or make an untrusted page safe
to attach to a native bridge. This document describes the v2 implementation and the
host controls it requires; it is not an independent penetration-test certification.

## Trust boundaries

| Boundary                       | Library control                                                                                                                                                   | Host responsibility                                                                                                                   |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Browser events → Web adapter   | Require the native dispatch shape: empty `origin` and null `source`. Ignore ordinary `postMessage` events, including same-origin and opaque-origin iframe events. | Keep scripts in the main document trusted; same-document JavaScript can synthesize native-shaped events.                              |
| WebView → Native adapter       | Require exact `allowedOrigins`, check native event URL metadata and host-owned `getCurrentUrl` before parsing.                                                    | Supply the actual document state, prohibit untrusted frames, and dispose on every document change.                                    |
| Native → WebView               | Recheck `getCurrentUrl` when a queued send runs; refuse sends while the host reports no trusted active page.                                                      | Clear trust before accepted navigation and prevent unexpected navigation/redirects.                                                   |
| JSON → schema → handlers       | Strict JSON, versioned envelope, registered message names, reserved-key rejection, schema validation once.                                                        | Bound schema strings/arrays, avoid expensive regexes, validate semantic values such as URLs and paths.                                |
| Handler → privileged operation | Typed validated payload only.                                                                                                                                     | Check current identity and per-operation permissions immediately before side effects; confirm sensitive actions in trusted native UI. |

`channel` is routing metadata, not a password or authentication mechanism. Neither
origin checks nor a secret embedded in page JavaScript can protect against XSS executing
in that page. Keep credentials and privileged decisions in native/server code.
Messages are not signed, deduplicated across distinct events, or protected against
replay by a trusted page. Use server-side authorization and idempotency keys for
payments and other operations that must not be repeated.

The Web adapter's empty-origin/null-source test is specific to React Native WebView's
synthetic native dispatch. It is **not** an origin-validation recipe for general
`window.postMessage` applications. Custom transports must authenticate their own peers.

## Required WebView integration

See the type-checked [single-document example](examples/SecureWebView.tsx).

1. Load only a trusted HTTPS document. Configure exact `allowedOrigins` and
   `originWhitelist`, and independently enforce navigation in
   `onShouldStartLoadWithRequest`. Do not use wildcard origins or substring/prefix
   comparisons. Initial sources and redirects also require policy checks;
   navigation callbacks alone do not cover every platform/load path.
2. Derive `getCurrentUrl` from host-owned navigation state, never from a message's
   payload or by copying `onMessage.nativeEvent.url`. Return null while no document
   is authorized. Dispose the old instance before navigation, on reload/error or
   process termination, and create a fresh instance for each trusted document.
   Disposal suppresses late validator results; already-started application side
   effects need their own cancellation and authorization checks.
3. Do not embed third-party frames, user HTML, or third-party scripts in a privileged
   WebView. Use a separate WebView without an `onMessage` bridge or an external browser.
4. Disable file access, mixed content, automatic JavaScript popups, and production
   WebView debugging. Maintain Android cleartext-traffic restrictions and iOS ATS;
   do not bypass TLS/certificate errors. Permission requests and external URL opening
   must be handled explicitly by the application.
5. Validate authorization in each handler. A valid message from a permitted origin
   may still request another user's data or an operation the current user cannot run.

The adapter accepts canonical HTTPS origins and explicitly listed HTTP loopback
origins (`localhost`, `127.0.0.1`, `[::1]`) for development. Paths, wildcards,
credentials, opaque origins, remote HTTP and `blob:`/`file:`/`data:` are rejected. A local-file
application needs a separately reviewed transport and trust policy; it cannot claim
HTTPS origin authentication by allowlisting `null`.

### Native metadata limitations

In the inspected React Native WebView 14 source, iOS reports the sending frame URL and
the modern Android WebMessageListener path reports a source origin. The Android
`addJavascriptInterface` fallback instead reports the top-level WebView URL. The
JavaScript adapter cannot distinguish a malicious child frame on that fallback, and
there is no portable `isMainFrame` claim in its `onMessage` event. An origin allowlist
therefore does not replace iframe/script restrictions. See
[Android's native-bridge security guidance](https://developer.android.com/privacy-and-security/risks/insecure-webview-native-bridges),
the [Android implementation](https://github.com/react-native-webview/react-native-webview/blob/v14.0.1/android/src/main/java/com/reactnativecommunity/webview/RNCWebView.java),
and the [iOS implementation](https://github.com/react-native-webview/react-native-webview/blob/v14.0.1/apple/RNCWebViewImpl.m).

### Web response headers

For the single-document example, serve a policy such as the following as an HTTP
response header, adapting resource origins to the actual application:

```http
Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; font-src 'self'; frame-src 'none'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'none'
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
```

Do not add `unsafe-eval` or `unsafe-inline` to accommodate untrusted content. Serve
only trusted scripts under allowed script origins. Keep untrusted HTML out of DOM
injection sinks and render message strings as text. The library sends serialized
data through public WebView APIs and never interpolates payloads into its own
executable JavaScript. See [OWASP's web messaging guidance](https://cheatsheetseries.owasp.org/cheatsheets/HTML5_Security_Cheat_Sheet.html#web-messaging).

## Resource and data controls

Input length, nesting, node count, rate and aggregate retained input have separate
bounds. Outgoing JSON expansion is bounded while traversing it, including shared
references and string escaping. Both directions reject `__proto__`, `constructor`
and `prototype` object keys at every depth before user validators or handlers run;
this avoids passing pollution payloads to downstream merges.

Timed-out async work remains charged against the count and retained-input limits
until it actually settles. A permanently hung validator or transport eventually
exhausts capacity instead of allowing unlimited detached work. Timeouts do not cancel
user work or preempt synchronous JavaScript. Custom validators and handlers can
allocate memory or start side effects independently of the bridge; these must be
bounded by the application. Native/WebView event infrastructure also operates before
the JavaScript bridge's limits take effect.

`onError` has a 10-per-second token bucket and at most one pending async invocation.
Excess observer calls are dropped; operation Results are still returned. This prevents
error reporting from becoming an unbounded workload. Do not use it as a complete
audit log. JSON parser causes are omitted because some engines include input excerpts.
Provider issues and other local causes may still contain sensitive application data;
log stable codes and redacted metadata instead of whole errors/payloads.

## Verification and dependency status

```sh
corepack pnpm check
corepack pnpm test:browser
corepack pnpm audit:production
corepack pnpm audit
```

The tests cover malformed/oversized/deep input, prototype-pollution keys, exponential
shared-reference expansion, rate/queue limits, stalled work after timeout, disposal,
error-observer floods, exact URL policies and real browser iframe-message forgeries.
Browser and Metro tests do not replace tests on supported iOS/Android WebViews,
including redirect, subframe, process-crash and navigation behavior in the host app.

As of 2026-10-23, both the production and full dependency audits report no known advisories. The
production graph contains only the type-only Standard Schema specification; schema
vendors, React Native and build tools are development dependencies in this repository.
The targeted `yaml` override keeps a vulnerable optional Vite peer out of the test graph.

Audit results are a point-in-time check and do not establish that all vulnerabilities
are known. The verification scripts use fixed, repository-owned build configuration;
do not run development tools on untrusted glob/config input. Recheck dependency
advisories before releases and keep the lockfile current.
