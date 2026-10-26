import { expect, test, type Page } from "@playwright/test";

import type { ClientItem, Project, Refs, User } from "../../src/lib/types";

const USER: User = { id: 1, email: "card@example.test", full_name: "Менеджер карточки", role: "user" };
const REFS: Refs = {
  segments: [{ id: 1, name: "Сегмент" }], services: [{ id: 1, name: "Интернет", group_name: null }],
  managers: [{ id: USER.id, full_name: USER.full_name }], stages: [{ id: "lead", name: "Лид", probability: 10 }],
  payment_types: [], assessment_statuses: [{ id: 2, name: "ОЦЕНКА" }], project_indicators: [],
  customer_stages: [{ id: 10, name: "Этап нового проекта", probability: 25 }],
  cost_articles: [], cost_types: [], revenue_statuses: [], cost_statuses: [], roles: [{ id: "user", name: "Пользователь" }],
};
const CLIENT: ClientItem = { id: 1, name: "Клиент карточки", inn: "7707083893", segment: REFS.segments[0] };
const PROJECT: Project = {
  id: 51, name: "Проверка карточки", description: "", client: CLIENT, segment: CLIENT.segment,
  manager: REFS.managers[0], service: REFS.services[0], stage: "lead", probability: 10,
  amount: "100.00", cost: "0.00", margin: "100.00", margin_pct: 100,
  start_date: "2026-10-01", expected_close_date: "2026-12-01", closed_at: null,
  payment_type: null, customer_stage: null, indicator: null, accepted_for_forecast: false,
  assessment_status: null, subsidiary_implementation: false, management_control: false,
  is_industry_solution: false, industry_manager: null, industry_project_number: null, implementation_year: null,
  project_status: null, realized_work: "", period_plan: "", financial_entries: [],
  created_at: "2026-10-01T10:00:00Z", updated_at: "2026-10-01T10:00:00Z",
};
const TEXT_FIELDS = [
  ["project_status", "Статус проекта"], ["realized_work", "Сделано за период"], ["period_plan", "Планы на период"],
] as const;

async function openCard(page: Page, editing: boolean, initial: Partial<Project> = {}) {
  const state = { current: { ...structuredClone(PROJECT), ...initial }, writes: [] as Record<string, unknown>[] };
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^\/api/, "");
    if (request.method() === "GET") {
      if (path === "/auth/me") return route.fulfill({ json: USER });
      if (path === "/refs") return route.fulfill({ json: REFS });
      if (path === "/clients") return route.fulfill({ json: [CLIENT] });
      if (path === "/dashboards") return route.fulfill({ json: [] });
      if (path === "/projects/check-name") return route.fulfill({ json: { available: true } });
      if (path === `/projects/${PROJECT.id}`) return route.fulfill({ json: state.current });
      if (path === `/projects/${PROJECT.id}/history`) {
        return route.fulfill({ json: { items: [], limit: 10, offset: 0, has_more: false } });
      }
    }
    if ((request.method() === "POST" && path === "/projects") ||
        (request.method() === "PUT" && path === `/projects/${PROJECT.id}`)) {
      const body = request.postDataJSON();
      expect(body).not.toHaveProperty("stage_scheme");
      if (request.method() === "POST") {
        expect(body.customer_stage_id).toBe(10);
        expect(body).not.toHaveProperty("stage");
        expect(body).not.toHaveProperty("probability");
      }
      state.writes.push(body);
      state.current = {
        ...state.current, ...body,
        ...(request.method() === "POST" ? { stage_scheme: "customer", stage: null, customer_stage: REFS.customer_stages[0], probability: 25 } : {}),
      };
      return route.fulfill({ status: request.method() === "POST" ? 201 : 200, json: state.current });
    }
    if (request.method() === "PUT" && path === `/projects/${PROJECT.id}/financial-entries`) {
      return route.fulfill({ json: [] });
    }
    throw new Error(`Неожиданный запрос: ${request.method()} ${path}`);
  });
  await page.goto(editing ? `/projects/${PROJECT.id}` : "/projects/new");
  await expect(page.getByLabel("Статус проекта", { exact: true })).toBeVisible();
  if (!editing) {
    await page.getByLabel(/Название проекта/).fill(PROJECT.name);
    await page.getByLabel(/Клиент/).fill("Клиент");
    await page.getByRole("button", { name: `${CLIENT.name} ИНН ${CLIENT.inn}`, exact: true }).click();
    await page.getByLabel(/Услуга/).selectOption("1");
    await page.getByLabel("Этап по ТЗ", { exact: false }).selectOption("10");
    await page.getByLabel(/Сумма контракта/).fill("100");
    await page.getByLabel(/Дата начала/).fill(PROJECT.start_date);
    await page.getByLabel(/Плановое закрытие/).fill(PROJECT.expected_close_date);
  }
  return state;
}

function saveButton(page: Page, editing: boolean) {
  return page.getByRole("button", { name: editing ? "Сохранить" : "Создать проект", exact: true });
}

for (const editing of [false, true]) {
  const mode = editing ? "изменение" : "создание";
  for (const character of ["Я", "🚀"]) {
    for (const length of [0, 999, 1000]) {
      test(`${mode}: три текста по ${length} символов ${character} сохраняются полностью`, async ({ page }) => {
        const state = await openCard(page, editing);
        if (!editing) {
          await expect(page.getByLabel("Дата создания", { exact: true })).toHaveValue("Будет назначена при создании");
        }
        const value = length ? ` ${character.repeat(length - 2)} ` : "";
        for (const [, label] of TEXT_FIELDS) await page.getByLabel(label, { exact: true }).fill(value);
        // Пустые значения тоже должны позволять сохранить изменённую карточку.
        if (editing && !length) await page.getByLabel(/Название проекта/).fill("Проверка пустых текстов");
        await saveButton(page, editing).click();
        await expect.poll(() => state.writes.length).toBe(1);
        await expect(saveButton(page, true)).toBeDisabled();
        await page.reload();
        for (const [field, label] of TEXT_FIELDS) {
          expect(state.writes[0][field]).toBe(field === "project_status" && !value ? null : value);
          await expect(page.getByLabel(label, { exact: true })).toHaveValue(value);
        }
        await expect(page.getByLabel("Дата создания", { exact: true })).toHaveValue("01.10.2026");
        expect(state.writes[0]).not.toHaveProperty("created_at");
      });
    }
    for (const [field, label] of TEXT_FIELDS) {
      test(`${mode}: ${field} — 1001 символ ${character} отклонён до отправки`, async ({ page }) => {
        const state = await openCard(page, editing);
        const input = page.getByLabel(label, { exact: true });
        const value = character.repeat(1001);
        await input.fill(value);
        await input.blur();
        const error = page.locator(".field").filter({ has: input }).locator(".error");
        await expect(error).toHaveText("Не длиннее 1000 символов");
        await saveButton(page, editing).click();
        await expect(error).toBeVisible();
        await expect(input).toHaveValue(value);
        expect(state.writes).toHaveLength(0);
        // Исправление до границы сразу снимает ошибку и разрешает сохранение.
        await input.fill(character.repeat(1000));
        await expect(error).toHaveText("");
        await saveButton(page, editing).click();
        await expect.poll(() => state.writes.length).toBe(1);
        expect(state.writes[0][field]).toBe(character.repeat(1000));
      });
    }
  }
}

test("старые длинные тексты видны целиком и не обрезаются при отклонённом сохранении", async ({ page }) => {
  const original = { realized_work: "Р".repeat(2000), period_plan: "П".repeat(5000) };
  const state = await openCard(page, true, original);
  await expect(page.getByLabel("Сделано за период", { exact: true })).toHaveValue(original.realized_work);
  await expect(page.getByLabel("Планы на период", { exact: true })).toHaveValue(original.period_plan);
  await page.getByLabel(/Название проекта/).fill("Длинные тексты сохранены");
  await saveButton(page, true).click();
  await expect(page.getByText("Не длиннее 1000 символов", { exact: true })).toHaveCount(2);
  expect(state.writes).toHaveLength(0);
  await expect(page.getByLabel("Сделано за период", { exact: true })).toHaveValue(original.realized_work);
  await expect(page.getByLabel("Планы на период", { exact: true })).toHaveValue(original.period_plan);
});

test("все три текста сохраняют переводы строк на границе 1000 символов", async ({ page }) => {
  const state = await openCard(page, true);
  const prefix = "Первая строка\n";
  const value = prefix + "Я".repeat(1000 - Array.from(prefix).length);
  for (const [, label] of TEXT_FIELDS) {
    await page.getByLabel(label, { exact: true }).fill(value);
    await expect(page.getByLabel(label, { exact: true })).toHaveValue(value);
  }
  await saveButton(page, true).click();
  await expect(saveButton(page, true)).toBeDisabled();
  await page.reload();
  for (const [field, label] of TEXT_FIELDS) {
    expect(state.writes[0][field]).toBe(value);
    await expect(page.getByLabel(label, { exact: true })).toHaveValue(value);
  }
});

test("дата создания отображается только для чтения и не отправляется при изменениях", async ({ page }) => {
  const state = await openCard(page, true);
  const createdAt = page.getByLabel("Дата создания", { exact: true });
  await expect(createdAt).toHaveValue("01.10.2026");
  await expect(createdAt).toHaveAttribute("readonly", "");
  for (const value of ["Первое изменение", "Второе изменение"]) {
    await page.getByLabel("Статус проекта", { exact: true }).fill(value);
    await saveButton(page, true).click();
    await expect(page.getByText(/Сохранено в/)).toBeVisible();
    await expect(createdAt).toHaveValue("01.10.2026");
  }
  expect(state.writes).toHaveLength(2);
  for (const body of state.writes) expect(body).not.toHaveProperty("created_at");
});

test("год остаётся одним целым годом, зависимые поля доступны по флагам", async ({ page }) => {
  const state = await openCard(page, true);
  const year = page.getByLabel("Год реализации", { exact: true });
  await year.fill("2027-01-01");
  await year.blur();
  await expect(page.getByText("Введите год от 1900 до 2200", { exact: true })).toBeVisible();
  await saveButton(page, true).click();
  expect(state.writes).toHaveLength(0);
  await year.fill("2027");
  await expect(page.getByLabel("Принимаемый к оценке", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Отраслевой менеджер", { exact: true })).toHaveCount(0);
  await page.getByLabel("Принимаемый к прогнозу", { exact: true }).check();
  await page.getByLabel("Принимаемый к оценке", { exact: true }).selectOption("2");
  await page.getByLabel("Отраслевое решение", { exact: true }).check();
  await page.getByLabel("Отраслевой менеджер", { exact: true }).fill("Иван Петров");
  await page.getByLabel("Номер отраслевого проекта", { exact: true }).fill("IND-42");
  await saveButton(page, true).click();
  await expect.poll(() => state.writes.length).toBe(1);
  expect(state.writes[0]).toMatchObject({
    implementation_year: 2027, accepted_for_forecast: true, assessment_status_id: 2,
    is_industry_solution: true, industry_manager: "Иван Петров", industry_project_number: "IND-42",
  });
  await expect(page.getByText(/Сохранено в/)).toBeVisible();
  await page.getByLabel("Принимаемый к прогнозу", { exact: true }).uncheck();
  await page.getByLabel("Отраслевое решение", { exact: true }).uncheck();
  await expect(page.getByLabel("Принимаемый к оценке", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Номер отраслевого проекта", { exact: true })).toHaveCount(0);
  await saveButton(page, true).click();
  await expect.poll(() => state.writes.length).toBe(2);
  expect(state.writes[1]).toMatchObject({
    implementation_year: 2027, accepted_for_forecast: false, assessment_status_id: null,
    is_industry_solution: false, industry_manager: null, industry_project_number: null,
  });
});
