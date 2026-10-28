import { createHmac, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";

const runFile = promisify(execFile);

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

// Настоящий API и PostgreSQL из E2E CI; маршруты запросов не подменяются.
test("M-01 и M-02: отчёт от конструктора до витрины, снимка, XLSX и печати", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const email = process.env.E2E_EMAIL;
  const password = process.env.E2E_PASSWORD;
  const secret = process.env.E2E_TOTP_SECRET;
  if (!email || !password || !secret) throw new Error("Для E2E нужны E2E_EMAIL, E2E_PASSWORD и E2E_TOTP_SECRET изолированного администратора");

  await page.goto("/login");
  await page.evaluate(() => window.localStorage.clear());
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Пароль").fill(password);
  const loginResponse = page.waitForResponse((response) => response.url().endsWith("/api/auth/login") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Продолжить" }).click();
  const challenge = await loginResponse;
  expect(challenge.status()).toBe(200);
  expect(await challenge.json()).toMatchObject({ setup_required: false, secret: null });
  await page.getByLabel("Код из приложения").fill(totp(secret));
  const mfaResponse = page.waitForResponse((response) => response.url().endsWith("/api/auth/2fa") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Войти" }).click();
  expect((await mfaResponse).status()).toBe(200);
  await page.waitForURL((url) => url.pathname === "/projects");

  const suffix = randomUUID();
  const projectName = `E2E-report-project-${suffix}`;
  const title = `E2E отчёт ${suffix}`;
  let projectId: number | undefined;
  let reportId: number | undefined;
  let snapshotId: string | undefined;
  try {
    const [refsResponse, clientsResponse, fieldsResponse] = await Promise.all([
      page.request.get("/api/refs"), page.request.get("/api/clients?limit=1"), page.request.get("/api/report-fields"),
    ]);
    expect(refsResponse.status()).toBe(200);
    expect(clientsResponse.status()).toBe(200);
    expect(fieldsResponse.status()).toBe(200);
    const refs = await refsResponse.json() as { services: { id: number }[]; customer_stages: { id: number }[] };
    const clients = await clientsResponse.json() as { id: number }[];
    const fields = await fieldsResponse.json() as { fields: { id: string; label: string; operators: string[] }[] };
    const projectField = fields.fields.find((field) => field.id === "project.name");
    expect(projectField).toBeDefined();
    expect(projectField!.operators).toContain("eq");
    expect(clients.length && refs.services.length && refs.customer_stages.length).toBeGreaterThan(0);
    const today = new Date().toISOString().slice(0, 10);
    const createdProject = await page.request.post("/api/projects", { data: {
      name: projectName, client_id: clients[0].id, service_id: refs.services[0].id,
      customer_stage_id: refs.customer_stages[0].id, amount: "1000.00", cost: "0.00",
      start_date: today, expected_close_date: today,
    } });
    expect(createdProject.status()).toBe(201);
    projectId = (await createdProject.json() as { id: number }).id;

    await page.getByRole("navigation").getByRole("link", { name: "+ Конструктор отчётов" }).click();
    await expect(page.getByRole("heading", { name: "Новый табличный отчёт" })).toBeVisible();
    await page.getByLabel("Название отчёта").fill(title);
    await page.getByLabel(projectField!.label, { exact: true }).check();
    await page.getByRole("button", { name: "Добавить фильтр" }).click();
    await page.getByLabel("Поле фильтра 1").selectOption("project.name");
    await page.getByLabel("Оператор 1").selectOption("eq");
    await page.getByLabel("Значение 1").fill(projectName);
    const saveResponse = page.waitForResponse((response) => response.url().endsWith("/api/reports") && response.request().method() === "POST");
    await page.getByRole("button", { name: "Сохранить отчёт" }).click();
    const savedResponse = await saveResponse;
    expect(savedResponse.status()).toBe(201);
    const saved = await savedResponse.json() as { id: number; version: number; published: boolean; title: string; definition: unknown };
    reportId = saved.id;
    expect(saved).toMatchObject({ title, published: false, definition: {
      grain: "project", columns: ["project.name"], filters: [{ field: "project.name", operator: "eq", value: projectName }],
    } });
    await page.waitForURL((url) => url.pathname === `/reports/${reportId}`);
    await page.reload();
    await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
    await expect(page.getByText("Личный отчёт", { exact: true })).toBeVisible();
    const persistedResponse = await page.request.get(`/api/reports/${reportId}`);
    expect(persistedResponse.status()).toBe(200);
    expect(await persistedResponse.json()).toMatchObject({ id: reportId, title, definition: saved.definition });

    const publicationRequest = page.waitForResponse((response) => response.url().endsWith(`/api/reports/${reportId}/publish`) && response.request().method() === "POST");
    await page.getByRole("button", { name: "Опубликовать", exact: true }).click();
    const publication = await publicationRequest;
    expect(publication.status()).toBe(200);
    expect(await publication.json()).toMatchObject({ id: reportId, published: true, version: saved.version + 1 });
    await expect(page.getByText("Опубликованный отчёт", { exact: true })).toBeVisible();

    // Находим страницу через реальную выдачу, затем переключаем её в интерфейсе витрины.
    let targetOffset = -1;
    for (let offset = 0; targetOffset < 0; offset += 20) {
      const response = await page.request.get(`/api/reports?published=true&offset=${offset}&limit=20`);
      expect(response.status()).toBe(200);
      const batch = await response.json() as { items: { id: number }[]; total: number };
      if (batch.items.some((item) => item.id === reportId)) targetOffset = offset;
      else if (offset + 20 >= batch.total) throw new Error("Опубликованный отчёт отсутствует в реальной выдаче");
    }
    await page.getByRole("navigation").getByRole("link", { name: "Готовые отчёты" }).click();
    const main = page.getByRole("main");
    await expect(main.getByRole("heading", { name: "Готовые отчёты" })).toBeVisible();
    for (let offset = 0; offset < targetOffset; offset += 20) {
      const next = main.getByRole("button", { name: "Вперёд" });
      await expect(next).toBeEnabled();
      await next.click();
      await expect(main.getByText(`Страница ${(offset + 20) / 20 + 1}`, { exact: true })).toBeVisible();
    }
    await main.getByRole("link", { name: `Открыть отчёт «${title}»` }).click();
    await page.waitForURL((url) => url.pathname === `/reports/${reportId}`);
    await expect(main.getByRole("heading", { name: title, exact: true })).toBeVisible();
    await expect(main.getByText("Опубликованный отчёт", { exact: true })).toBeVisible();
    const runResponse = page.waitForResponse((response) => response.url().endsWith(`/api/reports/${reportId}/run`) && response.request().method() === "POST");
    await main.getByRole("button", { name: "Выполнить отчёт" }).click();
    const run = await runResponse;
    expect(run.status()).toBe(200);
    const snapshot = await run.json() as { snapshot_id: string; total: number; report_version: number };
    snapshotId = snapshot.snapshot_id;
    expect(snapshot).toMatchObject({ total: 1, report_version: saved.version + 1 });
    await page.waitForURL((url) => url.pathname === `/reports/snapshots/${snapshotId}`);
    await expect(main.getByRole("columnheader", { name: projectField!.label, exact: true })).toBeVisible();
    await expect(main.getByRole("cell", { name: projectName, exact: true })).toBeVisible();
    await expect(main.getByRole("status").filter({ hasText: "Всего строк: 1." })).toBeVisible();

    const downloadPromise = page.waitForEvent("download");
    await main.getByRole("button", { name: "Скачать XLSX" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("report.xlsx");
    const downloadPath = testInfo.outputPath("report.xlsx");
    await download.saveAs(downloadPath);
    // openpyxl уже установлен для backend в CI: проверяем содержимое, а не только ZIP-сигнатуру.
    const script = "import json,openpyxl,sys; w=openpyxl.load_workbook(sys.argv[1],read_only=True,data_only=True); print(json.dumps(list(w.active.values))); w.close()";
    const { stdout } = await runFile("python", ["-c", script, downloadPath]);
    expect(JSON.parse(stdout)).toEqual([[projectField!.label], [projectName]]);

    // Перехват диалога печати не подменяет API или печатную поверхность.
    await page.evaluate(() => { window.print = () => { document.body.dataset.reportPrintCalled = "yes"; }; });
    await main.getByRole("button", { name: "PDF / Печать всех строк" }).click();
    const printSurface = page.locator(".report-print-surface");
    await expect(printSurface.getByRole("cell", { name: projectName, exact: true })).toBeVisible();
    await expect(page.locator("body")).toHaveAttribute("data-report-print-called", "yes");
    await page.emulateMedia({ media: "print" });
    const pdf = await page.pdf({ path: testInfo.outputPath("report-live.pdf"), format: "A4", printBackground: true });
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    await page.emulateMedia({ media: "screen" });
    await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
  } finally {
    // Удаляются только созданные этим сценарием сущности; проект переводится в архив.
    if (snapshotId) expect((await page.request.delete(`/api/report-snapshots/${snapshotId}`)).status()).toBe(204);
    if (reportId) {
      const current = await page.request.get(`/api/reports/${reportId}`);
      expect(current.status()).toBe(200);
      const { version } = await current.json() as { version: number };
      expect((await page.request.delete(`/api/reports/${reportId}?version=${version}`)).status()).toBe(204);
    }
    if (projectId) expect((await page.request.post(`/api/projects/${projectId}/archive`)).status()).toBe(200);
  }
});
