import { expect, test } from "@playwright/test";
import { build } from "esbuild";

import type * as Fixture from "./fixture.js";

declare global {
  interface Window {
    BridgeFixture: typeof Fixture;
  }
}

let bundle: string;
test.beforeAll(async () => {
  const result = await build({
    entryPoints: ["test/browser/fixture.ts"],
    bundle: true,
    format: "iife",
    globalName: "BridgeFixture",
    write: false,
    target: "es2022",
  });
  bundle = result.outputFiles[0]?.text ?? "";
});

for (const platform of ["ios", "android", "bubbling"] as const) {
  test(`browser transport roundtrip: ${platform}`, async ({ page }) => {
    await page.route("https://bridge.test/", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><html><body>Bridge integration test</body></html>",
      }),
    );
    await page.goto("https://bridge.test/");
    await page.addScriptTag({ content: bundle });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const result = await page.evaluate(
      (kind) => window.BridgeFixture.roundtrip(kind),
      platform,
    );
    expect(result.sent.ok).toBe(true);
    expect(result.received).toEqual([result.expected]);
    expect(result.errors).toEqual([]);
    expect(errors).toEqual([]);
  });
}

for (const [name, frameUrl, opaque, origin] of [
  ["cross-origin", "https://evil.test/frame", false, "https://evil.test"],
  ["same-origin", "https://bridge.test/frame", false, "https://bridge.test"],
  ["sandboxed opaque", "https://evil.test/frame", true, "null"],
] as const) {
  test(`rejects ${name} iframe postMessage forgeries`, async ({ page }) => {
    await page.route("https://bridge.test/", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><body>Security test</body>",
      }),
    );
    await page.route(frameUrl, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><script>
        parent.postMessage(JSON.stringify({version:1,channel:"safe-webview-bridge",type:"value",payload:"forged"}), "*");
        parent.postMessage("attack-done", "*");
      </script>`,
      }),
    );
    await page.goto("https://bridge.test/");
    await page.addScriptTag({ content: bundle });
    const result = await page.evaluate(
      ({ frameUrl: url, opaque: sandboxed }) =>
        window.BridgeFixture.rejectFrameMessages(url, sandboxed),
      { frameUrl, opaque },
    );
    expect(result.origin).toBe(origin);
    expect(result.received).toEqual(["native"]);
  });
}
