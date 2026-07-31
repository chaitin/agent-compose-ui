import { defineConfig } from 'playwright/test';

export default defineConfig({
  timeout: 120_000,
  expect: { timeout: 30_000 },
  use: {
    baseURL: process.env.AGENT_COMPOSE_E2E_FRONTEND_URL ?? 'http://127.0.0.1:5174',
    headless: true,
    locale: 'zh-CN',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});
