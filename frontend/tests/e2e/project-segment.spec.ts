import { expect, test, type Page } from "@playwright/test";
import type { ClientItem, Project, Refs, Role } from "../../src/lib/types";

const active = { id: 1, name: "Корпоративный" };
const other = { id: 2, name: "Государственный" };
const inactive = { id: 3, name: "Архивный" };
const clients: ClientItem[] = [
  { id: 10, name: "Клиент с архивным сегментом", inn: "7707083893", segment: inactive },
  { id: 11, name: "Другой клиент", inn: "500100732259", segment: active },
];
const user = { id: 7, full_name: "Мария Продажина", email: "m@example.test", role: "user" as Role };
const secondManager = { id: 8, full_name: "Второй менеджер" };
const refs: Refs = {
  segments: [active, other], filter_segments: [{ ...active, is_active: true }, { ...other, is_active: true }, { ...inactive, is_active: false }],
  services: [{ id: 1, name: "Интернет", group_name: null }], managers: [user, secondManager], stages: [{ id: "lead", name: "Лид", probability: 10 }],
  customer_stages: [{ id: 10, name: "Этап", probability: 25 }], payment_types: [], assessment_statuses: [], project_indicators: [],
  cost_articles: [], cost_types: [], revenue_statuses: [], cost_statuses: [], roles: [], project_field_labels: { segment: "Направление" },
};
const base: Project = {
  id: 51, name: "Старый проект", description: "", client: clients[0], segment: inactive, service: refs.services[0], manager: user,
  stage: "lead", amount: "100.00", cost: "0.00", margin: "100.00", margin_pct: 100, probability: 10,
  start_date: "2026-01-01", expected_close_date: "2026-12-01", closed_at: null, payment_type: null,
  customer_stage: null, indicator: null, accepted_for_forecast: false, assessment_status: null, subsidiary_implementation: false,
  management_control: false, is_industry_solution: false, industry_manager: null, industry_project_number: null,
  implementation_year: 2024, project_status: null, realized_work: "", period_plan: "", created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z", financial_entries: [],
};

async function setup(page: Page, role: Role = "user") {
  const projects = new Map<number, Project>([[51, structuredClone(base)]]);
  const writes: { method: string; body: Record<string, unknown> }[] = [];
  const history: { field: string; label: string; before: string; after: string }[] = [];
  let rejectNextSegment = false;
  await page.addInitScript(() => { window.print = () => {}; });
  await page.context().route("**/api/**", async (route) => {
    const req = route.request(); const url = new URL(req.url()); const path = url.pathname;
    if (path === "/api/auth/me") return route.fulfill({ json: { ...user, role } });
    if (path === "/api/refs") return route.fulfill({ json: refs });
    if (path === "/api/dashboards") return route.fulfill({ json: [] });
    if (path === "/api/clients") return route.fulfill({ json: clients.filter((c) => c.name.toLowerCase().includes((url.searchParams.get("q") ?? "").toLowerCase())) });
    if (path === "/api/projects/check-name") return route.fulfill({ json: { available: true } });
    const match = path.match(/^\/api\/projects\/(\d+)(\/history)?$/);
    if (match?.[2]) return route.fulfill({ json: { items: history.length ? [{ id: 1, created_at: "2026-10-01T00:00:00Z", action: "updated", title: "Изменён проект", author_name: user.full_name, changes: history, note: null }] : [], limit: 10, offset: 0, has_more: false } });
    if (match && req.method() === "GET") return route.fulfill({ json: projects.get(Number(match[1])) ?? base });
    if ((path === "/api/projects" && req.method() === "POST") || (match && req.method() === "PUT")) {
      const body = req.postDataJSON() as Record<string, unknown>; writes.push({ method: req.method(), body });
      if (rejectNextSegment) { rejectNextSegment = false; return route.fulfill({ status: 422, json: { detail: { field: "segment_id", message: "Сегмент больше недоступен" } } }); }
      const creating = req.method() === "POST"; const id = creating ? 100 + writes.filter((w) => w.method === "POST").length : Number(match![1]);
      const current = creating ? base : projects.get(id)!;
      const client = clients.find((item) => item.id === body.client_id)!;
      const segment = body.segment_id === undefined ? (creating ? client.segment : current.segment) : [active, other, inactive].find((item) => item.id === body.segment_id)!;
      if (!creating && current.segment.id !== segment.id) history.push({ field: "segment_id", label: "Направление", before: current.segment.name, after: segment.name });
      const manager = body.manager_id === undefined ? current.manager : refs.managers.find((item) => item.id === body.manager_id)!;
      const implementation_year = body.implementation_year === undefined ? current.implementation_year : body.implementation_year as number | null;
      const saved: Project = { ...current, id, name: String(body.name), description: String(body.description), client, segment, manager, implementation_year,
        ...(creating ? { stage_scheme: "customer", stage: null, customer_stage: refs.customer_stages[0], probability: 25 } : {}) };
      projects.set(id, saved);
      return route.fulfill({ status: creating ? 201 : 200, json: saved });
    }
    if (path === "/api/projects") return route.fulfill({ json: { items: [...projects.values()], total: projects.size, page: 1, size: 20 } });
    return route.fulfill({ status: 404, json: { detail: "Тестовый маршрут не найден" } });
  });
  return { projects, writes, rejectNext: () => { rejectNextSegment = true; } };
}

async function selectClient(page: Page, client: ClientItem) {
  await page.getByLabel(/Клиент/).fill(client.name);
  await page.getByRole("button", { name: `${client.name} ИНН ${client.inn}`, exact: true }).click();
}
async function fillNew(page: Page, name: string) {
  await page.getByLabel(/Название проекта/).fill(name);
  await selectClient(page, clients[0]);
  await page.getByLabel(/Услуга/).selectOption("1");
  await page.getByLabel("Этап по ТЗ", { exact: false }).selectOption("10");
  await page.getByLabel(/Сумма контракта/).fill("100");
  await page.getByLabel(/Дата начала/).fill("2026-01-01");
  await page.getByLabel(/Плановое закрытие/).fill("2026-12-01");
}
const segment = (page: Page) => page.getByLabel("Направление проекта", { exact: true });
const save = (page: Page) => page.getByRole("button", { name: "Сохранить", exact: true });

test("acceptance: два проекта клиента, наследование, независимый выбор, смена клиента и история", async ({ page }) => {
  const state = await setup(page);
  await page.goto("/projects/new");
  await fillNew(page, "Проект с наследованием");
  await expect(segment(page)).toHaveValue("");
  await expect(segment(page).locator("option[value='']")).toHaveText("По сегменту клиента: Архивный (неактивно)");
  await expect(segment(page).locator("option[value='3']")).toHaveCount(0);
  await page.getByRole("button", { name: "Создать проект" }).click();
  await expect(page).toHaveURL(/\/projects\/101$/);
  expect(state.writes[0].body).not.toHaveProperty("segment_id");
  expect(state.writes[0].body.manager_id).toBe(user.id);
  expect(state.writes[0].body.implementation_year).toBeNull();
  await expect(segment(page)).toHaveValue("3");
  await expect(segment(page).locator("option[value='3']")).toHaveText("Архивный (неактивно)");
  await page.goto("/projects/new");
  await fillNew(page, "Проект с выбором");
  await segment(page).selectOption("2");
  await page.getByRole("button", { name: "Создать проект" }).click();
  await expect(page).toHaveURL(/\/projects\/102$/);
  expect(state.writes[1].body.segment_id).toBe(2);
  expect(state.projects.get(101)?.segment).toEqual(inactive);
  expect(state.projects.get(102)?.segment).toEqual(other);
  await page.goto("/projects/101");
  await expect(page.getByText("Сегмент клиента: Архивный")).toHaveCount(0);
  await selectClient(page, clients[1]);
  await expect(segment(page)).toHaveValue("3");
  await save(page).click();
  await expect.poll(() => state.writes.length).toBe(3);
  expect(state.writes[2].body).not.toHaveProperty("segment_id");
  expect(state.projects.get(101)?.segment).toEqual(inactive);
  await page.reload();
  await expect(segment(page)).toHaveValue("3");
  await expect(segment(page).locator("option[value='3']")).toHaveText("Архивный (неактивно)");
  await segment(page).selectOption("1");
  await save(page).click();
  await expect.poll(() => state.writes.length).toBe(4);
  expect(state.writes[3].body.segment_id).toBe(1);
  await expect(segment(page)).toHaveValue("1");
  const historyRow = page.getByRole("row").filter({ has: page.getByRole("rowheader", { name: "Направление" }) });
  await expect(historyRow).toContainText("Архивный");
  await expect(historyRow).toContainText("Корпоративный");
  await page.getByRole("button", { name: "PDF / Печать карточки" }).click();
  const print = page.locator("[data-project-print]");
  await expect(print).toHaveAttribute("data-ready", "true");
  await expect(print).toContainText("Корпоративный");
});

test("ошибка сервера segment_id показывается у поля и выбранное значение можно исправить", async ({ page }) => {
  const state = await setup(page, "analyst");
  await page.goto("/projects/51");
  await segment(page).selectOption("2");
  state.rejectNext();
  await save(page).click();
  await expect(page.getByRole("alert").filter({ hasText: "Сегмент больше недоступен" })).toBeVisible();
  await expect(segment(page)).toHaveAttribute("aria-invalid", "true");
  await expect(segment(page)).toHaveValue("2");
  await segment(page).selectOption("1");
  await expect(segment(page)).toHaveAttribute("aria-invalid", "false");
  await save(page).click();
  await expect.poll(() => state.projects.get(51)?.segment.id).toBe(1);
});

test("старый и новый черновики сохраняют наследование и явный выбор", async ({ page }) => {
  await setup(page, "admin");
  await page.goto("/projects/new");
  await fillNew(page, "Тест черновика");
  await segment(page).selectOption("2");
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("project-draft") ?? "{}").segment_id)).toBe("2");
  await page.reload();
  await expect(page.getByText("Восстановлен несохранённый черновик.")).toBeVisible();
  await expect(segment(page)).toHaveValue("2");
  await page.evaluate(() => { const draft = JSON.parse(localStorage.getItem("project-draft")!); delete draft.segment_id; delete draft.client.segment_id; localStorage.setItem("project-draft", JSON.stringify(draft)); });
  await page.reload();
  await expect(page.getByText("Восстановлен несохранённый черновик.")).toBeVisible();
  await expect(segment(page)).toHaveValue("");
  await expect(page.getByLabel(/Название проекта/)).toHaveValue("Тест черновика");
  await page.getByRole("button", { name: "Создать проект" }).click();
  await expect(page).toHaveURL(/\/projects\/101$/);
});

test("существующий отключённый сегмент можно вернуть до сохранения; старый сегмент не подменяет сегмент клиента", async ({ page }) => {
  const state = await setup(page, "admin");
  await page.goto("/projects/51");
  await expect(segment(page)).toHaveValue("3");
  await segment(page).selectOption("1");
  await segment(page).selectOption("3");
  await selectClient(page, clients[1]);
  await expect(page.getByText("Сегмент клиента: Корпоративный")).toBeVisible();
  await expect(segment(page)).toHaveValue("3");
  await save(page).click();
  await expect.poll(() => state.writes.length).toBe(1);
  expect(state.writes[0].body).not.toHaveProperty("segment_id");
});


test("отключённый явный сегмент в черновике виден и требует исправления", async ({ page }) => {
  const state = await setup(page);
  await page.goto("/projects/new");
  await fillNew(page, "Незавершённый проект");
  await segment(page).selectOption("2");
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("project-draft") ?? "{}").segment_id)).toBe("2");
  await page.evaluate(() => { const draft = JSON.parse(localStorage.getItem("project-draft")!); draft.segment_id = "3"; localStorage.setItem("project-draft", JSON.stringify(draft)); });
  await page.reload();
  await expect(segment(page)).toHaveValue("3");
  await expect(segment(page).locator("option[value='3']")).toBeDisabled();
  await page.getByRole("button", { name: "Создать проект" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Выберите доступный сегмент проекта" })).toBeVisible();
  expect(state.writes).toHaveLength(0);
  await expect(page.getByLabel(/Название проекта/)).toHaveValue("Незавершённый проект");
  await segment(page).selectOption("");
  await page.getByRole("button", { name: "Создать проект" }).click();
  await expect(page).toHaveURL(/\/projects\/101$/);
  expect(state.writes[0].body).not.toHaveProperty("segment_id");
});


test("две карточки не перезаписывают неизменённые менеджера, сегмент и год; ошибка не сбрасывает выбор", async ({ page, context }) => {
  const state = await setup(page, "analyst");
  const otherPage = await context.newPage();
  await Promise.all([page.goto("/projects/51"), otherPage.goto("/projects/51")]);
  await expect(segment(page)).toHaveValue("3");
  await expect(segment(otherPage)).toHaveValue("3");
  await otherPage.locator("#manager_id").selectOption("8");
  await segment(otherPage).selectOption("2");
  await otherPage.getByLabel("Год реализации").fill("2030");
  await save(otherPage).click();
  await expect.poll(() => state.projects.get(51)?.implementation_year).toBe(2030);
  expect(state.writes[0].body).toMatchObject({ manager_id: 8, segment_id: 2, implementation_year: 2030 });
  await page.getByLabel("Суть проекта").fill("Изменено в другой карточке");
  await save(page).click();
  await expect.poll(() => state.writes.length).toBe(2);
  expect(state.writes[1].body).not.toHaveProperty("manager_id");
  expect(state.writes[1].body).not.toHaveProperty("segment_id");
  expect(state.writes[1].body).not.toHaveProperty("implementation_year");
  expect(state.projects.get(51)).toMatchObject({ manager: secondManager, segment: other, implementation_year: 2030 });
  await expect(page.locator("#manager_id")).toHaveValue("8");
  await expect(segment(page)).toHaveValue("2");
  await expect(page.getByLabel("Год реализации")).toHaveValue("2030");
  await page.locator("#manager_id").selectOption("7");
  await segment(page).selectOption("1");
  await page.getByLabel("Год реализации").fill("");
  state.rejectNext();
  await save(page).click();
  await expect(page.getByRole("alert").filter({ hasText: "Сегмент больше недоступен" })).toBeVisible();
  expect(state.writes[2].body).toMatchObject({ manager_id: 7, segment_id: 1, implementation_year: null });
  await expect(segment(page)).toHaveValue("1");
  await save(page).click();
  await expect.poll(() => state.writes.length).toBe(4);
  expect(state.writes[3].body).toMatchObject({ manager_id: 7, segment_id: 1, implementation_year: null });
  await expect(page.getByText(/Сохранено в/)).toBeVisible();
  await page.getByLabel("Суть проекта").fill("Повторное сохранение");
  await save(page).click();
  await expect.poll(() => state.writes.length).toBe(5);
  for (const field of ["manager_id", "segment_id", "implementation_year"]) expect(state.writes[4].body).not.toHaveProperty(field);
  await otherPage.close();
});
