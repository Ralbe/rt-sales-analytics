import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// Изолированные проверки интерфейса с ответами API из тестовых сценариев.
export default defineConfig({
  ...base,
  testIgnore: ["**/login-project.spec.ts", "**/mvp-acceptance.spec.ts", "**/master-spec-acceptance.spec.ts", "**/report-live.spec.ts"],
  use: { ...base.use, baseURL: "http://127.0.0.1:3108" },
  webServer: {
    command: "node node_modules/next/dist/bin/next start -p 3108 -H 127.0.0.1",
    url: "http://127.0.0.1:3108/login",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
