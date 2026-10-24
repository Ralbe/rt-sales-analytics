import { createHmac, randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function decodeBase32(secret: string): Buffer {
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (const character of secret.replace(/=+$/, "").toUpperCase()) {
    const digit = BASE32_ALPHABET.indexOf(character);
    if (digit < 0) throw new Error("Секрет TOTP должен быть в формате Base32");
    value = (value << 5) | digit;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
      value &= (1 << bits) - 1;
    }
  }

  return Buffer.from(bytes);
}

function totp(secret: string, now = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)));
  const digest = createHmac("sha1", decodeBase32(secret)).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 1_000_000).padStart(6, "0");
}

test("вход с TOTP, открытие дашборда и создание проекта", async ({ page }) => {
  const email = process.env.E2E_EMAIL;
  const password = process.env.E2E_PASSWORD;
  const totpSecret = process.env.E2E_TOTP_SECRET;
  if (!email || !password || !totpSecret) {
    throw new Error("Для E2E задайте E2E_EMAIL, E2E_PASSWORD и E2E_TOTP_SECRET тестовой учётной записи");
  }

  await page.goto("/login");
  await page.evaluate(() => window.localStorage.clear());
  await expect(page.getByRole("heading", { name: "Вход в систему" })).toBeVisible();

  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Пароль").fill(password);
  const loginResponsePromise = page.waitForResponse(
    (response) => response.url().endsWith("/api/auth/login") && response.request().method() === "POST",
  );
  const [loginResponse] = await Promise.all([
    loginResponsePromise,
    page.getByRole("button", { name: "Продолжить" }).click(),
  ]);
  expect(loginResponse.ok()).toBeTruthy();
  const challenge = (await loginResponse.json()) as { setup_required: boolean; secret: string | null };
  expect(challenge.setup_required).toBe(false);
  expect(challenge.secret).toBeNull();

  await expect(page.getByRole("heading", { name: "Подтверждение входа" })).toBeVisible();
  await expect(page.getByLabel("Код из приложения")).toBeVisible();
  await page.getByLabel("Код из приложения").fill(totp(totpSecret));
  const mfaResponsePromise = page.waitForResponse(
    (response) => response.url().endsWith("/api/auth/2fa") && response.request().method() === "POST",
  );
  let mfaResponse: Awaited<typeof mfaResponsePromise>;
  try {
    [mfaResponse] = await Promise.all([
      mfaResponsePromise,
      page.getByRole("button", { name: "Войти" }).click(),
    ]);
  } finally {
    await page.getByLabel("Код из приложения").fill("").catch(() => undefined);
  }
  expect(mfaResponse.ok()).toBeTruthy();
  await page.waitForURL((url) => /^\/dashboards(?:\/\d+)?$/.test(url.pathname));
  await expect(page.getByLabel("Название дашборда")).toHaveValue(/Дашборд/);

  await page.getByRole("link", { name: "Новый проект" }).click();
  await expect(page.getByRole("heading", { name: "Новый проект" })).toBeVisible();

  const projectName = `E2E-проект-${randomUUID()}`;
  await page.getByLabel(/Название проекта/).fill(projectName);
  await page.getByLabel(/Клиент/).fill("Северная логистика");
  const clientOption = page.getByRole("button", { name: /ООО «Северная логистика»/ });
  await expect(clientOption).toBeVisible();
  await clientOption.click();
  await page.getByLabel(/Услуга/).selectOption({ index: 1 });
  await page.getByLabel(/Ответственный/).selectOption({ label: "Мария Продажина" });
  await page.getByLabel(/Сумма контракта/).fill("1000");

  const closeDate = new Date();
  closeDate.setUTCDate(closeDate.getUTCDate() + 30);
  await page.getByLabel(/Плановое закрытие/).fill(closeDate.toISOString().slice(0, 10));

  const createResponsePromise = page.waitForResponse(
    (response) => response.url().endsWith("/api/projects") && response.request().method() === "POST",
  );
  const [createResponse] = await Promise.all([
    createResponsePromise,
    page.getByRole("button", { name: "Создать проект" }).click(),
  ]);
  expect(createResponse.status()).toBe(201);

  await page.waitForURL((url) => /^\/projects\/\d+$/.test(url.pathname));
  await expect(page.getByRole("heading", { name: projectName })).toBeVisible();
});
