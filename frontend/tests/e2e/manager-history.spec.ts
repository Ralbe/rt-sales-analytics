import { expect, test, type Page } from "@playwright/test";
import type { Project, Refs, Role, Widget } from "../../src/lib/types";

const active = { id: 1, full_name: "Действующий менеджер" };
const former = { id: 2, full_name: "Бывший менеджер" };
const segment = { id: 1, name: "Сегмент" };
const service = { id: 1, name: "Услуга", group_name: null };
const refs: Refs = {
  segments: [segment], services: [service], managers: [active],
  filter_managers: [{ ...active, is_active: true }, { ...former, is_active: false }],
  stages: [{ id: "lead", name: "Лид", probability: 10 }], payment_types: [], assessment_statuses: [],
  project_indicators: [], customer_stages: [], cost_articles: [], cost_types: [], revenue_statuses: [], cost_statuses: [], roles: [],
};
const project: Project = {
  id: 51, name: "Старый проект", description: "", client: { id: 10, name: "Клиент" }, segment, service, manager: former,
  stage: "lead", amount: "10000.00", cost: "2000.00", margin: "8000.00", margin_pct: 80, probability: 10,
  start_date: "2026-10-01", expected_close_date: "2026-12-01", closed_at: null, payment_type: null,
  customer_stage: null, indicator: null, accepted_for_forecast: false, assessment_status: null,
  subsidiary_implementation: false, management_control: false, is_industry_solution: false, industry_manager: null,
  industry_project_number: null, implementation_year: null, project_status: null, realized_work: "", period_plan: "",
  created_at: "2026-10-01T10:00:00Z", updated_at: "2026-10-24T10:00:00Z", financial_entries: [],
};
const widgets: Widget[] = [
  { id: "projects", type: "projects", title: "Проекты в работе", x: 0, y: 0, w: 6, h: 4, config: {} },
  { id: "breakdown", type: "breakdown", title: "По менеджерам", x: 6, y: 0, w: 6, h: 4, config: { group_by: "manager", chart: "table" } },
];

async function setup(page: Page, role: Role, legacy = false) {
  const requests: URL[] = [];
  const writes: { manager_id?: number; filters?: { manager_ids: number[] } }[] = [];
  const currentRefs = { ...refs, ...(role === "user" ? { filter_managers: [{ ...active, is_active: true }] } : {}) }; if (legacy) delete currentRefs.filter_managers;
  const dashboard = { id: 41, name: "Дашборд", owner: active, widgets, filters: { segment_ids: [], service_ids: [], manager_ids: [2] },
    is_shared: true, editable: role !== "user", updated_at: "2026-10-24T10:00:00Z" };
  await page.addInitScript(() => { window.print = () => {}; });
  await page.route("**/api/**", async (route) => {
    const req = route.request(); const url = new URL(req.url()); requests.push(url);
    if (url.pathname === "/api/auth/me") return route.fulfill({ json: { ...active, email: "test@example.test", role } });
    if (url.pathname === "/api/refs") return route.fulfill({ json: currentRefs });
    if (url.pathname === "/api/dashboards") return route.fulfill({ json: [dashboard] });
    if (url.pathname === "/api/dashboards/41") {
      if (req.method() === "PUT") { const body = req.postDataJSON(); writes.push(body); return route.fulfill({ json: { ...dashboard, ...body } }); }
      return route.fulfill({ json: dashboard });
    }
    if (url.pathname === "/api/projects/check-name") return route.fulfill({ json: { available: true } });
    if (url.pathname === "/api/projects/51/history") return route.fulfill({ json: { items: [], limit: 10, offset: 0, has_more: false } });
    if (url.pathname === "/api/projects/51") {
      if (req.method() === "PUT") { writes.push(req.postDataJSON()); return route.fulfill({ json: project }); }
      return route.fulfill({ json: project });
    }
    if (url.pathname === "/api/clients") return route.fulfill({ json: [{ ...project.client, inn: "7707083893", segment }] });
    if (url.pathname === "/api/projects") return route.fulfill({ json: { items: role === "user" ? [{ ...project, manager: active }] : [project], total: 1, page: 1, size: 20 } });
    if (url.pathname === "/api/analytics/breakdown") return route.fulfill({ json: { metric: "funnel", group_by: "manager", items: role === "user" ? [] : [{ key: "2", label: former.full_name, value: 100 }] } });
    return route.fulfill({ status: 404 });
  });
  return { requests, writes };
}

for (const role of ["analyst", "admin"] as const) test(`${role}: старая карточка сохраняет ответственного, новый проект предлагает только активных`, async ({ page }) => {
  const { writes } = await setup(page, role);
  await page.goto("/projects/51");
  await expect(page.locator("#manager_id")).toHaveValue("2");
  await expect(page.locator("#manager_id option[value='2']")).toHaveText("Бывший менеджер (неактивен)");
  await expect(page.locator("#manager_id option[value='2']")).toBeDisabled();
  await page.getByLabel("Суть проекта").fill("Изменено");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).not.toHaveProperty("manager_id");
  await page.getByRole("button", { name: "PDF / Печать карточки" }).click();
  const print = page.locator("[data-project-print]");
  await expect(print).toHaveAttribute("data-ready", "true");
  await expect(print).toContainText("Бывший менеджер (неактивен)");
  await page.goto("/projects/new");
  await expect(page.locator("#manager_id option[value='1']")).toHaveText(active.full_name);
  await expect(page.locator("#manager_id option[value='2']")).toHaveCount(0);
});

test("реестр: фильтр передаёт ID отключённого и помечает его в строке", async ({ page }) => {
  const { requests } = await setup(page, "analyst");
  await page.goto("/projects");
  await expect(page.locator("tbody")).toContainText("Бывший менеджер (неактивен)");
  await page.getByRole("button", { name: "Менеджеры: все ▾" }).click();
  await page.getByLabel("Бывший менеджер (неактивен)").check();
  await expect.poll(() => requests.some((url) => url.pathname === "/api/projects" && url.searchParams.get("manager_id") === "2")).toBe(true);
});

test("сохранённый дашборд: фильтр, виджеты, сохранение и печать", async ({ page }) => {
  const { requests, writes } = await setup(page, "admin");
  await page.goto("/dashboards/41");
  await expect(page.getByRole("button", { name: /Бывший менеджер \(неактивен\)/ })).toBeVisible();
  await expect(page.getByText("Бывший менеджер (неактивен)", { exact: true })).toHaveCount(2);
  await expect.poll(() => requests.some((url) => url.pathname === "/api/analytics/breakdown" && url.searchParams.get("manager_id") === "2")).toBe(true);
  await page.getByLabel("Название дашборда").fill("Дашборд сохранён");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect.poll(() => writes[0]?.filters?.manager_ids).toEqual([2]);
  await page.getByRole("button", { name: "PDF / Печать", exact: true }).click();
  const print = page.locator("[data-dashboard-print]");
  await expect(print).toHaveAttribute("data-ready", "true");
  await expect(print.getByText("Бывший менеджер (неактивен)", { exact: true })).toHaveCount(3);
});

test("старый API: карточка сохраняет прежний ID, сохранённый фильтр не выглядит как все", async ({ page }) => {
  const { writes } = await setup(page, "analyst", true);
  await page.goto("/projects/51");
  await expect(page.locator("#manager_id")).toHaveValue("2");
  await page.getByLabel("Суть проекта").fill("Изменено");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).not.toHaveProperty("manager_id");
  await page.getByRole("button", { name: "PDF / Печать карточки" }).click();
  const cardPrint = page.locator("[data-project-print]");
  await expect(cardPrint).toHaveAttribute("data-ready", "true");
  await expect(cardPrint).toContainText("Бывший менеджер (неактивен)");
  await page.goto("/dashboards/41");
  await expect(page.getByRole("button", { name: /Недоступное значение \(ID 2\)/ })).toBeVisible();
  await page.getByRole("button", { name: "PDF / Печать", exact: true }).click();
  const print = page.locator("[data-dashboard-print]");
  await expect(print).toHaveAttribute("data-ready", "true");
  await expect(print).toContainText("Недоступное значение (ID 2)");
});

test("user: фильтр менеджера не появляется и доступ остаётся ограниченным", async ({ page }) => {
  const { requests } = await setup(page, "user");
  await page.goto("/projects");
  await expect(page.locator("tbody")).toContainText(active.full_name);
  await expect(page.locator("tbody")).not.toContainText(former.full_name);
  await expect(page.getByRole("button", { name: /Менеджеры:/ })).toHaveCount(0);
  await expect.poll(() => requests.some((url) => url.pathname === "/api/projects")).toBe(true);
  expect(requests.filter((url) => url.pathname === "/api/projects").every((url) => !url.searchParams.has("manager_id"))).toBe(true);
  await page.goto("/dashboards/41");
  await expect(page.getByRole("button", { name: /Менеджеры:|Бывший менеджер.*▾/ })).toHaveCount(0);
  await page.getByRole("button", { name: "PDF / Печать", exact: true }).click();
  const print = page.locator("[data-dashboard-print]");
  await expect(print).toHaveAttribute("data-ready", "true");
  await expect(print).toContainText("Область доступа: Только мои проекты");
});


test("черновик нового проекта не восстанавливает отключённого менеджера", async ({ page }) => {
  await setup(page, "analyst");
  await page.goto("/projects/new");
  await expect(page.locator("#manager_id option[value='1']")).toHaveText(active.full_name);
  await page.getByLabel("Название проекта").fill("Черновик проекта");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("project-draft"))).not.toBeNull();
  await page.evaluate(() => {
    const draft = JSON.parse(localStorage.getItem("project-draft")!);
    draft.manager_id = "2";
    localStorage.setItem("project-draft", JSON.stringify(draft));
  });
  await page.reload();
  await expect(page.getByText("Восстановлен несохранённый черновик.")).toBeVisible();
  await expect(page.locator("#manager_id")).toHaveValue("");
  await expect(page.locator("#manager_id option[value='2']")).toHaveCount(0);
});


test("возврат в окно обновляет фильтр и блокирует печать до загрузки справочников", async ({ page, context }) => {
  await setup(page, "analyst");
  await page.goto("/dashboards/41");
  await expect(page.getByRole("button", { name: /Бывший менеджер \(неактивен\)/ })).toBeVisible();
  let release = () => {};
  let started = false;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const updated: Refs = { ...refs, managers: [active, former], filter_managers: [{ ...active, is_active: true }, { ...former, is_active: true }] };
  await page.route("**/api/refs", async (route) => { started = true; await gate; await route.fulfill({ json: updated }); });
  const another = await context.newPage();
  await another.goto("about:blank");
  await another.bringToFront();
  await page.bringToFront();
  await simulateVisibilityReturn(page);
  await expect.poll(() => started).toBe(true);
  const printButton = page.getByRole("button", { name: "PDF / Печать", exact: true });
  await expect(printButton).toBeDisabled();
  release();
  await expect(page.getByRole("button", { name: "Бывший менеджер ▾", exact: true })).toBeVisible();
  await expect(printButton).toBeEnabled();
  await printButton.click();
  const report = page.locator("[data-dashboard-print]");
  await expect(report).toHaveAttribute("data-ready", "true");
  await expect(report).toContainText("Бывший менеджер");
  await expect(report).not.toContainText("Бывший менеджер (неактивен)");
  await another.close();
});

test("возврат в окно сохраняет правки и явно показывает ставшего недоступным менеджера", async ({ page, context }) => {
  await setup(page, "analyst");
  await page.goto("/projects/51");
  await page.locator("#manager_id").selectOption("1");
  await page.getByLabel("Суть проекта").fill("Не сохранённое описание");
  let release = () => {}; let started = false;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const updated: Refs = { ...refs, managers: [], filter_managers: [{ ...active, is_active: false }, { ...former, is_active: false }] };
  await page.route("**/api/refs", async (route) => { started = true; await gate; await route.fulfill({ json: updated }); });
  const another = await context.newPage(); await another.goto("about:blank"); await another.bringToFront(); await page.bringToFront();
  await simulateVisibilityReturn(page);
  await expect.poll(() => started).toBe(true);
  await expect(page.getByRole("button", { name: "PDF / Печать карточки" })).toBeDisabled();
  release();
  await expect(page.locator("#manager_id")).toHaveValue("1");
  await expect(page.locator("#manager_id option[value='1']")).toHaveText("Действующий менеджер (недоступен)");
  await expect(page.getByLabel("Суть проекта")).toHaveValue("Не сохранённое описание");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(page.getByText("Выберите доступного ответственного")).toBeVisible();
  await expect(page.getByLabel("Суть проекта")).toHaveValue("Не сохранённое описание");
  await another.close();
});

// Chromium в headless не всегда меняет visibilityState при переключении страниц.
async function simulateVisibilityReturn(page: Page) {
  await page.evaluate(() => {
    let state = "hidden";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
    window.dispatchEvent(new Event("visibilitychange"));
    state = "visible";
    window.dispatchEvent(new Event("visibilitychange"));
    Reflect.deleteProperty(document, "visibilityState");
  });
}


for (const target of ["project", "dashboard"] as const) test(`обновление refs во время подготовки печати отменяет снимок: ${target}`, async ({ page }) => {
  await setup(page, "analyst");
  await page.goto(target === "project" ? "/projects/51" : "/dashboards/41");
  const printButton = page.getByRole("button", { name: target === "project" ? "PDF / Печать карточки" : "PDF / Печать", exact: true });
  await expect(printButton).toBeEnabled();
  await page.evaluate(() => { (window as typeof window & { printCount: number }).printCount = 0; window.print = () => { (window as typeof window & { printCount: number }).printCount++; }; });
  let releaseCheck = () => {}; let checking = false;
  const checkGate = new Promise<void>((resolve) => { releaseCheck = resolve; });
  await page.route(target === "project" ? "**/api/projects/51" : "**/api/dashboards/41", async (route) => { checking = true; await checkGate; await route.fallback(); });
  let releaseRefs = () => {}; let loading = false;
  const refsGate = new Promise<void>((resolve) => { releaseRefs = resolve; });
  await page.route("**/api/refs", async (route) => { loading = true; await refsGate; await route.fulfill({ json: refs }); });
  await printButton.click();
  await expect.poll(() => checking).toBe(true);
  await simulateVisibilityReturn(page);
  await expect.poll(() => loading).toBe(true);
  await expect(printButton).toBeDisabled();
  releaseRefs(); releaseCheck();
  await expect(printButton).toBeEnabled();
  await expect(page.locator(target === "project" ? "[data-project-print]" : "[data-dashboard-print]")).toHaveAttribute("data-ready", "false");
  expect(await page.evaluate(() => (window as typeof window & { printCount: number }).printCount)).toBe(0);
  await printButton.click();
  await expect(page.locator(target === "project" ? "[data-project-print]" : "[data-dashboard-print]")).toHaveAttribute("data-ready", "true");
});
