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
  // Один воркёр: PvP-replay-тесты шлют два клиента в один webServer-queue,
  // и если параллельно с другим проектом (mobile-chrome ↔ desktop-chrome)
  // тоже идут свои A+B в эту же очередь — они склеиваются накрест, и
  // peer_left уходит не тому пиру. Последовательный прогон убирает гонку
  // без ослабления покрытия.
  workers: 1,
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
      // 5000мс — компромисс: при параллельном прогоне тестов на одном
      // webServer между click(btn-play) у A и у B может пройти больше 1.5с
      // (особенно на mobile-chrome), и пара валится в queue_timeout раньше,
      // чем matched. 5с достаточно, чтобы оба успели встать в очередь, и
      // финальный одиночный fallback B-в-бот укладывается в test.timeout=30с.
      QUEUE_TIMEOUT_MS: "5000"
    }
  }
});
