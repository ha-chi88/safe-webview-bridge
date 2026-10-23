import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test/browser",
  testMatch: "*.spec.ts",
  fullyParallel: true,
  use: { ...(process.env.CI ? {} : { channel: "chrome" }), headless: true },
  reporter: "list",
});
