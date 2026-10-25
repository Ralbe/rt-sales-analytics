import { createHmac, randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import type { Project, Refs } from "../../src/lib/types";

function totp(secret: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const character of secret.replace(/=+$/, "").toUpperCase()) {
    const digit = alphabet.indexOf(character);
    if (digit < 0) throw new Error("Некорректный тестовый секрет TOTP");
    value = (value << 5) | digit;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
      value &= (1 << bits) - 1;
    }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac("sha1", Buffer.from(bytes)).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

test("приёмка MVP: пользователи, 2FA, проект, финансы, история, экспорт и отзыв доступа", async ({ page, browser }, testInfo) => {
  test.setTimeout(90_000);
  const email = process.env.E2E_EMAIL;
  const password = process.env.E2E_PASSWORD;
  const secret = process.env.E2E_TOTP_SECRET;
  if (!email || !password || !secret) throw new Error("Нужна изолированная тестовая учётная запись администратора");
  const challengeResponse = await page.request.post("/api/auth/login", { data: { email, password } });
  expect(challengeResponse.status()).toBe(200);
  const challenge = await challengeResponse.json();
  const login = await page.request.post("/api/auth/2fa", { data: { mfa_token: challenge.mfa_token, code: totp(secret) } });
  expect(login.status()).toBe(200);
  expect((await login.json()).role).toBe("admin");

  const suffix = randomUUID();
  const newEmail = `acceptance-${suffix}@example.test`;
  const newName = `Пользователь приёмки ${suffix}`;
  const newPassword = randomUUID();
  await page.goto("/users");
  await page.getByRole("button", { name: "Новый пользователь", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Email", { exact: true }).fill(newEmail);
  await dialog.getByLabel("ФИО", { exact: true }).fill(newName);
  await dialog.getByLabel("Пароль", { exact: true }).fill(newPassword);
  const createdResponsePromise = page.waitForResponse((response) =>
    response.url().endsWith("/api/users") && response.request().method() === "POST",
  );
  await dialog.getByRole("button", { name: "Создать пользователя" }).click();
  const createdResponse = await createdResponsePromise;
  expect(createdResponse.status()).toBe(201);
  const created = await createdResponse.json();
  expect(created).not.toHaveProperty("password_hash");
  expect(created).not.toHaveProperty("totp_secret");
  await expect(dialog).toHaveCount(0);

  const member = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  try {
    const firstLogin = await member.request.post("/api/auth/login", { data: { email: newEmail, password: newPassword } });
    expect(firstLogin.status()).toBe(200);
    const setup = await firstLogin.json();
    expect(setup.setup_required).toBe(true);
    const secondFactor = await member.request.post("/api/auth/2fa", { data: { mfa_token: setup.mfa_token, code: totp(setup.secret) } });
    expect(secondFactor.status()).toBe(200);
    expect((await member.request.get("/api/users")).status()).toBe(403);

    const refs = await (await member.request.get("/api/refs")).json() as Refs;
    const clients = await (await member.request.get("/api/clients?limit=1")).json();
    expect(clients.length).toBeGreaterThan(0);
    const start = new Date();
    const close = new Date(start);
    close.setUTCDate(close.getUTCDate() + 30);
    const projectResponse = await member.request.post("/api/projects", { data: {
      name: `Приёмочный проект ${suffix}`, client_id: clients[0].id, service_id: refs.services[0].id,
      stage: "lead", probability: 10, amount: "1000.00", cost: "100.00",
      start_date: start.toISOString().slice(0, 10), expected_close_date: close.toISOString().slice(0, 10),
    } });
    expect(projectResponse.status()).toBe(201);
    const project = await projectResponse.json() as Project;
    expect(project.manager.id).toBe(created.id);
    await page.goto(`/projects/${project.id}`);
    await expect(page.getByRole("heading", { name: project.name, exact: true })).toBeVisible();
    const status = `Согласован ${suffix}`;
    await page.getByLabel("Статус проекта", { exact: true }).fill(status);
    const savedPromise = page.waitForResponse((response) =>
      response.url().endsWith(`/api/projects/${project.id}`) && response.request().method() === "PUT",
    );
    await page.getByRole("button", { name: "Сохранить", exact: true }).click();
    expect((await savedPromise).status()).toBe(200);
    const historySection = page.getByRole("region", { name: "История изменений" });
    await expect(historySection).toContainText(status);

    const finances = await page.request.put(`/api/projects/${project.id}/financial-entries`, { data: [
      { kind: "revenue", year: start.getUTCFullYear(), month: start.getUTCMonth() + 1, amount: "125.125", vat_included: true, status_id: refs.revenue_statuses[0].id },
      { kind: "revenue", year: start.getUTCFullYear(), month: start.getUTCMonth() + 1, amount: "100.000", vat_included: false, status_id: refs.revenue_statuses[0].id },
    ] });
    expect(finances.status()).toBe(200);
    expect((await finances.json()).map((entry: { vat_included: boolean }) => entry.vat_included)).toEqual([true, false]);
    await page.reload();
    await expect(historySection).toContainText("125,125 тыс. ₽");
    await expect(historySection).toContainText("без НДС");
    const history = await (await member.request.get(`/api/projects/${project.id}/history`)).json();
    expect(history.items.length).toBeLessThanOrEqual(10);
    expect(history.items[0].action).toBe("replace_financial_entries");

    const xlsx = await page.request.get(`/api/projects/export.xlsx?q=${encodeURIComponent(project.name)}`);
    expect(xlsx.status()).toBe(200);
    expect((await xlsx.body()).subarray(0, 2).toString()).toBe("PK");
    expect((await member.request.get("/api/projects/export.xlsx")).status()).toBe(403);

    const reportResponse = await page.request.post("/api/dashboards", { data: {
      name: `Отчёт приёмки ${suffix}`, is_shared: false,
      filters: { segment_ids: [project.segment.id], service_ids: [project.service.id], manager_ids: [created.id] },
      widgets: [
        { id: "count", type: "kpi", title: "Активные проекты", x: 0, y: 0, w: 4, h: 3, config: { metric: "projects" } },
        { id: "projects", type: "projects", title: "Проекты приёмки", x: 0, y: 3, w: 12, h: 9, config: { limit: 10 } },
      ],
    } });
    expect(reportResponse.status()).toBe(201);
    const report = await reportResponse.json();
    await page.goto(`/dashboards/${report.id}`);
    await expect(page.getByRole("button", { name: "PDF / Печать" })).toBeEnabled();
    await page.evaluate(() => {
      (window as typeof window & { acceptancePrinted: boolean }).acceptancePrinted = false;
      window.print = () => { (window as typeof window & { acceptancePrinted: boolean }).acceptancePrinted = true; };
    });
    await page.getByRole("button", { name: "PDF / Печать" }).click();
    await expect.poll(() => page.evaluate(() => (window as typeof window & { acceptancePrinted: boolean }).acceptancePrinted)).toBe(true);
    const surface = page.locator("[data-dashboard-print]");
    await expect(surface).toContainText(project.name);
    await expect(surface).toContainText(newName);
    await expect(surface).toContainText(project.segment.name);
    await page.emulateMedia({ media: "print" });
    const pdfPath = testInfo.outputPath("mvp-report.pdf");
    const pdf = await page.pdf({ path: pdfPath, format: "A4", printBackground: true });
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    await testInfo.attach("Приёмочный отчёт из реальных данных API", { path: pdfPath, contentType: "application/pdf" });
    await page.emulateMedia({ media: "screen" });
    await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));

    await page.goto("/users");
    await page.getByPlaceholder("Поиск по email или ФИО").fill(newEmail);
    const row = page.getByRole("row").filter({ hasText: newEmail });
    await row.getByRole("button", { name: `Редактировать ${newEmail}` }).click();
    await page.getByRole("dialog").getByLabel("Учётная запись активна").uncheck();
    await page.getByRole("dialog").getByRole("button", { name: "Сохранить", exact: true }).click();
    await expect(row).toContainText("Отключён");
    expect((await member.request.get("/api/auth/me")).status()).toBe(401);
    expect((await member.request.get(`/api/projects/${project.id}/history`)).status()).toBe(401);
  } finally {
    await member.close();
  }
});
