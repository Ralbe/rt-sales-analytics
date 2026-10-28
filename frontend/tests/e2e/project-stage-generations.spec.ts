import { expect, test, type Page } from "@playwright/test";

import type { ClientItem, Project, Refs, Stage } from "../../src/lib/types";

const MANAGER = { id: 1, full_name: "Менеджер этапов" };
const CUSTOMER_STAGES = [3, 11, 25, 34, 46, 57, 68, 79, 88, 100].map((probability, index) => ({
  id: 101 + index, name: "Этап заказчика " + (index + 1), probability,
}));
const REFS: Refs = {
  segments: [{ id: 2, name: "Сегмент" }], services: [{ id: 3, name: "Связь", group_name: null }],
  managers: [MANAGER],
  stages: (["lead", "qualification", "proposal", "negotiation", "won", "lost"] as Stage[]).map((id, index) => ({
    id, name: "Прежняя стадия " + id, probability: [10, 25, 50, 75, 100, 0][index],
  })),
  customer_stages: CUSTOMER_STAGES, payment_types: [], assessment_statuses: [], project_indicators: [],
  cost_articles: [], cost_types: [], revenue_statuses: [], cost_statuses: [], roles: [],
};
const CLIENT: ClientItem = { id: 4, name: "Клиент этапов", inn: "7707083893", segment: REFS.segments[0] };
const LEGACY: Project = {
  id: 42, name: "Прежний проект", description: "Сохранённое описание",
  client: CLIENT, segment: CLIENT.segment, service: REFS.services[0], manager: MANAGER,
  stage: "proposal", probability: 37, customer_stage: CUSTOMER_STAGES[2],
  amount: "1000.00", cost: "100.00", margin: "900.00", margin_pct: 90,
  start_date: "2026-10-01", expected_close_date: "2026-12-31", closed_at: null,
  payment_type: null, indicator: null, accepted_for_forecast: false, assessment_status: null,
  subsidiary_implementation: false, management_control: false, is_industry_solution: false,
  industry_manager: null, industry_project_number: null, implementation_year: null, project_status: null,
  realized_work: "", period_plan: "", financial_entries: [],
  created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-26T00:00:00Z",
};
const CUSTOMER: Project = {
  ...LEGACY, name: "Проект с новыми этапами", stage_scheme: "customer", stage: null,
  customer_stage: CUSTOMER_STAGES[1], probability: 17,
};
type ProjectWrite = Record<string, unknown> & {
  name: string; description: string; stage?: Stage; probability?: number; customer_stage_id?: number;
};

async function mockApi(page: Page, initial: Project | null = LEGACY) {
  const state = { current: initial && structuredClone(initial), writes: [] as ProjectWrite[], unexpected: [] as string[] };
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^\/api/, "");
    const method = request.method();
    if (method === "GET") {
      if (path === "/auth/me") return route.fulfill({ json: { ...MANAGER, email: "stages@example.test", role: "analyst" } });
      if (path === "/refs") return route.fulfill({ json: REFS });
      if (path === "/clients") return route.fulfill({ json: [CLIENT] });
      if (path === "/dashboards") return route.fulfill({ json: [] });
      if (path === "/projects/check-name") return route.fulfill({ json: { available: true } });
      if (path === "/projects/42/history") return route.fulfill({ json: { items: [], limit: 10, offset: 0, has_more: false } });
      if (path === "/projects/42" && state.current) return route.fulfill({ json: state.current });
    }
    if ((method === "POST" && path === "/projects") || (method === "PUT" && path === "/projects/42" && state.current)) {
      const body: ProjectWrite = request.postDataJSON();
      expect(body).not.toHaveProperty("stage_scheme");
      const customer = method === "POST" || state.current?.stage_scheme === "customer";
      let next: Project;
      if (customer) {
        expect(body).not.toHaveProperty("stage");
        expect(body).not.toHaveProperty("probability");
        const selected = CUSTOMER_STAGES.find((stage) => stage.id === body.customer_stage_id);
        expect(selected).toBeDefined();
        const changedStage = state.current?.customer_stage?.id !== selected!.id;
        next = {
          ...(state.current ?? LEGACY), ...body, stage_scheme: "customer", stage: null,
          customer_stage: selected!, probability: changedStage ? selected!.probability : state.current!.probability,
        };
      } else {
        expect(body).not.toHaveProperty("customer_stage_id");
        expect(REFS.stages.map((stage) => stage.id)).toContain(body.stage);
        next = { ...state.current!, ...body, stage: body.stage!, probability: body.probability! };
      }
      state.writes.push(body);
      state.current = next;
      return route.fulfill({ status: method === "POST" ? 201 : 200, json: next });
    }
    state.unexpected.push(method + " " + path);
    return route.fulfill({ status: 500, json: { detail: "Неожиданный запрос: " + method + " " + path } });
  });
  return state;
}

async function fillNewProject(page: Page) {
  await page.goto("/projects/new");
  await page.getByLabel(/Название проекта/).fill("Новый проект с десятью этапами");
  await page.getByLabel(/Клиент/).fill("Клиент");
  await page.getByRole("button", { name: CLIENT.name + " ИНН " + CLIENT.inn, exact: true }).click();
  await page.getByLabel(/Услуга/).selectOption("3");
  await page.getByLabel(/Ответственный/).selectOption("1");
  await page.getByLabel(/Сумма контракта/).fill("1000");
  await page.getByLabel(/Дата начала/).fill("2026-10-01");
  await page.getByLabel(/Плановое закрытие/).fill("2026-12-31");
}

test("неактивные значения остаются в сохранённой карточке и передаются при сохранении", async ({ page }) => {
  const state = await mockApi(page, {
    ...LEGACY, payment_type: { id: 77, name: "Прежний платёж" },
    financial_entries: [{ id: 88, kind: "cost", year: 2026, month: 10, amount: "15.000", vat_included: true,
      status: { id: 90, name: "Прежний статус" }, article: { id: 91, name: "Прежняя статья" },
      cost_type: { id: 92, name: "Прежний вид" } }],
  });
  await page.goto("/projects/42");
  const payment = page.locator("#payment_type_id");
  await expect(payment).toHaveValue("77");
  await expect(payment.locator("option[value='77']")).toHaveText("Прежний платёж (неактивно)");
  await expect(payment.locator("option[value='77']")).toBeDisabled();
  const status = page.getByLabel("Статус затрат");
  await expect(status).toHaveValue("90");
  await expect(status.locator("option[value='90']")).toHaveText("Прежний статус (неактивно)");
  await page.getByLabel("Суть проекта").fill("Новое описание");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(1);
  expect(state.writes[0]).toMatchObject({ payment_type_id: 77, financial_entries: [
    { id: 88, status_id: 90, article_id: 91, cost_type_id: 92 },
  ] });
});

test("новая карточка: один обязательный селект из 10 этапов, без legacy stage и ручной вероятности", async ({ page }) => {
  const state = await mockApi(page, null);
  await fillNewProject(page);
  const stage = page.getByLabel("Этап по ТЗ", { exact: false });
  const probability = page.getByLabel("Вероятность", { exact: false });
  await expect(stage.getByRole("option")).toHaveCount(11);
  await expect(stage).toHaveValue("");
  await expect(page.locator("#stage")).toHaveCount(0);
  await expect(probability).toHaveAttribute("readonly", "");
  await expect(probability).toHaveValue("");
  await expect(page.locator("[data-completion-state]")).toHaveText("Состояние завершения: не определено");
  await expect(page.getByRole("region", { name: "История изменений" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "PDF / Печать карточки", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Создать проект", exact: true }).click();
  await expect(page.getByText("Выберите этап проекта", { exact: true })).toBeVisible();
  expect(state.writes).toEqual([]);
  await stage.selectOption("101");
  await expect(probability).toHaveValue("3");
  await stage.selectOption("102");
  await expect(probability).toHaveValue("11");
  await stage.selectOption("101");
  await expect(probability).toHaveValue("3");
  await stage.selectOption("110");
  await expect(probability).toHaveValue("100");
  await expect(page.locator("[data-completion-state]")).toHaveText("Состояние завершения: не определено");
  await page.getByRole("button", { name: "Создать проект", exact: true }).click();
  await expect(page).toHaveURL(/\/projects\/42$/);
  await expect(page.getByRole("button", { name: "Сохранить", exact: true })).toBeDisabled();
  await expect(page.getByRole("region", { name: "История изменений" })).toBeVisible();
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0]).toMatchObject({ customer_stage_id: 110, financial_entries: [] });
  expect(state.current).toMatchObject({ stage_scheme: "customer", stage: null, probability: 100 });
  expect(state.current?.closed_at).toBeNull();
  expect(state.unexpected).toEqual([]);
});

test("прежняя карточка без stage_scheme: смена стадии сохраняет 37%, процент меняется только явным вводом", async ({ page }) => {
  const state = await mockApi(page);
  await page.goto("/projects/42");
  await expect(page.locator("#stage").getByRole("option")).toHaveCount(6);
  await expect(page.locator("[data-completion-state]")).toHaveCount(0);
  await expect(page.locator("#stage")).toHaveValue("proposal");
  const auxiliary = page.getByLabel("Этап по ТЗ", { exact: false });
  await expect(auxiliary).toHaveAttribute("readonly", "");
  await expect(auxiliary).toHaveValue(CUSTOMER_STAGES[2].name);
  const probability = page.getByLabel("Вероятность", { exact: false });
  await expect(probability).toHaveValue("37");
  await expect(probability).not.toHaveAttribute("readonly", "");
  await page.locator("#stage").selectOption("negotiation");
  await expect(probability).toHaveValue("37");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(page.getByRole("button", { name: "Сохранить", exact: true })).toBeDisabled();
  expect(state.writes[0]).toMatchObject({ stage: "negotiation", probability: 37 });
  expect(state.current?.probability).toBe(37);
  await probability.fill("43");
  await page.locator("#stage").selectOption("qualification");
  await page.getByLabel("Суть проекта").fill("Изменение прежней карточки");
  await expect(probability).toHaveValue("43");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(page.getByText(/Сохранено в/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Сохранить", exact: true })).toBeDisabled();
  expect(state.writes).toHaveLength(2);
  expect(state.writes[1]).toMatchObject({ stage: "qualification", probability: 43 });
  expect(state.current?.customer_stage).toEqual(LEGACY.customer_stage);
  await page.reload();
  await expect(auxiliary).toHaveValue(CUSTOMER_STAGES[2].name);
  await expect(probability).toHaveValue("43");
  await expect(page.locator("#stage")).toHaveValue("qualification");
  expect(state.unexpected).toEqual([]);
});

test("legacy без вспомогательного этапа: proposal→negotiation сохраняет ручные 37%", async ({ page }) => {
  const state = await mockApi(page, { ...LEGACY, customer_stage: null });
  await page.goto("/projects/42");
  const probability = page.getByLabel("Вероятность", { exact: false });
  await expect(page.locator("#stage")).toHaveValue("proposal");
  await expect(probability).toHaveValue("37");
  await page.locator("#stage").selectOption("negotiation");
  await expect(probability).toHaveValue("37");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(page.getByRole("button", { name: "Сохранить", exact: true })).toBeDisabled();
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0]).toMatchObject({ stage: "negotiation", probability: 37 });
  await expect(probability).toHaveValue("37");
  await page.reload();
  await expect(page.locator("#stage")).toHaveValue("negotiation");
  await expect(probability).toHaveValue("37");
  expect(state.unexpected).toEqual([]);
});

test("customer PUT: прочая правка сохраняет серверную вероятность, смена этапа обновляет её из справочника", async ({ page }) => {
  const state = await mockApi(page, CUSTOMER);
  await page.goto("/projects/42");
  await expect(page.locator("#stage")).toHaveCount(0);
  const probability = page.getByLabel("Вероятность", { exact: false });
  const stage = page.getByLabel("Этап по ТЗ", { exact: false });
  await expect(probability).toHaveValue("17");
  await expect(page.locator("[data-completion-state]")).toHaveText("Состояние завершения: не определено");
  await expect(probability).toHaveAttribute("readonly", "");
  // Сохранено 17, хотя refs исходного этапа теперь содержит 11: возврат A→B→A не обещает пересчёт.
  await stage.selectOption("103");
  await expect(probability).toHaveValue("25");
  await stage.selectOption("102");
  await expect(probability).toHaveValue("17");
  await expect(page.getByRole("button", { name: "Сохранить", exact: true })).toBeDisabled();
  expect(state.writes).toEqual([]);
  await page.getByLabel("Суть проекта").fill("Правка без смены этапа");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(page.getByText(/Сохранено в/)).toBeVisible();
  await expect(probability).toHaveValue("17");
  expect(state.current?.probability).toBe(17);
  await stage.selectOption("103");
  await expect(probability).toHaveValue("25");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(page.getByRole("button", { name: "Сохранить", exact: true })).toBeDisabled();
  await page.reload();
  await expect(stage).toHaveValue("103");
  await expect(probability).toHaveValue("25");
  expect(state.writes).toHaveLength(2);
  expect(state.current).toMatchObject({ stage_scheme: "customer", stage: null, probability: 25 });
  expect(state.unexpected).toEqual([]);
});

test("прежний черновик новой карточки не возвращает lead и требует явного customer-stage", async ({ page }) => {
  const state = await mockApi(page, null);
  await fillNewProject(page);
  await expect.poll(() => page.evaluate(() => localStorage.getItem("project-draft"))).not.toBeNull();
  await page.evaluate(() => {
    const draft = JSON.parse(localStorage.getItem("project-draft")!);
    localStorage.setItem("project-draft", JSON.stringify({ ...draft, stage: "lead", probability: "99" }));
  });
  await page.reload();
  await expect(page.getByText("Восстановлен несохранённый черновик.", { exact: false })).toBeVisible();
  await expect(page.locator("#stage")).toHaveCount(0);
  await expect(page.getByLabel("Вероятность", { exact: false })).toHaveValue("");
  await page.getByRole("button", { name: "Создать проект", exact: true }).click();
  await expect(page.getByText("Выберите этап проекта", { exact: true })).toBeVisible();
  expect(state.writes).toEqual([]);
  await page.getByLabel("Этап по ТЗ", { exact: false }).selectOption("101");
  await page.getByRole("button", { name: "Создать проект", exact: true }).click();
  await expect(page).toHaveURL(/\/projects\/42$/);
  expect(state.writes[0].customer_stage_id).toBe(101);
  expect(state.unexpected).toEqual([]);
});
