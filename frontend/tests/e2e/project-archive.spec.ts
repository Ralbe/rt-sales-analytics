import { expect, test as base, type Page } from "@playwright/test";

import type { ProjectHistoryItem } from "../../src/lib/history-types";
import type { Project, Refs, Role } from "../../src/lib/types";

const author = { id: 7, full_name: "Мария Продажина" };
const archivedAt = "2026-10-26T10:20:30Z";
const refs: Refs = {
  segments: [{ id: 1, name: "Корпоративные клиенты" }],
  services: [{ id: 2, name: "Облачные услуги", group_name: null }],
  managers: [author],
  stages: [{ id: "proposal", name: "КП отправлено", probability: 50 }],
  payment_types: [], customer_stages: [], project_indicators: [], assessment_statuses: [],
  cost_articles: [{ id: 30, name: "Оборудование" }],
  cost_types: [{ id: 31, name: "Разовые затраты" }],
  revenue_statuses: [{ id: 20, name: "Начислено" }],
  cost_statuses: [{ id: 21, name: "Подтверждено" }], roles: [],
};

type ArchiveProject = Project & { archived_at: string | null };
type ArchiveAction = "archive" | "restore";
type ApiState = {
  role: Role;
  project: ArchiveProject;
  history: ProjectHistoryItem[];
  historyRequests: number;
  actions: ArchiveAction[];
  listQueries: Record<string, string>[];
  mutationError: { status: number; detail: string } | null;
  unexpectedRequests: string[];
};

function projectFixture(): ArchiveProject {
  return {
    id: 42, name: "Проект для архива", description: "Внедрение облачных сервисов",
    client: { id: 1, name: "ООО «Заказчик»" }, segment: refs.segments[0], manager: author,
    service: refs.services[0], stage: "proposal", amount: "1250000.50", cost: "250000.25",
    margin: "1000000.25", margin_pct: 80, probability: 50,
    start_date: "2026-10-01", expected_close_date: "2026-12-31", closed_at: null,
    payment_type: null, customer_stage: null, indicator: null, accepted_for_forecast: false,
    assessment_status: null, subsidiary_implementation: true, management_control: true,
    is_industry_solution: false, industry_manager: null, industry_project_number: null,
    implementation_year: 2026, project_status: "Согласование договора",
    realized_work: "Подготовлено КП", period_plan: "Подписать договор",
    created_at: "2026-10-24T12:00:00Z", updated_at: "2026-10-24T12:00:00Z", archived_at: null,
    financial_entries: [
      { id: 101, kind: "revenue", year: 2026, month: 10, amount: "1234.567", vat_included: true,
        status: refs.revenue_statuses[0] },
      { id: 102, kind: "cost", year: 2027, month: 2, amount: "234.125", vat_included: false,
        status: refs.cost_statuses[0], article: refs.cost_articles[0], cost_type: refs.cost_types[0] },
    ],
  };
}

function historyItem(action: ArchiveAction): ProjectHistoryItem {
  return {
    id: action === "archive" ? 2 : 3, action,
    title: action === "archive" ? "Архивирование проекта" : "Восстановление проекта",
    author_name: author.full_name,
    created_at: action === "archive" ? archivedAt : "2026-10-26T11:20:30Z",
    changes: [{ field: "archived_at", label: "Архивирование",
      before: action === "archive" ? null : archivedAt,
      after: action === "archive" ? archivedAt : null }], note: null,
  };
}

async function mockApi(page: Page): Promise<ApiState> {
  const state: ApiState = {
    role: "admin", project: projectFixture(), historyRequests: 0, actions: [], listQueries: [],
    mutationError: null, unexpectedRequests: [],
    history: [{ id: 1, action: "create", title: "Создание проекта", author_name: author.full_name,
      created_at: "2026-10-24T12:00:00Z", changes: [], note: null }],
  };
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const get = request.method() === "GET";
    const queryIs = (expected: Record<string, string>) =>
      JSON.stringify([...url.searchParams.entries()].sort()) === JSON.stringify(Object.entries(expected).sort());

    if (get && path === "/api/auth/me" && queryIs({})) {
      return route.fulfill({ json: { ...author, email: "test@example.com", role: state.role } });
    }
    if (get && path === "/api/dashboards" && queryIs({})) return route.fulfill({ json: [] });
    if (get && path === "/api/refs" && queryIs({})) return route.fulfill({ json: refs });
    if (get && path === "/api/projects/check-name" && queryIs({
      name: state.project.name, client_id: "1", exclude_id: "42",
    })) return route.fulfill({ json: { available: true } });
    if (get && path === "/api/projects/42/history" && queryIs({ limit: "10" })) {
      state.historyRequests += 1;
      return route.fulfill({ json: {
        items: state.history.slice(0, 10), limit: 10, offset: 0, has_more: state.history.length > 10,
      } });
    }
    if (get && path === "/api/projects/42" && queryIs({})) return route.fulfill({ json: state.project });
    if (get && path === "/api/projects" && queryIs({
      sort: "-updated_at", page: "1", size: "20",
      ...(url.searchParams.has("q") ? { q: url.searchParams.get("q")! } : {}),
      ...(url.searchParams.has("archived") ? { archived: "true" } : {}),
    })) {
      state.listQueries.push(Object.fromEntries(url.searchParams));
      const archived = url.searchParams.get("archived") === "true";
      const search = (url.searchParams.get("q") ?? "").toLocaleLowerCase("ru");
      const activeProject = { ...projectFixture(), id: 43, name: "Активный проект" };
      const items = [activeProject, state.project].filter((project) =>
        Boolean(project.archived_at) === archived &&
        `${project.name} ${project.client.name}`.toLocaleLowerCase("ru").includes(search),
      );
      return route.fulfill({ json: { items, total: items.length, page: 1, size: 20 } });
    }
    if (request.method() === "POST" && queryIs({}) && request.postData() === null &&
      (path === "/api/projects/42/archive" || path === "/api/projects/42/restore")) {
      const action: ArchiveAction = path.endsWith("/archive") ? "archive" : "restore";
      state.actions.push(action);
      if (state.mutationError) {
        return route.fulfill({ status: state.mutationError.status, json: { detail: state.mutationError.detail } });
      }
      state.project = { ...state.project, archived_at: action === "archive" ? archivedAt : null,
        updated_at: action === "archive" ? archivedAt : "2026-10-26T11:20:30Z" };
      state.history.unshift(historyItem(action));
      return route.fulfill({ json: state.project });
    }
    state.unexpectedRequests.push(`${request.method()} ${path}${url.search}`);
    return route.fulfill({ status: 501, json: { detail: "Неожиданный тестовый маршрут" } });
  });
  return state;
}

const test = base.extend<{ apiState: ApiState }>({
  apiState: async ({ page }, run) => {
    const state = await mockApi(page);
    await run(state);
    expect(state.unexpectedRequests, "Все запросы API должны соответствовать строгим мокам").toEqual([]);
  },
});

async function confirmArchive(page: Page, state: ApiState, accept = true) {
  const previousActions = [...state.actions];
  const dialogPromise = page.waitForEvent("dialog");
  const clickPromise = page.getByRole("button", { name: "В архив", exact: true }).click();
  const dialog = await dialogPromise;
  expect(dialog.type()).toBe("confirm");
  expect(dialog.message()).toBe(`Переместить проект «${state.project.name}» в архив? Финансы и история сохранятся.`);
  expect(state.actions, "POST отправляется только после подтверждения").toEqual(previousActions);
  if (accept) await dialog.accept();
  else await dialog.dismiss();
  await clickPromise;
}

async function expectProjectValues(page: Page) {
  const project = projectFixture();
  await expect(page.getByRole("heading", { name: project.name, exact: true })).toBeVisible();
  for (const [label, value] of [
    [/Название проекта/, project.name], [/^Клиент/, project.client.name],
    [/^Суть проекта$/, project.description], [/Сумма контракта/, String(Number(project.amount))],
    [/^Себестоимость, ₽$/, project.cost], [/^Дата начала/, project.start_date],
    [/^Плановое закрытие/, project.expected_close_date], [/^Год реализации$/, "2026"],
    [/^Статус проекта$/, project.project_status!], [/^Сделано за период$/, project.realized_work],
    [/^Планы на период$/, project.period_plan],
  ] as const) await expect(page.getByLabel(label)).toHaveValue(value);
  await expect(page.getByLabel(/^Услуга/)).toHaveValue("2");
  await expect(page.getByLabel(/^Стадия системы/)).toHaveValue("proposal");
  await expect(page.getByLabel("Реализация через ДЗО")).toBeChecked();
  await expect(page.getByLabel("Контроль руководства")).toBeChecked();
  await expect(page.getByLabel("Сумма, тыс. рублей")).toHaveCount(2);
  for (const [index, entry] of project.financial_entries.entries()) {
    await expect(page.getByLabel("Сумма, тыс. рублей").nth(index)).toHaveValue(entry.amount);
    await expect(page.getByLabel("Год", { exact: true }).nth(index)).toHaveValue(String(entry.year));
    await expect(page.getByLabel("Месяц", { exact: true }).nth(index)).toHaveValue(String(entry.month));
    await expect(page.getByLabel("НДС", { exact: true }).nth(index)).toHaveValue(entry.vat_included ? "yes" : "no");
  }
  await expect(page.getByLabel("Статус начисления выручки")).toHaveValue("20");
  await expect(page.getByLabel("Статус затрат", { exact: true })).toHaveValue("21");
  await expect(page.getByLabel("Статья затрат")).toHaveValue("30");
  await expect(page.getByLabel("Вид затрат")).toHaveValue("31");
}

async function expectReadOnly(page: Page, readOnly: boolean) {
  const fields = [page.getByLabel("Суть проекта"), page.getByLabel(/^Клиент/),
    page.getByLabel(/^Услуга/), page.getByLabel("Сумма, тыс. рублей").first(),
    page.getByLabel("Статья затрат"), page.getByRole("button", { name: "Добавить финансовую строку" }),
    ...await page.getByRole("button", { name: "Удалить", exact: true }).all()];
  for (const field of fields) {
    if (readOnly) await expect(field).toBeDisabled();
    else await expect(field).toBeEnabled();
  }
  const save = page.getByRole("button", { name: "Сохранить", exact: true });
  if (readOnly) await expect(save).toHaveCount(0);
  else await expect(save).toBeVisible();
}

test("администратор подтверждает архивирование, сохраняет поля и финансы, восстанавливает проект и обновляет историю", async ({ page, apiState }) => {
  await page.goto("/projects/42");
  const history = page.getByRole("region", { name: "История изменений" });
  const notice = page.getByRole("status").filter({ hasText: "Проект в архиве с" });
  await expect(history.getByRole("heading", { name: "Создание проекта" })).toBeVisible();
  await expectProjectValues(page);
  await expectReadOnly(page, false);
  const beforeArchive = apiState.historyRequests;

  await confirmArchive(page, apiState);
  await expect(notice).toContainText("Для редактирования восстановите проект.");
  await expect(notice).toContainText("26.10.2026");
  await expect(page.getByRole("button", { name: "В архив", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Восстановить проект" })).toBeEnabled();
  await expectProjectValues(page);
  await expectReadOnly(page, true);
  await expect(history.getByRole("heading", { name: "Архивирование проекта" })).toBeVisible();
  await expect(history.getByRole("listitem")).toHaveCount(2);
  expect(apiState.historyRequests).toBeGreaterThan(beforeArchive);
  expect(apiState.actions).toEqual(["archive"]);
  const beforeRestore = apiState.historyRequests;

  await page.getByRole("button", { name: "Восстановить проект" }).click();
  await expect(notice).toHaveCount(0);
  await expect(page.getByRole("button", { name: "В архив", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Восстановить проект" })).toHaveCount(0);
  await expectProjectValues(page);
  await expectReadOnly(page, false);
  await expect(history.getByRole("heading", { name: "Восстановление проекта" })).toBeVisible();
  await expect(history.getByRole("heading", { name: "Архивирование проекта" })).toBeVisible();
  await expect(history.getByRole("heading", { name: "Создание проекта" })).toBeVisible();
  await expect(history.getByRole("listitem")).toHaveCount(3);
  expect(apiState.historyRequests).toBeGreaterThan(beforeRestore);
  expect(apiState.actions).toEqual(["archive", "restore"]);
  await page.getByLabel("Суть проекта").fill("Можно редактировать после восстановления");
  await page.getByLabel("Сумма, тыс. рублей").first().fill("1234.568");
  await expect(page.getByRole("button", { name: "Сохранить", exact: true })).toBeEnabled();
});

test("отмена подтверждения не отправляет POST и оставляет карточку редактируемой", async ({ page, apiState }) => {
  await page.goto("/projects/42");
  const history = page.getByRole("region", { name: "История изменений" });
  await expect(history.getByRole("listitem")).toHaveCount(1);
  const beforeCancel = apiState.historyRequests;
  await confirmArchive(page, apiState, false);
  await expect(page.getByRole("button", { name: "В архив", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Восстановить проект" })).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "Проект в архиве с" })).toHaveCount(0);
  await expectProjectValues(page);
  await expectReadOnly(page, false);
  expect(apiState.actions).toEqual([]);
  expect(apiState.historyRequests).toBe(beforeCancel);
  expect(apiState.project.archived_at).toBeNull();
});

for (const role of ["user", "analyst"] as const) {
  test(`роль ${role} не видит действия архива и переключатель списка`, async ({ page, apiState }) => {
    apiState.role = role;
    await page.goto("/projects/42");
    await expect(page.getByLabel("Суть проекта")).toBeEditable();
    await expect(page.getByRole("button", { name: "В архив", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Восстановить проект" })).toHaveCount(0);
    await page.getByRole("link", { name: "Список проектов", exact: true }).click();
    await expect(page.getByRole("cell", { name: apiState.project.name, exact: true })).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "Архив проектов" })).toHaveCount(0);
    expect(apiState.listQueries.length).toBeGreaterThan(0);
    expect(apiState.listQueries.every((query) => !("archived" in query))).toBe(true);
    expect(apiState.actions).toEqual([]);
  });
}

test("переключатель администратора передаёт archived=true списку и ссылке Excel с текущим поиском", async ({ page, apiState }) => {
  apiState.project.archived_at = archivedAt;
  await page.goto("/projects");
  const toggle = page.getByRole("checkbox", { name: "Архив проектов" });
  const archivedCell = page.getByRole("cell", { name: apiState.project.name, exact: true });
  const activeCell = page.getByRole("cell", { name: "Активный проект", exact: true });
  const exportLink = page.getByRole("link", { name: "Выгрузить в Excel" });
  await expect(toggle).not.toBeChecked();
  await expect(activeCell).toBeVisible();
  await expect(archivedCell).toHaveCount(0);
  let exportUrl = new URL((await exportLink.getAttribute("href"))!, page.url());
  expect(exportUrl.pathname).toBe("/api/projects/export.xlsx");
  expect(Object.fromEntries(exportUrl.searchParams)).toEqual({ sort: "-updated_at" });

  await page.getByPlaceholder("Поиск: проект, клиент или ИНН").fill("Заказчик");
  await expect.poll(() => apiState.listQueries.at(-1)).toEqual({ q: "Заказчик", sort: "-updated_at", page: "1", size: "20" });
  await toggle.check();
  await expect.poll(() => apiState.listQueries.at(-1)).toEqual({ q: "Заказчик", sort: "-updated_at", archived: "true", page: "1", size: "20" });
  await expect(archivedCell).toBeVisible();
  await expect(activeCell).toHaveCount(0);
  await expect(exportLink).toHaveAttribute("href", /archived=true/);
  exportUrl = new URL((await exportLink.getAttribute("href"))!, page.url());
  expect(Object.fromEntries(exportUrl.searchParams)).toEqual({ q: "Заказчик", sort: "-updated_at", archived: "true" });

  await toggle.uncheck();
  await expect(activeCell).toBeVisible();
  await expect(archivedCell).toHaveCount(0);
  await expect(exportLink).not.toHaveAttribute("href", /archived=/);
  exportUrl = new URL((await exportLink.getAttribute("href"))!, page.url());
  expect(Object.fromEntries(exportUrl.searchParams)).toEqual({ q: "Заказчик", sort: "-updated_at" });
  expect(apiState.actions).toEqual([]);
});

for (const action of ["archive", "restore"] as const) {
  test(`ошибка POST ${action} видна и не меняет состояние; повторная попытка обновляет карточку и историю`, async ({ page, apiState }) => {
    const initiallyArchived = action === "restore";
    apiState.project.archived_at = initiallyArchived ? archivedAt : null;
    apiState.mutationError = { status: action === "archive" ? 503 : 409,
      detail: action === "archive" ? "Архив временно недоступен" : "Не удалось восстановить проект" };
    await page.goto("/projects/42");
    const history = page.getByRole("region", { name: "История изменений" });
    const notice = page.getByRole("status").filter({ hasText: "Проект в архиве с" });
    const actionButton = page.getByRole("button", { name: initiallyArchived ? "Восстановить проект" : "В архив", exact: true });
    await expect(history.getByRole("listitem")).toHaveCount(1);
    const beforeError = apiState.historyRequests;
    if (initiallyArchived) await actionButton.click();
    else await confirmArchive(page, apiState);

    await expect(page.getByRole("alert").filter({ hasText: apiState.mutationError.detail })).toBeVisible();
    await expect(actionButton).toBeEnabled();
    await expect(notice).toHaveCount(initiallyArchived ? 1 : 0);
    await expectReadOnly(page, initiallyArchived);
    await expectProjectValues(page);
    await expect(history.getByRole("listitem")).toHaveCount(1);
    expect(apiState.historyRequests).toBe(beforeError);
    expect(apiState.project.archived_at).toBe(initiallyArchived ? archivedAt : null);
    expect(apiState.actions).toEqual([action]);

    apiState.mutationError = null;
    if (initiallyArchived) await actionButton.click();
    else await confirmArchive(page, apiState);
    await expect(history.getByRole("heading", { name: historyItem(action).title })).toBeVisible();
    await expect(history.getByRole("listitem")).toHaveCount(2);
    await expect(page.locator('span.error[role="alert"]')).toHaveCount(0);
    await expect(notice).toHaveCount(initiallyArchived ? 0 : 1);
    await expectReadOnly(page, !initiallyArchived);
    await expectProjectValues(page);
    expect(apiState.historyRequests).toBeGreaterThan(beforeError);
    expect(apiState.actions).toEqual([action, action]);
  });
}
