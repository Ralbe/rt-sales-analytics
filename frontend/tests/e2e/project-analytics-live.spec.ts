import { createHmac, randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import type { ProjectTimeline } from "../../src/lib/timeline-types";
import type { Project, Refs, WeightedRevenueResponse } from "../../src/lib/types";

function totp(secret: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, value = 0;
  const bytes: number[] = [];
  for (const character of secret.replace(/=+$/, "").toUpperCase()) {
    const digit = alphabet.indexOf(character);
    if (digit < 0) throw new Error("Некорректный тестовый секрет TOTP");
    value = (value << 5) | digit;
    bits += 5;
    if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; value &= (1 << bits) - 1; }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac("sha1", Buffer.from(bytes)).update(counter).digest();
  return String((digest.readUInt32BE(digest[digest.length - 1] & 15) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

test("настоящий API: новый проект, переход этапа, Гант и взвешенная выручка", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const { E2E_EMAIL: email, E2E_PASSWORD: password, E2E_TOTP_SECRET: secret } = process.env;
  test.skip(!email || !password || !secret, "Нужна изолированная E2E учётная запись администратора");

  const login = await page.request.post("/api/auth/login", { data: { email, password } });
  expect(login.status()).toBe(200);
  const challenge = await login.json() as { mfa_token: string };
  const mfa = await page.request.post("/api/auth/2fa", { data: { mfa_token: challenge.mfa_token, code: totp(secret!) } });
  expect(mfa.status()).toBe(200);
  const refsResponse = await page.request.get("/api/refs");
  expect(refsResponse.status()).toBe(200);
  const refs = await refsResponse.json() as Refs;
  const clientsResponse = await page.request.get("/api/clients?limit=1");
  expect(clientsResponse.status()).toBe(200);
  const clients = await clientsResponse.json() as { id: number }[];
  const initialStage = refs.customer_stages[0];
  const finalStage = refs.customer_stages.find((stage) => stage.id !== initialStage.id && stage.probability > 0)!;
  expect(finalStage).toBeDefined();
  expect(clients.length).toBeGreaterThan(0);
  const today = new Date().toISOString().slice(0, 10);
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const name = `E2E Гант и выручка ${randomUUID()}`;
  const payload = {
    name, client_id: clients[0].id, service_id: refs.services[0].id,
    customer_stage_id: initialStage.id, amount: "999.00", cost: "0.00", start_date: today, expected_close_date: today,
    financial_entries: [
      { kind: "revenue", year, month, amount: "1000.000", vat_included: true, status_id: refs.revenue_statuses[0].id },
      { kind: "cost", year, month, amount: "5.000", vat_included: false, status_id: refs.cost_statuses[0].id, article_id: refs.cost_articles[0].id, cost_type_id: refs.cost_types[0].id },
    ],
  };
  const summaryBefore = await page.request.get("/api/analytics/weighted-revenue");
  expect(summaryBefore.status()).toBe(200);
  const before = await summaryBefore.json() as WeightedRevenueResponse;
  let id: number | undefined;
  try {
    const created = await page.request.post("/api/projects", { data: payload });
    expect(created.status(), await created.text()).toBe(201);
    id = (await created.json() as Project).id;
    const changed = await page.request.put(`/api/projects/${id}`, { data: { ...payload, customer_stage_id: finalStage.id } });
    expect(changed.status(), await changed.text()).toBe(200);
    const saved = await changed.json() as Project;
    expect(saved.probability).toBe(finalStage.probability);
    const expectedWeighted = (1000000 * finalStage.probability / 100).toFixed(2);
    expect(saved.revenue_projection?.buckets).toEqual([
      expect.objectContaining({ basis: "with_vat", revenue_rub: "1000000.00", weighted_revenue_rub: expectedWeighted }),
    ]);

    const timelineResponse = await page.request.get(`/api/projects/${id}/timeline`);
    expect(timelineResponse.status()).toBe(200);
    const timeline = await timelineResponse.json() as ProjectTimeline;
    expect(timeline.history_complete).toBe(true);
    expect(timeline.intervals).toHaveLength(2);
    expect(timeline.intervals[0]).toMatchObject({ stage_label: initialStage.name, start_known: true, end_reason: "stage_change" });
    expect(timeline.intervals[1]).toMatchObject({ stage_label: finalStage.name, is_current: true });
    expect(timeline.stage_statistics.find((stage) => stage.stage_key === `customer:${initialStage.id}`)?.completed_visits).toBe(1);
    expect(timeline.finances).toHaveLength(2);

    await page.goto(`/projects/${id}`);
    await page.getByRole("button", { name: "Показать диаграмму Ганта" }).click();
    const gantt = page.getByRole("region", { name: "Диаграмма Ганта", exact: true });
    const stages = gantt.getByRole("table", { name: "Этапы проекта" });
    await expect(stages.getByRole("row")).toHaveCount(3);
    await expect(stages).toContainText(initialStage.name);
    await expect(stages).toContainText(finalStage.name);
    await expect(gantt.getByRole("table", { name: "Выручка и затраты" })).toContainText("1 000,000");
    await gantt.getByRole("heading", { name: "Диаграмма Ганта" }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("gantt-real-api.png") });

    const registry = await page.request.get(`/api/projects?q=${encodeURIComponent(name)}`);
    expect(registry.status()).toBe(200);
    const registryData = await registry.json() as { items: Project[] };
    expect(registryData.items).toHaveLength(1);
    expect(registryData.items[0].revenue_projection).toEqual(saved.revenue_projection);
    await page.goto("/projects");
    await page.getByPlaceholder("Поиск: проект, клиент или ИНН").fill(name);
    const registryRow = page.getByRole("row").filter({ hasText: name });
    await expect(registryRow).toHaveCount(1);
    await expect(registryRow).toContainText(`${Number(expectedWeighted).toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽`);
    const summaryAfter = await page.request.get("/api/analytics/weighted-revenue");
    expect(summaryAfter.status()).toBe(200);
    const after = await summaryAfter.json() as WeightedRevenueResponse;
    const vatBefore = before.buckets.find((bucket) => bucket.basis === "with_vat");
    const vatAfter = after.buckets.find((bucket) => bucket.basis === "with_vat")!;
    expect(Number(vatAfter.revenue_rub) - Number(vatBefore?.revenue_rub ?? 0)).toBeCloseTo(1000000, 2);
    expect(Number(vatAfter.weighted_revenue_rub) - Number(vatBefore?.weighted_revenue_rub ?? 0)).toBeCloseTo(Number(expectedWeighted), 2);
    await page.goto("/analytics");
    await expect(page.getByRole("heading", { name: "Выручка и сроки этапов" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Выручка с учётом вероятности" }).getByRole("table")).toBeVisible();
    await expect(page.getByRole("region", { name: "Среднее время на этапах" })).toContainText(initialStage.name);
    await page.screenshot({ path: testInfo.outputPath("analytics-real-api.png") });
  } finally {
    if (id !== undefined) expect((await page.request.post(`/api/projects/${id}/archive`)).status()).toBe(200);
  }
});
