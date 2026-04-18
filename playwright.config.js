"use strict";

const { defineConfig, devices } = require("@playwright/test");

// Порт теста отличается от дефолтного 18084, чтобы не конфликтовать с
// locally-запущенным dev-сервером.
const PORT = process.env.TEST_PORT || "18099";
const BASE = `http://localhost:${PORT}`;

module.exports = defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: BASE,
    trace: "retain-on-failure",
    screenshot: "only-on-failure"
  },
  projects: [
    { name: "desktop-chrome", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-chrome",  use: { ...devices["Pixel 7"] } }
  ],
  webServer: {
    command: `node --experimental-sqlite server.js`,
    url: BASE,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    env: {
      NODE_ENV: "development",
      PORT,
      DV_DEV_LOGIN: "1",
      DISCORD_CLIENT_ID: "test-cid",
      DISCORD_CLIENT_SECRET: "test-secret",
      SESSION_SECRET: "test-session-secret-please-change",
      PUBLIC_URL: BASE,
      DATA_DIR: "./data-test",
      // Ускоряем replay-сценарий: в тесте Б жмёт replay один, сервер не
      // найдёт пару, и через QUEUE_TIMEOUT_MS fallback-нёт его в бот-матч.
      // 1500мс достаточно коротко, чтобы тест не ушёл в таймаут 30с.
      QUEUE_TIMEOUT_MS: "1500"
    }
  }
});
