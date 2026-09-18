import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  use: {
    channel: "chrome",
    baseURL: "http://127.0.0.1:5188",
    headless: true,
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run preview -- --port 5188",
    url: "http://127.0.0.1:5188",
    reuseExistingServer: !process.env.CI,
  },
});
