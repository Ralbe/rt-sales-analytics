import { createHmac, randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import type { Project, Refs } from "../../src/lib/types";

function totp(secret: string) {
  let bits = "";
  for (const character of secret.replace(/=+$/, "").toUpperCase()) {
    const value = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(character);
    if (value < 0) throw new Error("Некорректный тестовый секрет");
    bits += value.toString(2).padStart(5, "0");
  }
  const bytes = Buffer.from(bits.match(/.{8}/g)?.map((chunk) => parseInt(chunk, 2)) ?? []);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac("sha1", bytes).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

test("мастер-ТЗ: реальные подписи и история, атомарные финансы, печать, архив и восстановление", async ({ page, browser }) => {
  test.setTimeout(120_000);
  const email = process.env.E2E_EMAIL;
  const password = process.env.E2E_PASSWORD;
  const secret = process.env.E2E_TOTP_SECRET;
  if (!email || !password || !secret) throw new Error("Нужен изолированный администратор приёмки");
  await page.addInitScript(() => { window.print = () => undefined; });
  const login = await page.request.post("/api/auth/login", { data: { email, password } });
  expect(login.status()).toBe(200);
  const challenge = await login.json();
  expect((await page.request.post("/api/auth/2fa", {
    data: { mfa_token: challenge.mfa_token, code: totp(secret) },
  })).status()).toBe(200);
  const suffix = randomUUID();
  const memberPassword = randomUUID();
  const memberEmail = `master-member-${suffix}@example.test`;
  const account = await page.request.post("/api/users", { data: {
    email: memberEmail, full_name: "Пользователь приёмки архива", role: "user", password: memberPassword,
  } });
  expect(account.status()).toBe(201);
  const member = await account.json();
  const refs = await (await page.request.get("/api/refs")).json() as Refs;
  const clients = await (await page.request.get("/api/clients?limit=1")).json();
  const rows = [true, false].map((vat) => ({ kind: "revenue", year: 2026, month: vat ? 10 : 11,
    amount: vat ? "123.456" : "0.001", vat_included: vat, status_id: refs.revenue_statuses[0].id }));
  const name = `Приёмка мастер-ТЗ ${suffix}`;
  const createdResponse = await page.request.post("/api/projects", { data: {
    name, client_id: clients[0].id, service_id: refs.services[0].id, manager_id: member.id,
    stage: "proposal", probability: 50, amount: "1234.56", cost: "0.01",
    start_date: "2026-10-01", expected_close_date: "2026-12-31", implementation_year: 2026,
    project_status: "Я".repeat(1000), realized_work: "Сделано", period_plan: "Планы", financial_entries: rows,
  } });
  expect(createdResponse.status()).toBe(201);
  const project = await createdResponse.json() as Project;
  expect(project.financial_entries.map((row) => row.amount)).toEqual(["123.456", "0.001"]);
  expect(project.financial_entries.map((row) => row.vat_included)).toEqual([true, false]);
  const firstLabel = `Коммерческая инициатива ${suffix.slice(0, 8)}`;
  const secondLabel = `Наименование инициативы ${suffix.slice(0, 8)}`;
  const other = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  try {
    const memberLogin = await other.request.post("/api/auth/login", { data: { email: memberEmail, password: memberPassword } });
    expect(memberLogin.status()).toBe(200);
    const memberChallenge = await memberLogin.json();
    expect(memberChallenge.setup_required).toBe(true);
    expect((await other.request.post("/api/auth/2fa", { data: {
      mfa_token: memberChallenge.mfa_token, code: totp(memberChallenge.secret),
    } })).status()).toBe(200);
    expect((await other.request.get(`/api/projects/${project.id}`)).status()).toBe(200);
    expect((await other.request.put("/api/project-fields/name", { data: { label: "Запрещено" } })).status()).toBe(403);
    await page.goto("/settings/project-fields");
    const labelInput = page.getByRole("textbox", { name: "Подпись: Название проекта", exact: true });
    await labelInput.fill(firstLabel);
    await labelInput.locator("xpath=ancestor::tr").getByRole("button", { name: "Сохранить", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Подпись сохранена" })).toBeVisible();
    await page.goto(`/projects/${project.id}`);
    const nameInput = page.getByLabel(firstLabel, { exact: true });
    await expect(nameInput).toHaveValue(name);
    await nameInput.fill(`${name} — обновлено`);
    const savedResponse = page.waitForResponse((response) =>
      response.url().endsWith(`/api/projects/${project.id}`) && response.request().method() === "PUT");
    await page.getByRole("button", { name: "Сохранить изменения", exact: true }).click();
    expect((await savedResponse).status()).toBe(200);
    await expect(page.getByText(/Сохранено в/)).toBeVisible();
    const rename = await page.request.put("/api/project-fields/name", { data: { label: secondLabel } });
    expect(rename.status()).toBe(200);
    await page.reload();
    await expect(page.getByLabel(secondLabel, { exact: true })).toHaveValue(`${name} — обновлено`);
    const historyResponse = await page.request.get(`/api/projects/${project.id}/history`);
    expect(historyResponse.status()).toBe(200);
    const history = await historyResponse.json();
    const creation = history.items.find((item: { action: string }) => item.action === "create");
    const update = history.items.find((item: { action: string }) => item.action === "update");
    expect(creation.changes.find((change: { field: string }) => change.field === "name").label).toBe("Название проекта");
    expect(update.changes.find((change: { field: string }) => change.field === "name").label).toBe(firstLabel);
    await page.getByRole("button", { name: "PDF / Печать карточки", exact: true }).click();
    const print = page.locator("[data-project-print]");
    await expect(print).toHaveAttribute("data-ready", "true");
    await expect(print.locator('[data-project-field="name"] dt')).toHaveText(secondLabel);
    await expect(print).toContainText("123.456");
    await expect(print).toContainText("0.001");
    await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
    const archiveResponse = page.waitForResponse((response) => response.url().endsWith(`/api/projects/${project.id}/archive`));
    page.once("dialog", (dialog) => { void dialog.accept(); });
    await page.getByRole("button", { name: "В архив", exact: true }).click();
    expect((await archiveResponse).status()).toBe(200);
    await expect(page.getByLabel(secondLabel, { exact: true })).toBeDisabled();
    await expect(page.getByRole("status").filter({ hasText: "Проект в архиве" })).toBeVisible();
    expect((await other.request.get(`/api/projects/${project.id}`)).status()).toBe(404);
    expect((await other.request.get(`/api/projects/${project.id}/history`)).status()).toBe(404);
    expect((await other.request.post(`/api/projects/${project.id}/restore`)).status()).toBe(403);
    const active = await (await page.request.get(`/api/projects?q=${encodeURIComponent(name)}`)).json();
    expect(active.items).toHaveLength(0);
    const archived = await (await page.request.get(`/api/projects?archived=true&q=${encodeURIComponent(name)}`)).json();
    expect(archived.items.map((item: Project) => item.id)).toEqual([project.id]);
    const restoreResponse = page.waitForResponse((response) => response.url().endsWith(`/api/projects/${project.id}/restore`));
    await page.getByRole("button", { name: "Восстановить проект", exact: true }).click();
    expect((await restoreResponse).status()).toBe(200);
    await expect(page.getByLabel(secondLabel, { exact: true })).toBeEnabled();
    const restored = await (await page.request.get(`/api/projects/${project.id}`)).json() as Project;
    expect(restored.created_at).toBe(project.created_at);
    expect(restored.financial_entries).toEqual(project.financial_entries);
    expect((await other.request.get(`/api/projects/${project.id}`)).status()).toBe(200);
    const xlsx = await page.request.get(`/api/projects/export.xlsx?q=${encodeURIComponent(name)}`);
    expect(xlsx.status()).toBe(200);
    expect(xlsx.headers()["content-type"]).toContain("spreadsheetml");
    expect((await xlsx.body()).subarray(0, 2).toString()).toBe("PK");
  } finally {
    await page.request.delete("/api/project-fields/name");
    await other.close();
  }
});
