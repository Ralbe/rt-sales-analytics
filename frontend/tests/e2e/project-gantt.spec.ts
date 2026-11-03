import { expect, test, type Page } from "@playwright/test";

test.use({ timezoneId: "Europe/Moscow" });

import type { ProjectTimeline } from "../../src/lib/timeline-types";
import type { Project, Refs } from "../../src/lib/types";

const manager = { id: 7, full_name: "Мария Продажина" };
const refs: Refs = {
  segments: [{ id: 1, name: "Госсектор" }], services: [{ id: 2, name: "Интернет", group_name: null }],
  managers: [manager], stages: [{ id: "proposal", name: "Предложение", probability: 50 }],
  payment_types: [], customer_stages: [], project_indicators: [], assessment_statuses: [], cost_articles: [],
  cost_types: [], revenue_statuses: [], cost_statuses: [], roles: [],
};
const project: Project = {
  id: 42, name: "Гант с возвратом", description: "", client: { id: 1, name: "Заказчик" },
  segment: refs.segments[0], manager, service: refs.services[0], stage: "proposal", stage_scheme: "legacy",
  amount: "1000.00", cost: "0.00", margin: "1000.00", margin_pct: 100, probability: 50,
  start_date: "2026-01-01", expected_close_date: "2026-12-31", closed_at: null, payment_type: null,
  customer_stage: null, indicator: null, accepted_for_forecast: false, assessment_status: null,
  subsidiary_implementation: false, management_control: false, is_industry_solution: false,
  industry_manager: null, industry_project_number: null, implementation_year: 2026, project_status: null,
  realized_work: "", period_plan: "", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z", financial_entries: [],
};
const timeline: ProjectTimeline = {
  project_id: 42, generated_at: "2026-10-01T00:00:00Z", history_complete: false,
  notes: ["Полная история до первого наблюдения отсутствует."],
  intervals: [
    { stage_key: "customer:8", stage_label: "8. Заключение РД", started_at: "2026-07-01T00:00:00Z", ended_at: "2026-07-02T00:00:00Z", duration_days: 1, start_known: false, end_reason: "stage_change", is_current: false },
    { stage_key: "customer:6", stage_label: "6. Закупка/торги", started_at: "2026-07-02T00:00:00Z", ended_at: "2026-09-30T23:59:30Z", duration_days: 91 - 30 / 86400, start_known: true, end_reason: "stage_change", is_current: false },
    { stage_key: "customer:8", stage_label: "8. Заключение РД", started_at: "2026-09-30T23:59:30Z", ended_at: "2026-10-01T00:00:00Z", duration_days: 30 / 86400, start_known: true, end_reason: "current", is_current: true },
  ],
  finances: [
    { id: 1, kind: "revenue", year: 2026, month: 7, amount: "123456789012.123", vat_included: true, status: "Начислена" },
    { id: 2, kind: "cost", year: 2026, month: 7, amount: "10.001", vat_included: false, status: "Создан резерв" },
  ],
  stage_statistics: [
    { stage_key: "customer:8", stage_label: "8. Заключение РД", completed_visits: 0, average_days: null },
    { stage_key: "customer:6", stage_label: "6. Закупка/торги", completed_visits: 1, average_days: 91 - 30 / 86400 },
  ], archived_periods: [],
};

async function open(page: Page) {
  const state = { timeline: structuredClone(timeline), status: 200, reads: 0 };
  await page.addInitScript(() => {
    const target = window as typeof window & { ganttPrintCalls: number };
    target.ganttPrintCalls = 0;
    window.print = () => { target.ganttPrintCalls++; };
  });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/me") return route.fulfill({ json: { ...manager, email: "test@example.com", role: "analyst" } });
    if (path === "/api/refs") return route.fulfill({ json: refs });
    if (path === "/api/dashboards") return route.fulfill({ json: [] });
    if (path === "/api/projects/42") return route.fulfill({ json: project });
    if (path === "/api/projects/check-name") return route.fulfill({ json: { available: true } });
    if (path === "/api/projects/42/history") return route.fulfill({ json: { items: [], limit: 10, offset: 0, has_more: false } });
    if (path === "/api/projects/42/timeline") {
      state.reads++;
      return route.fulfill({ status: state.status, json: state.status === 200 ? state.timeline : { detail: "Доступ отозван" } });
    }
    return route.fulfill({ status: 404, json: { detail: "Маршрут не найден" } });
  });
  await page.goto("/projects/42");
  await expect(page.getByRole("button", { name: "Показать диаграмму Ганта" })).toBeVisible();
  expect(state.reads).toBe(0);
  await page.getByRole("button", { name: "Показать диаграмму Ганта" }).click();
  return state;
}

test("Гант показывает возвраты, неизвестное начало и финансы на общей шкале", async ({ page }, testInfo) => {
  await open(page);
  const region = page.getByRole("region", { name: "Диаграмма Ганта", exact: true });
  await expect(region).toContainText("История неполная");
  const stages = region.getByRole("table", { name: "Этапы проекта" });
  await expect(stages.getByRole("row")).toHaveCount(4);
  await expect(stages.getByRole("rowheader", { name: "8. Заключение РД", exact: true })).toHaveCount(2);
  await expect(region.locator(".gantt-row-label").filter({ hasText: "Заключение РД" })).toHaveText([
    "8. Заключение РД · начало неизвестно", "8. Заключение РД · текущий",
  ]);
  await expect(stages).toContainText("Неизвестно; наблюдается с 01.07.2026");
  await expect(stages.getByRole("row").filter({ hasText: "Текущий этап" })).toContainText("Менее 1 мин");
  await expect(stages.getByRole("row").filter({ hasText: "Текущий этап" })).toContainText("Продолжается");
  await expect(stages).toContainText("01.07.2026, 03:00:00");
  await expect(stages).toContainText("1 д");
  const finances = region.getByRole("table", { name: "Выручка и затраты" });
  await expect(finances).toContainText("123 456 789 012,123");
  await expect(finances).toContainText("Без НДС");
  await expect(finances).toContainText("Создан резерв");
  const canvas = region.locator(".gantt-canvas");
  await page.setViewportSize({ width: 1440, height: 1400 });
  const monthWidth = await canvas.evaluate((node) => node.getBoundingClientRect().width);
  await region.evaluate((node) => node.scrollIntoView({ block: "start" }));
  await page.screenshot({ path: testInfo.outputPath("gantt-desktop.png") });
  await region.locator(".gantt-scroll").screenshot({ path: testInfo.outputPath("gantt-chart.png") });
  await region.getByLabel("Масштаб").selectOption("year");
  expect(await canvas.evaluate((node) => node.getBoundingClientRect().width)).toBeLessThanOrEqual(monthWidth);
  await expect(region.locator(".gantt-tick")).toHaveText(["2026"]);
  await page.setViewportSize({ width: 390, height: 844 });
  await region.getByRole("heading", { name: "Диаграмма Ганта" }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("gantt-mobile.png") });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test("границы месяцев совпадают с сеткой и финансовыми полосами во всех строках", async ({ page }) => {
  await open(page);
  const region = page.getByRole("region", { name: "Диаграмма Ганта", exact: true });
  await expect(region.locator(".gantt-tick")).toHaveText(["07.2026", "08.2026", "09.2026", "10.2026"]);
  const geometry = await region.evaluate((node) => {
    const ticks = Array.from(node.querySelectorAll(".gantt-tick"), (tick) => tick.getBoundingClientRect());
    const gridRows = Array.from(node.querySelectorAll(".gantt-grid"), (grid) => Array.from(grid.children, (line) => line.getBoundingClientRect().left));
    const money = node.querySelector(".gantt-revenue")!.getBoundingClientRect();
    return { ticks: ticks.map(({ left, width }) => ({ left, width })), gridRows, money: { left: money.left, right: money.right } };
  });
  for (const row of geometry.gridRows) {
    expect(row).toHaveLength(geometry.ticks.length - 1);
    row.forEach((left, index) => expect(Math.abs(left - geometry.ticks[index + 1].left)).toBeLessThan(1));
  }
  expect(Math.abs(geometry.money.left - geometry.ticks[0].left)).toBeLessThan(1);
  expect(Math.abs(geometry.money.right - geometry.ticks[1].left)).toBeLessThan(1);
  expect(geometry.ticks[1].width / geometry.ticks[2].width).toBeCloseTo(31 / 30, 2);
  await region.getByLabel("Масштаб").selectOption("quarter");
  await expect(region.locator(".gantt-tick")).toHaveText(["3 кв. 2026", "4 кв. 2026"]);
  await region.getByLabel("Масштаб").selectOption("day");
  await expect(region.locator(".gantt-tick").first()).toHaveText("01.07.2026");
  await expect(region.locator(".gantt-tick")).toHaveCount(93);
});

test("Гант повторяет загрузку после ошибки и честно показывает отсутствие истории", async ({ page }) => {
  const state = await open(page);
  const region = page.getByRole("region", { name: "Диаграмма Ганта", exact: true });
  await expect(region).toContainText("История неполная");
  state.status = 503;
  await region.getByRole("button", { name: "Обновить Гант" }).click();
  await expect(region.getByRole("alert")).toContainText("Не удалось загрузить диаграмму");
  await expect(region.getByRole("table")).toHaveCount(0);
  state.status = 200;
  state.timeline = { ...timeline, intervals: [], finances: [], stage_statistics: [] };
  await region.getByRole("button", { name: "Обновить Гант" }).click();
  await expect(region).toContainText("Нет данных для диаграммы");
  await expect(region).toContainText("Финансовые строки не заполнены");
});

test("печать Ганта обновляет сохранённые строки и запрещена после отзыва доступа", async ({ page }, testInfo) => {
  const state = await open(page);
  const button = page.getByRole("button", { name: "PDF / Печать Ганта", exact: true });
  await expect(button).toBeEnabled();
  state.timeline.finances[1].amount = "27.005";
  await button.click();
  const surface = page.locator("[data-gantt-print]");
  await expect(surface).toContainText("27,005");
  await expect(surface).toContainText("01.07.2026, 03:00:00");
  await expect(surface).toContainText("Менее 1 мин");
  await expect.poll(() => page.evaluate(() => (window as typeof window & { ganttPrintCalls: number }).ganttPrintCalls)).toBe(1);
  await page.emulateMedia({ media: "print" });
  await expect(surface).toBeVisible();
  await expect(page.locator(".app")).toBeHidden();
  await expect(page.locator("[data-project-print]")).toBeHidden();
  expect((await page.pdf({ preferCSSPageSize: true, path: testInfo.outputPath("gantt-print.pdf") })).length).toBeGreaterThan(1000);
  await page.emulateMedia({ media: "screen" });
  await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
  await expect(surface).toHaveCount(0);
  state.status = 404;
  await button.click();
  await expect(page.getByRole("region", { name: "Диаграмма Ганта", exact: true }).getByRole("alert")).toContainText("Печать недоступна");
  await expect(surface).toHaveCount(0);
  expect(await page.evaluate(() => (window as typeof window & { ganttPrintCalls: number }).ganttPrintCalls)).toBe(1);
});
