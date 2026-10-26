import { expect, test, type Page, type Route } from "@playwright/test";

import type { AnalyticsScope, Dashboard, Refs, User, Widget } from "../../src/lib/types";

const user: User = { id: 7, email: "pdf@example.test", full_name: "Мария Продажина", role: "analyst" };
const refs: Refs = {
  segments: [{ id: 1, name: "Крупный бизнес" }, { id: 2, name: "Государственные заказчики" }],
  services: [{ id: 3, name: "Защищённый интернет", group_name: null }],
  managers: [{ id: 7, full_name: user.full_name }],
  stages: [], payment_types: [], assessment_statuses: [], project_indicators: [], customer_stages: [],
  cost_articles: [], cost_types: [], revenue_statuses: [], cost_statuses: [], roles: [],
};
const widget = (id: string, type: Widget["type"], title: string, config: Widget["config"], y = 0): Widget => ({
  id, type, title, config, x: 0, y, w: 6, h: 4,
});
const widgets = [
  widget("kpi", "kpi", "Объём воронки", { metric: "funnel" }),
  widget("trend", "trend", "Динамика продаж", { metric: "funnel", chart: "line", weeks: 8, horizon: 21 }, 4),
  widget("breakdown", "breakdown", "Разбивка по сегментам", { metric: "funnel", chart: "donut", group_by: "segment" }, 8),
  widget("table", "breakdown", "Полная таблица сегментов", { metric: "funnel", chart: "table", group_by: "segment" }, 12),
  widget("projects", "projects", "Проекты в работе", { limit: 20 }, 16),
];
const dashboard: Dashboard = {
  id: 41, name: "Продажи — Волгоград", owner: { id: user.id, full_name: user.full_name },
  widgets, filters: { segment_ids: [1], service_ids: [3], manager_ids: [7] },
  is_shared: false, editable: true, updated_at: "2026-10-24T12:00:00Z",
};
const breakdown = {
  metric: "funnel", group_by: "segment",
  items: Array.from({ length: 90 }, (_, index) => ({
    key: String(index), label: `Сегмент № ${index + 1}: промышленность и связь Волгоградской области`, value: (index + 1) * 1000,
  })),
};

async function openDashboard(page: Page, options: {
  widgets?: Widget[];
  role?: User["role"];
  editable?: boolean;
  trendGate?: Promise<void>;
  trendError?: boolean;
  refsError?: boolean;
  refs?: () => Refs;
  scope?: () => AnalyticsScope;
} = {}) {
  const requests: { path: string; method: string }[] = [];
  const current = { ...dashboard, widgets: options.widgets ?? widgets, editable: options.editable ?? true };
  await page.addInitScript(() => {
    const state = window as typeof window & { printCalls: number; printReady: string | undefined };
    state.printCalls = 0;
    window.print = () => {
      state.printCalls += 1;
      state.printReady = document.querySelector<HTMLElement>("[data-dashboard-print]")?.dataset.ready;
    };
  });
  await page.route("**/api/**", async (route: Route) => {
    const url = new URL(route.request().url());
    requests.push({ path: `${url.pathname}${url.search}`, method: route.request().method() });
    if (route.request().method() !== "GET") {
      await route.fulfill({ status: 405, json: { detail: "Печать не должна изменять данные" } });
      return;
    }
    switch (url.pathname) {
      case "/api/auth/me": await route.fulfill({ json: { ...user, role: options.role ?? user.role } }); break;
      case "/api/refs": await route.fulfill(options.refsError ? { status: 500, json: { detail: "Ошибка справочников" } } : { json: options.refs?.() ?? refs }); break;
      case "/api/dashboards": await route.fulfill({ json: [current] }); break;
      case "/api/dashboards/41": await route.fulfill({ json: current }); break;
      case "/api/analytics/kpi": await route.fulfill({ json: {
        ...options.scope?.(),
        as_of: "2026-10-24", previous_as_of: "2025-10-24",
        items: [{ key: "funnel", title: "Объём воронки", unit: "rub", value: 1250000, previous: 1000000, delta_pct: 25 }],
      } }); break;
      case "/api/analytics/trend":
        await options.trendGate;
        await route.fulfill(options.trendError ? { status: 500, json: { detail: "Ошибка аналитики" } } : { json: {
          ...options.scope?.(),
          metric: "funnel", method: "linear",
          history: [{ date: "2026-08-29", value: 1100000 }, { date: "2026-10-24", value: 1250000 }],
          forecast: [{ date: "2026-10-25", value: 1260000, lower: 1200000, upper: 1320000 }, { date: "2026-11-14", value: 1400000, lower: 1300000, upper: 1500000 }],
        } }); break;
      case "/api/analytics/breakdown": await route.fulfill({ json: { ...breakdown, ...options.scope?.() } }); break;
      case "/api/projects": await route.fulfill({ json: {
        ...options.scope?.(),
        page: 1, size: 20, total: 20,
        items: Array.from({ length: 20 }, (_, index) => ({
          id: index + 1, name: `Проект № ${index + 1} — модернизация региональной инфраструктуры связи`,
          client: { id: 1, name: "ООО «Волгоградская промышленная компания»" }, manager: { id: 7, full_name: user.full_name }, amount: "1250000",
        })),
      } }); break;
      default: await route.fulfill({ status: 404, json: { detail: "Неожиданный запрос" } });
    }
  });
  await page.goto("/dashboards/41");
  await expect(page.getByRole("button", { name: "PDF / Печать", exact: true })).toBeVisible();
  return requests;
}

async function preparePrint(page: Page) {
  const button = page.getByRole("button", { name: "PDF / Печать", exact: true });
  await expect(button).toBeEnabled();
  await button.click();
  await expect.poll(() => page.evaluate(() => (window as typeof window & { printCalls: number }).printCalls)).toBe(1);
  await expect(page.locator("[data-dashboard-print]")).toHaveAttribute("data-ready", "true");
  expect(await page.evaluate(() => (window as typeof window & { printReady: string }).printReady)).toBe("true");
  return page.locator("[data-dashboard-print]");
}

test("подписи виджета проектов обновляются из refs, а PDF сохраняет снимок без запросов при печати", async ({ page }, testInfo) => {
  let labels = { name: "Инициатива", client_id: "Заказчик", manager_id: "Куратор", amount: "Договор" };
  const requests = await openDashboard(page, { widgets: [widgets[4]], refs: () => ({ ...refs, project_field_labels: labels }) });
  const liveHeaders = page.locator(".widget .widget-table thead th");
  const firstHeaders = ["Инициатива", "Заказчик", "Куратор", "Договор, ₽"];
  await expect(liveHeaders).toHaveText(firstHeaders);
  const projectRow = page.locator(".widget .widget-table tbody tr").first();
  await expect(projectRow).toContainText("Проект № 1 — модернизация региональной инфраструктуры связи");
  await expect(projectRow).toContainText("ООО «Волгоградская промышленная компания»");
  await expect(projectRow).toContainText(user.full_name);
  const beforeFirstPrint = requests.length;
  const report = await preparePrint(page);
  await expect(report.locator('[data-widget-id="projects"] thead th')).toHaveText(firstHeaders);
  expect(requests.length).toBe(beforeFirstPrint);

  labels = { name: "Инициатива обновлена", client_id: "Контрагент", manager_id: "Ведущий проекта", amount: "Стоимость договора" };
  // Возврат соединения обновляет устаревшие refs через настоящий React Query.
  await page.evaluate(() => {
    const now = Date.now;
    Date.now = () => now() + 301_000;
    window.dispatchEvent(new Event("offline"));
    window.dispatchEvent(new Event("online"));
  });
  await expect.poll(() => requests.filter((request) => request.path === "/api/refs").length).toBe(2);
  const updatedHeaders = ["Инициатива обновлена", "Контрагент", "Ведущий проекта", "Стоимость договора, ₽"];
  await expect(liveHeaders).toHaveText(updatedHeaders);
  await expect(report.locator('[data-widget-id="projects"] thead th')).toHaveText(firstHeaders);
  await expect(report.locator('[data-widget-id="projects"] tbody tr').first()).toContainText(user.full_name);
  const beforePdf = requests.length;
  await page.emulateMedia({ media: "print" });
  const pdfPath = testInfo.outputPath("dashboard-labels-frozen.pdf");
  const pdf = await page.pdf({ path: pdfPath, preferCSSPageSize: true, printBackground: true });
  expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
  expect(requests.length).toBe(beforePdf);
  await testInfo.attach("Снимок подписей до refetch refs", { path: pdfPath, contentType: "application/pdf" });

  await page.emulateMedia({ media: "screen" });
  await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
  const printButton = page.getByRole("button", { name: "PDF / Печать", exact: true });
  await expect(printButton).toBeEnabled();
  const beforeSecondPrint = requests.length;
  await printButton.click();
  await expect.poll(() => page.evaluate(() => (window as typeof window & { printCalls: number }).printCalls)).toBe(2);
  await expect(report.locator('[data-widget-id="projects"] thead th')).toHaveText(updatedHeaders);
  await expect(report.locator('[data-widget-id="projects"] tbody tr').first()).toContainText("ООО «Волгоградская промышленная компания»");
  expect(requests.length).toBe(beforeSecondPrint);
  expect(requests.every((request) => request.method === "GET")).toBeTruthy();
});

test("печать ждёт все данные и не печатает незагруженный дашборд через меню браузера", async ({ page }) => {
  let release!: () => void;
  const trendGate = new Promise<void>((resolve) => { release = resolve; });
  await openDashboard(page, { trendGate });
  try {
    await expect(page.getByRole("button", { name: "PDF / Печать" })).toBeDisabled();
    await expect(page.locator("#dashboard-print-hint")).toContainText("после загрузки виджета «Динамика продаж»");
    await page.emulateMedia({ media: "print" });
    await expect(page.locator(".sidebar")).toBeHidden();
    const guard = await page.locator("[data-dashboard-print]").evaluate((node) => getComputedStyle(node, "::before").content);
    expect(guard).toContain("Печать недоступна");
    await page.emulateMedia({ media: "screen" });
  } finally { release(); }
  await expect(page.getByRole("button", { name: "PDF / Печать" })).toBeEnabled();
});

test("ошибка одного виджета запрещает печать и объясняет причину", async ({ page }) => {
  await openDashboard(page, { trendError: true });
  await expect(page.getByRole("button", { name: "PDF / Печать" })).toBeDisabled();
  await expect(page.locator("#dashboard-print-hint")).toContainText("ошибка данных виджета «Динамика продаж»");
  expect(await page.evaluate(() => (window as typeof window & { printCalls: number }).printCalls)).toBe(0);
});

test("повторная загрузка текущего фильтра блокирует печать даже при наличии данных в кэше", async ({ page }) => {
  await openDashboard(page, { widgets: [widgets[0]] });
  const button = page.getByRole("button", { name: "PDF / Печать" });
  await expect(button).toBeEnabled();
  const displayedValue = await page.locator(".widget .value").innerText();
  await page.getByRole("button", { name: "Крупный бизнес ▾", exact: true }).click();
  await page.getByLabel("Государственные заказчики", { exact: true }).check();
  await expect(button).toBeEnabled();
  await page.evaluate(() => {
    const now = Date.now;
    Date.now = () => now() + 31_000;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/analytics/kpi?**", async (route) => {
    await gate;
    await route.fulfill({ status: 500, json: { detail: "Ошибка обновления" } });
  });
  try {
    await page.getByLabel("Государственные заказчики", { exact: true }).uncheck();
    await expect(button).toBeDisabled();
    await expect(page.locator("#dashboard-print-hint")).toContainText("после загрузки виджета");
    await expect(page.locator(".widget .value")).toHaveText(displayedValue);
  } finally { release(); }
  await expect(page.locator("#dashboard-print-hint")).toContainText("ошибка данных виджета");
  await expect(button).toBeDisabled();
});

test("ошибка справочников запрещает отчёт без подписей фильтров", async ({ page }) => {
  await openDashboard(page, { refsError: true, widgets: [widgets[0]] });
  await expect(page.getByRole("button", { name: "PDF / Печать" })).toBeDisabled();
  await expect(page.locator("#dashboard-print-hint")).toContainText("не удалось загрузить справочники или профиль");
});

test("неподготовленные шрифты запрещают неполный PDF, после ошибки можно повторить", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(document.fonts, "status", { configurable: true, get: () => "loading" });
  });
  await openDashboard(page, { widgets: [widgets[1]] });
  const button = page.getByRole("button", { name: "PDF / Печать" });
  await expect(button).toBeEnabled();
  await button.click();
  await expect(page.locator("#dashboard-print-hint")).toHaveText("Готовим печатный снимок…");
  await expect(button).toBeDisabled();
  expect(await page.evaluate(() => (window as typeof window & { printCalls: number }).printCalls)).toBe(0);
  await page.evaluate(() => {
    const now = Date.now;
    Date.now = () => now() + 16_000;
  });
  await expect(page.locator("#dashboard-print-hint")).toContainText("Не удалось подготовить диаграммы или шрифты");
  await expect(page.locator("[data-dashboard-print]")).toHaveAttribute("data-ready", "false");
  expect(await page.evaluate(() => (window as typeof window & { printCalls: number }).printCalls)).toBe(0);
  await page.evaluate(() => { Reflect.deleteProperty(document.fonts, "status"); });
  await preparePrint(page);
});

test("снимок содержит текущие несохранённые настройки, подписи фильтров и периоды без запросов и сохранения", async ({ page }) => {
  const requests = await openDashboard(page);
  await page.getByLabel("Название дашборда").fill("Несохранённый отчёт — Кириллица");
  await page.getByRole("button", { name: "Крупный бизнес ▾", exact: true }).click();
  await page.getByLabel("Государственные заказчики", { exact: true }).check();
  await page.getByRole("button", { name: "Сегменты: 2 ▾", exact: true }).click();
  const trendCard = page.locator(".widget").filter({ has: page.locator(".title", { hasText: "Динамика продаж" }) });
  await trendCard.getByRole("button", { name: "Действия с виджетом" }).click();
  await page.getByRole("button", { name: "Настроить…", exact: true }).click();
  const modal = page.locator(".modal");
  await modal.locator(".field").filter({ hasText: "Период истории" }).locator("select").selectOption("12");
  await modal.locator(".field").filter({ hasText: "Горизонт прогноза" }).locator("select").selectOption("30");
  await modal.locator(".field").filter({ hasText: "Заголовок" }).locator("input").fill("Текущая динамика");
  await modal.getByRole("button", { name: "Применить", exact: true }).click();
  await expect(page.getByRole("button", { name: "PDF / Печать" })).toBeEnabled();
  const before = requests.length;
  const report = await preparePrint(page);
  await expect(report.locator("h1")).toHaveText("Несохранённый отчёт — Кириллица");
  await expect(report).toContainText(/Дата формирования: \d{2}\.\d{2}\.\d{4}/);
  await expect(report.locator("dl")).toContainText("Сегменты:Крупный бизнес, Государственные заказчики");
  await expect(report.locator("dl")).toContainText("Услуги:Защищённый интернет");
  await expect(report.locator("dl")).toContainText("Менеджеры:Мария Продажина");
  await expect(report).toContainText("История: 12 нед. (29.08.2026 — 24.10.2026)");
  await expect(report).toContainText("Горизонт прогноза: 30 дн. (25.10.2026 — 14.11.2026)");
  await expect(report.locator(".print-widget")).toHaveCount(5);
  expect(requests.length).toBe(before);
  expect(requests.every((request) => request.method === "GET")).toBeTruthy();
  expect(requests.some((request) => request.path.includes("weeks=12&horizon=30"))).toBeTruthy();
  await page.getByLabel("Название дашборда").fill("Изменение после создания снимка");
  await expect(report.locator("h1")).toHaveText("Несохранённый отчёт — Кириллица");
  await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
  await expect(page.getByRole("button", { name: "PDF / Печать" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Сохранить", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Сегменты: 2 ▾", exact: true })).toBeVisible();
  expect(requests.every((request) => request.method === "GET")).toBeTruthy();
});

test("длинные таблицы и все диаграммы печатаются на A4 без интерфейса приложения", async ({ page, browserName }, testInfo) => {
  const chartWidgets: Widget[] = [
    ...widgets,
    widget("trend-bar", "trend", "Столбчатая динамика", { chart: "bar", weeks: 4, horizon: 7 }, 20),
    ...(["bar", "hbar", "pie"] as const).map((chart, index) => widget(`chart-${chart}`, "breakdown", `Диаграмма ${index + 1}`, { chart }, 24 + index * 4)),
  ];
  await openDashboard(page, { widgets: chartWidgets });
  const report = await preparePrint(page);
  await expect(report.locator(".print-chart svg")).toHaveCount(6);
  await expect(report.locator("canvas")).toHaveCount(0);
  for (const svg of await report.locator(".print-chart svg").all()) {
    expect(await svg.locator("path").count()).toBeGreaterThan(0);
    const bounds = await svg.boundingBox();
    expect(bounds?.width).toBeGreaterThan(650);
    expect(bounds?.height).toBeGreaterThan(300);
  }
  await page.emulateMedia({ media: "print" });
  await expect(page.locator(".sidebar")).toBeHidden();
  await expect(page.locator(".page-header")).toBeHidden();
  await expect(page.locator(".grid-host")).toBeHidden();
  await expect(report.locator("button, input, .widget-menu")).toHaveCount(0);
  const table = report.locator('[data-widget-id="table"] table');
  await expect(table.locator("tbody tr")).toHaveCount(90);
  await expect(table.locator("tbody tr").last()).toContainText("Сегмент № 90");
  await expect(report.locator('[data-widget-id="projects"] tbody tr')).toHaveCount(20);
  const clipping = await table.evaluate((element) => {
    const clipped: string[] = [];
    for (let node: Element | null = element; node && node !== document.body; node = node.parentElement) {
      const style = getComputedStyle(node);
      if ([style.overflow, style.overflowY].some((value) => ["auto", "scroll", "hidden"].includes(value))) clipped.push(node.getAttribute("class") ?? node.tagName);
    }
    return clipped;
  });
  expect(clipping).toEqual([]);
  expect(await table.locator("thead").evaluate((node) => getComputedStyle(node).display)).toBe("table-header-group");
  expect(await report.locator(".print-widget").nth(1).evaluate((node) => getComputedStyle(node).breakBefore)).toBe("page");
  if (browserName === "chromium") {
    const pdfPath = testInfo.outputPath("dashboard.pdf");
    const pdf = await page.pdf({ path: pdfPath, preferCSSPageSize: true, printBackground: true });
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    const pageCount = pdf.toString("latin1").match(/\/Type\s*\/Page\b/g)?.length ?? 0;
    expect(pageCount).toBeGreaterThanOrEqual(chartWidgets.length);
    expect(pageCount).toBeLessThan(35);
    await testInfo.attach("Печатный отчёт A4", { path: pdfPath, contentType: "application/pdf" });
  }
});

test("просмотр общего дашборда пользователем сохраняет ограничения доступа и скрытый фильтр менеджеров", async ({ page }) => {
  const requests = await openDashboard(page, { role: "user", editable: false, widgets: [widgets[0]] });
  await expect(page.getByRole("button", { name: "PDF / Печать" })).toBeEnabled();
  const before = requests.length;
  const report = await preparePrint(page);
  await expect(report).toContainText("Только мои проекты: Мария Продажина");
  await expect(report.locator("dl")).toContainText("Менеджеры:Мария Продажина");
  expect(requests.length).toBe(before);
  expect(requests.some((request) => request.path.includes("manager_id=7"))).toBeTruthy();
  await expect(page.getByRole("button", { name: "Сохранить", exact: true })).toHaveCount(0);
});

test("пустой дашборд печатает явное сообщение, а отмена печати позволяет повторить", async ({ page }) => {
  await openDashboard(page, { widgets: [] });
  const report = await preparePrint(page);
  await expect(report).toContainText("На текущем дашборде нет виджетов.");
  await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
  await expect(report).toHaveAttribute("data-ready", "false");
  await expect(page.getByRole("button", { name: "PDF / Печать" })).toBeEnabled();
  await page.getByRole("button", { name: "PDF / Печать" }).click();
  await expect.poll(() => page.evaluate(() => (window as typeof window & { printCalls: number }).printCalls)).toBe(2);
});

test("первое монтирование печатного SVG и повторный снимок работают при уже загруженном ECharts", async ({ page }) => {
  await openDashboard(page, { widgets: [widgets[1]] });
  // Загруженный экранный график делает callback готовности печатного графика синхронным при монтировании.
  await expect(page.locator(".widget canvas").first()).toBeVisible();
  const report = await preparePrint(page);
  const chart = report.locator("[data-print-chart]");
  await expect(chart).toHaveAttribute("data-print-chart", "ready");
  await expect(chart.locator("svg path").first()).toBeAttached();
  await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
  await expect(report.locator("[data-print-chart]")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "PDF / Печать" })).toBeEnabled();
  await page.getByRole("button", { name: "PDF / Печать" }).click();
  await expect.poll(() => page.evaluate(() => (window as typeof window & { printCalls: number }).printCalls)).toBe(2);
  await expect(report.locator("[data-print-chart]")).toHaveAttribute("data-print-chart", "ready");
});

test("серверный scope_note для трёх аналитик и top-проектов виден на экране и заморожен в PDF", async ({ page }, testInfo) => {
  const original = "Показатели рассчитаны только по проектам с прежними шестью стадиями. Проекты с новыми этапами не включены.";
  let scopeNote = original;
  await page.clock.install();
  const requests = await openDashboard(page, {
    widgets: [widgets[0], widgets[1], widgets[3], widgets[4]],
    scope: () => ({ stage_scope: "legacy", scope_note: scopeNote }),
  });
  const liveNotes = page.locator(".widget [data-stage-scope]");
  await expect(liveNotes).toHaveCount(4);
  for (const note of await liveNotes.all()) await expect(note).toHaveText(original);
  const beforePrint = requests.length;
  const report = await preparePrint(page);
  const snapshotNotes = report.locator("[data-stage-scope]");
  await expect(snapshotNotes).toHaveCount(4);
  for (const note of await snapshotNotes.all()) await expect(note).toHaveText(original);
  await page.emulateMedia({ media: "print" });
  const pdfPath = testInfo.outputPath("dashboard-legacy-scope.pdf");
  const pdf = await page.pdf({ path: pdfPath, preferCSSPageSize: true, printBackground: true });
  expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
  await testInfo.attach("Серверная область аналитики в PDF", { path: pdfPath, contentType: "application/pdf" });
  await page.emulateMedia({ media: "screen" });
  expect(requests.length).toBe(beforePrint);
  expect(requests.some((request) => request.path.startsWith("/api/projects?") && new URL(request.path, "http://localhost").searchParams.get("open_only") === "true")).toBe(true);
  scopeNote = original + " Сервер обновил пояснение.";
  await page.clock.fastForward(6 * 60_000);
  await page.evaluate(() => { window.dispatchEvent(new Event("offline")); window.dispatchEvent(new Event("online")); });
  for (const note of await liveNotes.all()) await expect(note).toHaveText(scopeNote);
  for (const note of await snapshotNotes.all()) await expect(note).toHaveText(original);
  await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
  await expect(report).toHaveAttribute("data-ready", "false");
  await expect(report.locator("[data-stage-scope]")).toHaveCount(0);
  await page.getByRole("button", { name: "PDF / Печать", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as typeof window & { printCalls: number }).printCalls)).toBe(2);
  await expect(report.locator("[data-stage-scope]")).toHaveCount(4);
  for (const note of await report.locator("[data-stage-scope]").all()) await expect(note).toHaveText(scopeNote);
});
