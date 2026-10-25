import { expect, test, type Locator, type Page } from "@playwright/test";

import type { ClientItem, FinancialEntry, Project, Refs, User } from "../../src/lib/types";

const USER: User = { id: 1, email: "financial-recovery@example.test", full_name: "Тестовый менеджер", role: "user" };
const REFS: Refs = {
  segments: [{ id: 2, name: "Корпоративные клиенты" }],
  services: [{ id: 3, name: "Интернет", group_name: "Связь" }],
  managers: [{ id: USER.id, full_name: USER.full_name }],
  stages: [{ id: "lead", name: "Лид", probability: 10 }],
  payment_types: [{ id: 5, name: "Ежемесячный" }],
  assessment_statuses: [{ id: 6, name: "Принят к оценке" }],
  project_indicators: [{ id: 7, name: "В работе" }],
  customer_stages: [{ id: 8, name: "Подготовка предложения", probability: 30 }],
  cost_articles: [{ id: 9, name: "Оборудование" }],
  cost_types: [{ id: 11, name: "Прямые затраты" }],
  revenue_statuses: [{ id: 4, name: "План выручки" }],
  cost_statuses: [{ id: 12, name: "План затрат" }],
  roles: [{ id: "user", name: "Пользователь" }, { id: "analyst", name: "Аналитик" }],
};
const CLIENT: ClientItem = { id: 10, name: "Тестовый клиент", inn: "7707083893", segment: REFS.segments[0] };
const PROJECT: Project = {
  id: 51, name: "Исходный проект", description: "Исходное описание",
  client: { id: CLIENT.id, name: CLIENT.name }, segment: CLIENT.segment,
  service: REFS.services[0], manager: REFS.managers[0], stage: "lead",
  amount: "10000.00", cost: "2000.00", margin: "8000.00", margin_pct: 80, probability: 10,
  start_date: "2026-10-01", expected_close_date: "2026-12-01", closed_at: null,
  payment_type: null, customer_stage: null, indicator: null, accepted_for_forecast: false,
  assessment_status: null, subsidiary_implementation: false, management_control: false,
  is_industry_solution: false, industry_manager: null, industry_project_number: null,
  implementation_year: null, project_status: null, realized_work: "", period_plan: "",
  created_at: "2026-10-01T10:00:00Z", updated_at: "2026-10-24T10:00:00Z",
  financial_entries: [
    { id: 20, kind: "revenue", year: 2026, month: 10, amount: "2500.500", vat_included: true, status: REFS.revenue_statuses[0] },
    {
      id: 21, kind: "cost", year: 2026, month: 10, amount: "500.250", vat_included: false,
      status: REFS.cost_statuses[0], article: REFS.cost_articles[0], cost_type: REFS.cost_types[0],
    },
  ],
};

type ProjectWrite = Pick<Project, "name" | "description" | "amount" | "cost" | "stage" | "probability" |
  "start_date" | "expected_close_date" | "period_plan"> & {
  client_id: number;
  service_id: number;
  manager_id: number;
};
type FinancialWrite = Pick<FinancialEntry, "kind" | "year" | "month" | "amount" | "vat_included"> & {
  status_id: number;
  article_id: number | null;
  cost_type_id: number | null;
};
const FINANCIAL_ROWS: FinancialWrite[] = [
  {
    kind: "revenue", year: 2027, month: 2, amount: "1234.567", vat_included: false,
    status_id: 4, article_id: null, cost_type_id: null,
  },
  {
    kind: "cost", year: 2027, month: 3, amount: "234.789", vat_included: true,
    status_id: 12, article_id: 9, cost_type_id: 11,
  },
];
const ORIGINAL_ROWS: FinancialWrite[] = PROJECT.financial_entries.map((entry) => ({
  kind: entry.kind, year: entry.year, month: entry.month, amount: entry.amount,
  vat_included: entry.vat_included, status_id: entry.status!.id,
  article_id: entry.article?.id ?? null, cost_type_id: entry.cost_type?.id ?? null,
}));

async function mockApi(page: Page, editing = false, options: { financialFailures?: number; finalGet?: Promise<void> } = {}) {
  const state = {
    current: editing ? structuredClone(PROJECT) : null as Project | null,
    creates: [] as ProjectWrite[],
    updates: [] as ProjectWrite[],
    financialUpdates: [] as FinancialWrite[][],
    reads: [] as Project[],
    writes: [] as string[],
    nameChecks: [] as { name: string | null; clientId: string | null; excludeId: string | null }[],
    unexpected: [] as string[],
  };
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^\/api/, "");
    const method = request.method();
    if (method === "GET") {
      if (path === "/auth/me") return route.fulfill({ json: { ...USER, role: editing ? "analyst" : "user" } });
      if (path === "/refs") return route.fulfill({ json: REFS });
      if (path === "/clients") return route.fulfill({ json: [CLIENT] });
      if (path === "/dashboards") return route.fulfill({ json: [] });
      // Пустой ProjectHistoryPage для страницы с интегрированным журналом изменений.
      if (path === `/projects/${PROJECT.id}/history`) {
        return route.fulfill({ json: { items: [], limit: 10, offset: 0, has_more: false } });
      }
      if (path === "/projects/check-name") {
        const check = {
          name: url.searchParams.get("name"),
          clientId: url.searchParams.get("client_id"),
          excludeId: url.searchParams.get("exclude_id"),
        };
        state.nameChecks.push(check);
        // Сохранённая карточка конфликтует сама с собой, если форма забыла exclude_id.
        const duplicate = state.current && check.name === state.current.name &&
          check.clientId === String(CLIENT.id) && check.excludeId !== String(PROJECT.id);
        return route.fulfill({ json: { available: !duplicate } });
      }
      if (path === `/projects/${PROJECT.id}` && state.current) {
        const snapshot = structuredClone(state.current);
        state.reads.push(snapshot);
        if (state.financialUpdates.length > (options.financialFailures ?? 1)) await options.finalGet;
        return route.fulfill({ json: snapshot });
      }
    }
    if (method === "POST" && path === "/projects") {
      const body: ProjectWrite = request.postDataJSON();
      state.creates.push(body);
      state.writes.push("POST /projects");
      if (state.current) return route.fulfill({ status: 409, json: { detail: "Карточка уже существует" } });
      state.current = { ...PROJECT, ...body, financial_entries: [], updated_at: "2026-10-25T10:00:00Z" };
      return route.fulfill({ status: 201, json: state.current });
    }
    if (method === "PUT" && path === `/projects/${PROJECT.id}` && state.current) {
      const body: ProjectWrite = request.postDataJSON();
      state.updates.push(body);
      state.writes.push(`PUT /projects/${PROJECT.id}`);
      state.current = { ...state.current, ...body, updated_at: "2026-10-25T11:00:00Z" };
      return route.fulfill({ json: state.current });
    }
    if (method === "PUT" && path === `/projects/${PROJECT.id}/financial-entries` && state.current) {
      const rows: FinancialWrite[] = request.postDataJSON();
      state.financialUpdates.push(rows);
      state.writes.push(`PUT /projects/${PROJECT.id}/financial-entries`);
      if (state.financialUpdates.length <= (options.financialFailures ?? 1)) return route.fulfill({ status: 503, body: "" });
      // GET возвращает сохранённые строки, включая справочники; суммы и НДС не пересчитываются.
      state.current = {
        ...state.current,
        updated_at: "2026-10-25T12:00:00Z",
        financial_entries: rows.map((row, index) => ({
          id: 30 + index, kind: row.kind, year: row.year, month: row.month,
          amount: row.amount, vat_included: row.vat_included,
          status: (row.kind === "revenue" ? REFS.revenue_statuses : REFS.cost_statuses).find((item) => item.id === row.status_id),
          article: REFS.cost_articles.find((item) => item.id === row.article_id) ?? null,
          cost_type: REFS.cost_types.find((item) => item.id === row.cost_type_id) ?? null,
        })),
      };
      return route.fulfill({ json: state.current.financial_entries });
    }
    // Неизвестные запросы не должны попадать в настоящий backend.
    state.unexpected.push(`${method} ${path}`);
    return route.fulfill({ status: 500, json: { detail: `Не задан тестовый ответ: ${method} ${path}` } });
  });
  return state;
}

function financialRow(page: Page, index: number) {
  return page.getByRole("group", { name: "Помесячная выручка и затраты" }).locator(".row2").nth(index);
}

async function fillFinancialRow(row: Locator, entry: FinancialWrite) {
  // У переключателя вида строки пока нет подписи; остальные поля доступны по имени.
  await row.getByRole("combobox").first().selectOption(entry.kind);
  await row.getByLabel("Год", { exact: true }).fill(String(entry.year));
  await row.getByLabel("Месяц", { exact: true }).selectOption(String(entry.month));
  await row.getByLabel("Сумма, тыс. рублей").fill(entry.amount);
  await row.getByLabel("НДС", { exact: true }).selectOption(entry.vat_included ? "yes" : "no");
  if (entry.kind === "cost") {
    await row.getByLabel("Статья затрат").selectOption(String(entry.article_id));
    await row.getByLabel("Вид затрат").selectOption(String(entry.cost_type_id));
  }
  await row.getByLabel(entry.kind === "revenue" ? "Статус начисления выручки" : "Статус затрат")
    .selectOption(String(entry.status_id));
}

async function expectFinancialRows(page: Page, entries = FINANCIAL_ROWS) {
  await expect(page.getByLabel("Сумма, тыс. рублей")).toHaveCount(entries.length);
  for (const [index, entry] of entries.entries()) {
    const row = financialRow(page, index);
    await expect(row.getByRole("combobox").first()).toHaveValue(entry.kind);
    await expect(row.getByLabel("Год", { exact: true })).toHaveValue(String(entry.year));
    await expect(row.getByLabel("Месяц", { exact: true })).toHaveValue(String(entry.month));
    await expect(row.getByLabel("Сумма, тыс. рублей")).toHaveValue(entry.amount);
    await expect(row.getByLabel("НДС", { exact: true })).toHaveValue(entry.vat_included ? "yes" : "no");
    await expect(row.getByLabel(entry.kind === "revenue" ? "Статус начисления выручки" : "Статус затрат"))
      .toHaveValue(String(entry.status_id));
    if (entry.kind === "cost") {
      await expect(row.getByLabel("Статья затрат")).toHaveValue(String(entry.article_id));
      await expect(row.getByLabel("Вид затрат")).toHaveValue(String(entry.cost_type_id));
    }
  }
}

async function expectCard(page: Page, name: string) {
  await expect(page.getByLabel(/Название проекта/)).toHaveValue(name);
  await expect(page.getByLabel(/Клиент/)).toHaveValue(CLIENT.name);
  await expect(page.getByLabel(/Услуга/)).toHaveValue("3");
  await expect(page.getByLabel("Суть проекта")).toHaveValue("Правки до сбоя финансового сервиса");
  await expect(page.getByLabel(/Сумма контракта/)).toHaveValue("10000");
  await expect(page.getByLabel(/Себестоимость/)).toHaveValue("2000");
  await expect(page.getByLabel(/Дата начала/)).toHaveValue("2026-10-01");
  await expect(page.getByLabel(/Плановое закрытие/)).toHaveValue("2026-12-01");
  await expect(page.getByLabel("Планы на период")).toHaveValue("Завершить подключение клиента");
}

function partialMessage(page: Page) {
  return page.locator(".form-footer .alert");
}

async function expectPartialSave(page: Page) {
  await expect(partialMessage(page)).toContainText("Карточка сохранена.");
  await expect(partialMessage(page)).toContainText("Не удалось подтвердить сохранение финансовых строк.");
  await expect(partialMessage(page)).toContainText("Повторите сохранение — новая карточка не создастся.");
  await expect(partialMessage(page)).toContainText("503");
  await expect(page.getByText(/Сохранено в/)).toHaveCount(0);
  await expect(page.getByText("У этого клиента уже есть проект с таким названием")).toHaveCount(0);
}

async function editCard(page: Page, name: string) {
  await page.getByLabel(/Название проекта/).fill(name);
  await page.getByLabel("Суть проекта").fill("Правки до сбоя финансового сервиса");
  await page.getByLabel("Планы на период").fill("Завершить подключение клиента");
}

test("новая карточка: после 503 финансовые строки сохраняются повтором без второго POST", async ({ page }) => {
  const state = await mockApi(page);
  const name = "Новый проект с восстановлением финансов";
  await page.goto("/projects/new");
  await editCard(page, name);
  await page.getByLabel(/Клиент/).fill("Тестовый");
  await page.getByRole("button", { name: /Тестовый клиент ИНН/ }).click();
  await page.getByLabel(/Услуга/).selectOption("3");
  await expect(page.getByLabel(/Ответственный/)).toHaveValue(USER.full_name);
  await page.getByLabel(/Сумма контракта/).fill("10000");
  await page.getByLabel(/Себестоимость/).fill("2000");
  await page.getByLabel(/Дата начала/).fill("2026-10-01");
  await page.getByLabel(/Плановое закрытие/).fill("2026-12-01");
  for (const [index, entry] of FINANCIAL_ROWS.entries()) {
    await page.getByRole("button", { name: "Добавить финансовую строку", exact: true }).click();
    await fillFinancialRow(financialRow(page, index), entry);
  }
  await expect.poll(() => state.nameChecks).toContainEqual({ name, clientId: "10", excludeId: null });
  const [created, failed] = await Promise.all([
    page.waitForResponse((response) => new URL(response.url()).pathname === "/api/projects" && response.request().method() === "POST"),
    page.waitForResponse((response) => response.url().endsWith(`/api/projects/${PROJECT.id}/financial-entries`) && response.status() === 503),
    page.getByRole("button", { name: "Создать проект", exact: true }).click(),
  ]);
  expect(created.status()).toBe(201);
  expect(failed.request().postDataJSON()).toEqual(FINANCIAL_ROWS);
  await expectPartialSave(page);
  await expect(page).toHaveURL(/\/projects\/new$/);
  await expectCard(page, name);
  await expectFinancialRows(page);
  expect(state.current?.financial_entries).toEqual([]);
  expect(state.creates).toHaveLength(1);
  expect(state.updates).toHaveLength(0);
  expect(state.financialUpdates).toEqual([FINANCIAL_ROWS]);
  await expect.poll(() => state.nameChecks).toContainEqual({ name, clientId: "10", excludeId: String(PROJECT.id) });
  await expect(page.getByRole("button", { name: "Повторить сохранение", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Повторить сохранение", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT.id}$`));
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  await expectCard(page, name);
  await expectFinancialRows(page);
  await expect(partialMessage(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Сохранить", exact: true })).toBeDisabled();
  expect(state.creates).toHaveLength(1);
  expect(state.updates).toEqual(state.creates);
  expect(state.creates[0]).toMatchObject({ name, client_id: CLIENT.id, service_id: 3, manager_id: USER.id, amount: "10000.00", cost: "2000.00" });
  expect(state.financialUpdates).toEqual([FINANCIAL_ROWS, FINANCIAL_ROWS]);
  expect(state.writes).toEqual([
    "POST /projects", `PUT /projects/${PROJECT.id}/financial-entries`,
    `PUT /projects/${PROJECT.id}`, `PUT /projects/${PROJECT.id}/financial-entries`,
  ]);
  expect(state.reads.at(-1)?.financial_entries).toEqual(state.current?.financial_entries);
  expect(state.current?.financial_entries).toHaveLength(2);
  expect(state.unexpected).toEqual([]);
});

test("существующая карточка: ошибка финансов сохраняет правки и обе строки до успешного повтора", async ({ page }) => {
  const state = await mockApi(page, true);
  const name = "Изменённый проект с восстановлением финансов";
  await page.goto(`/projects/${PROJECT.id}`);
  await expect(page.getByLabel(/Название проекта/)).toHaveValue(PROJECT.name);
  await expect.poll(() => state.nameChecks).toContainEqual({ name: PROJECT.name, clientId: "10", excludeId: String(PROJECT.id) });
  await editCard(page, name);
  for (const [index, entry] of FINANCIAL_ROWS.entries()) await fillFinancialRow(financialRow(page, index), entry);
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expectPartialSave(page);
  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT.id}$`));
  await expectCard(page, name);
  await expectFinancialRows(page);
  expect(state.current?.name).toBe(name);
  expect(state.current?.financial_entries).toEqual(PROJECT.financial_entries);
  expect(state.creates).toHaveLength(0);
  expect(state.updates).toHaveLength(1);
  expect(state.financialUpdates).toEqual([FINANCIAL_ROWS]);
  await expect.poll(() => state.nameChecks).toContainEqual({ name, clientId: "10", excludeId: String(PROJECT.id) });
  await expect(page.getByRole("button", { name: "Сохранить", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(partialMessage(page)).toHaveCount(0);
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Сохранить", exact: true })).toBeDisabled();
  await expectCard(page, name);
  await expectFinancialRows(page);
  // Повторное открытие проверяет GET с сохранёнными данными, а не только локальный state формы.
  await page.reload();
  await expectCard(page, name);
  await expectFinancialRows(page);
  await expect(page.getByRole("button", { name: "Сохранить", exact: true })).toBeDisabled();
  expect(state.creates).toHaveLength(0);
  expect(state.updates).toHaveLength(2);
  expect(state.updates[1]).toEqual(state.updates[0]);
  expect(state.financialUpdates).toEqual([FINANCIAL_ROWS, FINANCIAL_ROWS]);
  expect(state.writes).toEqual([
    `PUT /projects/${PROJECT.id}`, `PUT /projects/${PROJECT.id}/financial-entries`,
    `PUT /projects/${PROJECT.id}`, `PUT /projects/${PROJECT.id}/financial-entries`,
  ]);
  expect(state.nameChecks.every((check) => check.excludeId === String(PROJECT.id))).toBe(true);
  expect(state.reads.at(-1)?.financial_entries).toEqual(state.current?.financial_entries);
  expect(state.current?.financial_entries).toHaveLength(2);
  expect(state.unexpected).toEqual([]);
});

test("IF01: задержанный завершающий GET блокирует поля и финансовые действия до подтверждения", async ({ page }) => {
  let releaseGet!: () => void;
  const finalGet = new Promise<void>((resolve) => { releaseGet = resolve; });
  const state = await mockApi(page, true, { financialFailures: 0, finalGet });
  const name = "Проект с ожиданием подтверждения";
  await page.goto(`/projects/${PROJECT.id}`);
  await editCard(page, name);
  for (const [index, entry] of FINANCIAL_ROWS.entries()) await fillFinancialRow(financialRow(page, index), entry);
  try {
    await page.getByRole("button", { name: "Сохранить", exact: true }).click();
    // Первый GET загружает форму, второй остаётся незавершённым после двух успешных PUT.
    await expect.poll(() => state.reads.length).toBe(2);
    expect(state.updates).toHaveLength(1);
    expect(state.financialUpdates).toEqual([FINANCIAL_ROWS]);
    await expect(page.getByRole("button", { name: "Сохраняем…", exact: true })).toBeDisabled();
    const fields = page.locator("form.card fieldset");
    await expect(fields).toHaveCount(2);
    for (const fieldset of await fields.all()) await expect(fieldset).toHaveAttribute("disabled", "");
    for (const input of await fields.locator("input, select, textarea, button").all()) await expect(input).toBeDisabled();
    await expect(page.getByLabel(/Клиент/)).toBeDisabled();
    await expectCard(page, name);
    await expectFinancialRows(page);
    await expect(page.getByText(/Сохранено в/)).toHaveCount(0);
  } finally {
    releaseGet();
  }
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Сохранить", exact: true })).toBeDisabled();
  await expect(page.getByLabel("Суть проекта")).toBeEnabled();
  await expect(page.getByLabel(/Клиент/)).toBeEnabled();
  await expect(financialRow(page, 0).getByLabel("Сумма, тыс. рублей")).toBeEnabled();
  await expect(page.getByRole("button", { name: "Добавить финансовую строку", exact: true })).toBeEnabled();
  await expectCard(page, name);
  await expectFinancialRows(page);
  expect(state.creates).toHaveLength(0);
  expect(state.current?.description).toBe("Правки до сбоя финансового сервиса");
  expect(state.unexpected).toEqual([]);
});

test("IF02: возврат всех правок к исходным значениям после 503 оставляет повтор доступным", async ({ page }) => {
  const state = await mockApi(page, true);
  const name = "Имя уже записано на сервере";
  await page.goto(`/projects/${PROJECT.id}`);
  const save = page.getByRole("button", { name: "Сохранить", exact: true });
  await expect(save).toBeDisabled();
  await editCard(page, name);
  await page.getByLabel(/Сумма контракта/).fill("12000");
  await page.getByLabel(/Себестоимость/).fill("2500");
  for (const [index, entry] of FINANCIAL_ROWS.entries()) await fillFinancialRow(financialRow(page, index), entry);
  await save.click();
  await expectPartialSave(page);
  expect(state.current?.name).toBe(name);
  expect(state.current?.financial_entries).toEqual(PROJECT.financial_entries);

  // Возвращаем каждое изменённое поле и строку к baseline, без посторонней правки для разблокировки.
  await page.getByLabel(/Название проекта/).fill(PROJECT.name);
  await page.getByLabel("Суть проекта").fill(PROJECT.description);
  await page.getByLabel("Планы на период").fill(PROJECT.period_plan);
  await page.getByLabel(/Сумма контракта/).fill(String(Number(PROJECT.amount)));
  await page.getByLabel(/Себестоимость/).fill(String(Number(PROJECT.cost)));
  for (const [index, entry] of ORIGINAL_ROWS.entries()) await fillFinancialRow(financialRow(page, index), entry);
  await expectFinancialRows(page, ORIGINAL_ROWS);
  await expect(save).toBeEnabled();
  await expectPartialSave(page);
  expect(state.current?.name).toBe(name);
  expect(state.updates).toHaveLength(1);
  await save.click();
  await expect(partialMessage(page)).toHaveCount(0);
  await expect(page.getByRole("heading", { name: PROJECT.name, exact: true })).toBeVisible();
  await expect(save).toBeDisabled();
  await page.reload();
  await expect(page.getByLabel(/Название проекта/)).toHaveValue(PROJECT.name);
  await expect(page.getByLabel("Суть проекта")).toHaveValue(PROJECT.description);
  await expect(page.getByLabel("Планы на период")).toHaveValue(PROJECT.period_plan);
  await expectFinancialRows(page, ORIGINAL_ROWS);
  await expect(save).toBeDisabled();
  expect(state.creates).toHaveLength(0);
  expect(state.updates).toHaveLength(2);
  expect(state.updates[1]).toEqual({
    ...state.updates[0], name: PROJECT.name, description: PROJECT.description,
    period_plan: PROJECT.period_plan, amount: PROJECT.amount, cost: PROJECT.cost,
  });
  expect(state.financialUpdates).toEqual([FINANCIAL_ROWS, ORIGINAL_ROWS]);
  expect(state.reads.at(-1)?.name).toBe(PROJECT.name);
  expect(state.current?.financial_entries).toHaveLength(ORIGINAL_ROWS.length);
  expect(state.unexpected).toEqual([]);
});
