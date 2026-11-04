import { defineConfig } from "@playwright/test";
import base from "./playwright.mock.config";

export default defineConfig({
  ...base,
  testIgnore: [],
  testMatch: ["**/login-project.spec.ts", "**/mvp-acceptance.spec.ts", "**/master-spec-acceptance.spec.ts", "**/report-live.spec.ts"],
});
