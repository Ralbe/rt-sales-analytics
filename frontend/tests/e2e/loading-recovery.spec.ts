import { expect, test, type Page, type Route } from "@playwright/test";

import type { Dashboard, FinancialEntry, Project, Refs, Role, User } from "../../src/lib/types";

const USER: User = { id: 1, email: "loading@example.test", full_name: "Тестовый аналитик", role: "analyst" };
const REFS: Refs = {
  segments: [{ id: 2, name: "Корпоративные клиенты" }],
  services: [{ id: 3, name: "Интернет", group_name: null }],
  managers: [{ id: USER.id, full_name: USER.full_name }],
  stages: [{ id: "lead", name: "Лид", probability: 10 }],
  payment_types: [], assessment_statuses: [], project_indicators: [], customer_stages: [],
  cost_articles: [], cost_types: [], revenue_statuses: [{ id: 4, name: "План" }], cost_statuses: [], roles: [],
};
const DASHBOARD: Dashboard = {
  id: 7, name: "Дашборд продаж", owner: { id: USER.id, full_name: USER.full_name },
  widgets: [], filters: { segment_ids: [], service_ids: [], manager_ids: [] },
  is_shared: false, editable: true, updated_at: "2026-10-24T10:00:00Z",
};
const PROJECT: Project = {
  id: 5, name: "Проект продаж", description: "Описание проекта",
  client: { id: 10, name: "Тестовый клиент" }, segment: REFS.segments[0],
  service: REFS.services[0], manager: REFS.managers[0], stage: "lead",
  amount: "1000.00", cost: "100.00", margin: "900.00", margin_pct: 90, probability: 10,
  start_date: "2026-10-01", expected_close_date: "2026-12-01", closed_at: null,
  payment_type: null, customer_stage: null, indicator: null, accepted_for_forecast: false,
  assessment_status: null, subsidiary_implementation: false, management_control: false,
  is_industry_solution: false, industry_manager: null, industry_project_number: null,
  implementation_year: null, project_status: null, realized_work: "", period_plan: "",
  created_at: "2026-10-01T10:00:00Z", updated_at: "2026-10-24T10:00:00Z", financial_entries: [],
};

type Handler = (route: Route) => Promise<void>;
const unavailable: Handler = (route) => route.fulfill({ status: 503, body: "" });

async function mockApi(page: Page, handlers: Record<string, Handler> = {}, role: Role = "analyst") {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, "");
    if (handlers[path]) return handlers[path](route);
    const responses: Record<string, unknown> = {
      "/auth/me": { ...USER, role },
      "/refs": REFS,
      "/dashboards": [DASHBOARD],
      "/dashboards/7": DASHBOARD,
      "/projects": { items: [PROJECT], total: 1, page: 1, size: 20 },
      "/projects/5": PROJECT,
      "/projects/check-name": { available: true },
      "/clients": [],
    };
    if (path in responses) return route.fulfill({ json: responses[path] });
    // Любой незаданный запрос остаётся в тесте и не доходит до реального API.
    return route.fulfill({ status: 500, json: { detail: `Не задан тестовый ответ для ${path}` } });
  });
}

function mainAlert(page: Page, title: string) {
  return page.getByRole("main").getByRole("alert").filter({ hasText: title });
}

async function reconnectWithStaleData(page: Page) {
  // Время делает кэш устаревшим; восстановление сети запускает штатный фоновый refetch.
  await page.clock.fastForward(6 * 60_000);
  await page.evaluate(() => {
    window.dispatchEvent(new Event("offline"));
    window.dispatchEvent(new Event("online"));
  });
}

test("дашборды: после 503 повтор открывает редактор", async ({ page }) => {
  let failing = true;
  let attempts = 0;
  await mockApi(page, {
    "/dashboards": async (route) => {
      attempts++;
      return failing ? unavailable(route) : route.fulfill({ json: [DASHBOARD] });
    },
  });
  await page.goto("/dashboards");
  const error = mainAlert(page, "Не удалось загрузить дашборды");
  await expect(error).toContainText("Ошибка сервера (503)");
  await expect(error.getByRole("button", { name: "Повторить", exact: true })).toBeEnabled();
  await expect(page.getByRole("main").getByText("Пока нет доступных дашбордов.")).toHaveCount(0);
  const beforeRetry = attempts;
  failing = false;
  await error.getByRole("button", { name: "Повторить", exact: true }).click();
  await page.waitForURL(/\/dashboards\/7$/);
  await expect(page.getByLabel("Название дашборда")).toHaveValue(DASHBOARD.name);
  expect(attempts).toBeGreaterThan(beforeRetry);
});

for (const role of ["user", "analyst"] as const) {
  test(`дашборды: пустой список завершает загрузку для роли ${role}`, async ({ page }) => {
    await mockApi(page, { "/dashboards": (route) => route.fulfill({ json: [] }) }, role);
    await page.goto("/dashboards");
    const main = page.getByRole("main");
    await expect(main.getByText("Пока нет доступных дашбордов.")).toBeVisible();
    await expect(main.getByRole("status")).toHaveCount(0);
    await expect(main.getByRole("alert")).toHaveCount(0);
    await expect(main.getByRole("link", { name: "Создать дашборд" })).toHaveCount(role === "analyst" ? 1 : 0);
    await main.getByRole("link", { name: "Перейти к проектам" }).click();
    await expect(page.getByRole("heading", { name: "Проекты", exact: true })).toBeVisible();
  });
}

test("Sidebar: повтор загрузки дашбордов сохраняет поиск проектов", async ({ page }) => {
  let failing = true;
  await mockApi(page, {
    "/dashboards": (route) => failing ? unavailable(route) : route.fulfill({ json: [DASHBOARD] }),
  });
  await page.goto("/projects");
  const search = page.getByPlaceholder("Поиск: проект, клиент или ИНН");
  await search.fill("Набранный поиск");
  const sidebar = page.getByRole("navigation");
  await expect(sidebar.getByRole("alert")).toContainText("Не удалось загрузить дашборды");
  await expect(sidebar.getByText("Нет доступных дашбордов", { exact: true })).toHaveCount(0);
  failing = false;
  await sidebar.getByRole("button", { name: "Повторить", exact: true }).click();
  await expect(sidebar.getByRole("link", { name: DASHBOARD.name, exact: true })).toBeVisible();
  await expect(search).toHaveValue("Набранный поиск");
});

for (const failure of ["сеть", "503"] as const) {
  test(`сессия: сбой ${failure} в auth/me показывает повтор без выхода`, async ({ page }) => {
    let failing = true;
    await mockApi(page, {
      "/auth/me": (route) => failing
        ? failure === "сеть" ? route.abort("failed") : unavailable(route)
        : route.fulfill({ json: USER }),
    });
    await page.goto("/projects/new");
    const error = page.getByRole("alert").filter({ hasText: "Не удалось проверить сессию" });
    await expect(error).toContainText("Не удалось проверить сессию");
    await expect(error).toContainText(failure === "сеть" ? "Проверьте подключение" : "503");
    await expect(page).toHaveURL(/\/projects\/new$/);
    await expect(page.getByRole("heading", { name: "Вход в систему" })).toHaveCount(0);
    failing = false;
    await error.getByRole("button", { name: "Повторить", exact: true }).click();
    await expect(page.getByLabel(/Название проекта/)).toBeVisible();
  });
}

for (const path of ["/auth/me", "/refs", "/dashboards"] as const) {
  test(`сессия: 401 от ${path} перенаправляет на вход`, async ({ page }) => {
    await mockApi(page, {
      [path]: (route) => route.fulfill({ status: 401, json: { detail: "Сессия истекла" } }),
    });
    await page.goto(path === "/dashboards" ? "/dashboards" : "/projects/new");
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole("heading", { name: "Вход в систему" })).toBeVisible();
  });
}

test("новый проект: справочники после 503 восстанавливаются без пустых селектов при ошибке", async ({ page }) => {
  let failing = true;
  await mockApi(page, {
    "/refs": (route) => failing ? unavailable(route) : route.fulfill({ json: REFS }),
  });
  await page.goto("/projects/new");
  const error = mainAlert(page, "Не удалось загрузить справочники");
  await expect(error).toContainText("503");
  await expect(page.getByLabel(/Услуга/)).toHaveCount(0);
  failing = false;
  await error.getByRole("button", { name: "Повторить", exact: true }).click();
  await expect(page.getByLabel(/Услуга/).getByRole("option", { name: "Интернет", exact: true })).toHaveCount(1);
  await page.getByLabel(/Название проекта/).fill("Новый проект после повтора");
  await expect(page.getByLabel(/Название проекта/)).toHaveValue("Новый проект после повтора");
});

test("новый проект: пустой справочник услуг отличается от ошибки и загрузки", async ({ page }) => {
  await mockApi(page, { "/refs": (route) => route.fulfill({ json: { ...REFS, services: [] } }) });
  await page.goto("/projects/new");
  await expect(page.getByText("В справочнике пока нет доступных услуг.")).toBeVisible();
  await expect(page.getByLabel(/Услуга/).getByRole("option")).toHaveCount(1);
  await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("main").getByRole("status")).toHaveCount(0);
});

test("список проектов: ошибки запросов и справочников имеют независимый повтор", async ({ page }) => {
  let projectsFailing = true;
  let refsFailing = true;
  await mockApi(page, {
    "/projects": (route) => projectsFailing ? unavailable(route) : route.fulfill({ json: { items: [], total: 0, page: 1, size: 20 } }),
    "/refs": (route) => refsFailing ? unavailable(route) : route.fulfill({ json: REFS }),
  });
  await page.goto("/projects");
  const projectError = mainAlert(page, "Не удалось загрузить проекты");
  const refsError = mainAlert(page, "Не удалось загрузить справочники фильтров");
  await expect(projectError).toContainText("503");
  await expect(refsError).toContainText("503");
  await expect(page.getByText("Ничего не найдено")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Сегменты/ })).toHaveCount(0);
  const search = page.getByPlaceholder("Поиск: проект, клиент или ИНН");
  await search.fill("Сохранить поиск");
  refsFailing = false;
  await refsError.getByRole("button", { name: "Повторить", exact: true }).click();
  await expect(page.getByRole("button", { name: /Сегменты/ })).toBeVisible();
  await expect(projectError).toBeVisible();
  // Ждём завершения запроса с новым поиском, прежде чем повторять его вручную.
  await expect(projectError.getByRole("button", { name: "Повторить", exact: true })).toBeEnabled();
  projectsFailing = false;
  await projectError.getByRole("button", { name: "Повторить", exact: true }).click();
  await expect(page.getByText("Ничего не найдено")).toBeVisible();
  await expect(page.getByText("Всего: 0")).toBeVisible();
  await expect(search).toHaveValue("Сохранить поиск");
});

test("справочники: ошибка фонового обновления сохраняет поля и последние значения", async ({ page }) => {
  let failing = false;
  await page.clock.install();
  await mockApi(page, { "/refs": (route) => failing ? unavailable(route) : route.fulfill({ json: REFS }) });
  await page.goto("/projects/new");
  const name = page.getByLabel(/Название проекта/);
  const service = page.getByLabel(/Услуга/);
  await name.fill("Несохранённый проект");
  await service.selectOption("3");
  await page.getByLabel(/Сумма контракта/).fill("12345");
  failing = true;
  await reconnectWithStaleData(page);
  const error = mainAlert(page, "Не удалось загрузить справочники");
  await expect(error).toContainText("Показаны ранее загруженные данные.");
  await expect(name).toHaveValue("Несохранённый проект");
  await expect(service).toHaveValue("3");
  await expect(service.getByRole("option", { name: "Интернет", exact: true })).toHaveCount(1);
  failing = false;
  await error.getByRole("button", { name: "Повторить", exact: true }).click();
  await expect(error).toHaveCount(0);
  await expect(name).toHaveValue("Несохранённый проект");
  await expect(service).toHaveValue("3");
  await expect(page.getByLabel(/Сумма контракта/)).toHaveValue("12345");
});

test("редактор дашборда: 503 при открытии допускает повтор", async ({ page }) => {
  let failing = true;
  await mockApi(page, { "/dashboards/7": (route) => failing ? unavailable(route) : route.fulfill({ json: DASHBOARD }) });
  await page.goto("/dashboards/7");
  const error = mainAlert(page, "Не удалось загрузить дашборд");
  await expect(error).toContainText("503");
  await expect(page.getByText("Дашборд не найден", { exact: true })).toHaveCount(0);
  failing = false;
  await error.getByRole("button", { name: "Повторить", exact: true }).click();
  await expect(page.getByLabel("Название дашборда")).toHaveValue(DASHBOARD.name);
});

test("редактор и WidgetDialog сохраняют правки при сбое refetch и позволяют сохранить после повтора", async ({ page }) => {
  let failing = false;
  let savedName: string | undefined;
  let dashboardVersion = DASHBOARD.updated_at;
  await page.clock.install();
  await mockApi(page, {
    "/dashboards/7": async (route) => {
      if (route.request().method() === "PUT") {
        const body = route.request().postDataJSON();
        savedName = body.name;
        return route.fulfill({ json: { ...DASHBOARD, ...body, updated_at: "2026-10-25T10:00:00Z" } });
      }
      return failing ? unavailable(route) : route.fulfill({ json: { ...DASHBOARD, updated_at: dashboardVersion } });
    },
    "/refs": (route) => failing ? unavailable(route) : route.fulfill({ json: REFS }),
    "/auth/me": (route) => failing ? unavailable(route) : route.fulfill({ json: USER }),
  });
  await page.goto("/dashboards/7");
  const name = page.getByLabel("Название дашборда");
  await name.fill("Несохранённый дашборд");
  await page.getByRole("button", { name: "+ Виджет", exact: true }).click();
  const dialog = page.locator("form.modal");
  await dialog.getByRole("textbox").fill("Черновик виджета");
  failing = true;
  await reconnectWithStaleData(page);
  const error = mainAlert(page, "Не удалось обновить дашборд");
  await expect(error).toContainText("503");
  await expect(mainAlert(page, "Не удалось обновить данные сессии")).toContainText("503");
  await expect(name).toHaveValue("Несохранённый дашборд");
  await expect(dialog.getByRole("textbox")).toHaveValue("Черновик виджета");
  await expect(page).toHaveURL(/\/dashboards\/7$/);
  await dialog.getByRole("button", { name: "Отмена", exact: true }).click();
  failing = false;
  dashboardVersion = "2026-10-25T09:00:00Z";
  for (const title of ["Не удалось обновить данные сессии", "Не удалось обновить дашборд", "Не удалось загрузить справочники фильтров"]) {
    const alert = mainAlert(page, title);
    await alert.getByRole("button", { name: "Повторить", exact: true }).click();
    await expect(alert).toHaveCount(0);
  }
  await expect(name).toHaveValue("Несохранённый дашборд");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect.poll(() => savedName).toBe("Несохранённый дашборд");
  await expect(page.getByRole("button", { name: "Сохранить", exact: true })).toBeDisabled();
});

test("карточка проекта: refetch с ошибкой сохраняет редактирование и повтор позволяет сохранить", async ({ page }) => {
  let failing = false;
  let savedName: string | undefined;
  let sentEntries: FinancialEntry[] = [];
  let currentProject: Project = {
    ...PROJECT,
    financial_entries: [{ id: 20, kind: "revenue", year: 2026, month: 10, amount: "2500.50", vat_included: true, status: REFS.revenue_statuses[0] }],
  };
  await page.clock.install();
  await mockApi(page, {
    "/projects/5": async (route) => {
      if (route.request().method() === "PUT") {
        const body = route.request().postDataJSON();
        savedName = body.name;
        currentProject = { ...currentProject, ...body, updated_at: "2026-10-25T10:00:00Z" };
        return route.fulfill({ json: currentProject });
      }
      return failing ? unavailable(route) : route.fulfill({ json: currentProject });
    },
    "/projects/5/financial-entries": (route) => {
      sentEntries = route.request().postDataJSON();
      currentProject = {
        ...currentProject,
        financial_entries: sentEntries.map((entry, index) => ({ ...entry, id: 30 + index, status: REFS.revenue_statuses[0] })),
      };
      return route.fulfill({ json: currentProject.financial_entries });
    },
  });
  await page.goto("/projects/5");
  const name = page.getByLabel(/Название проекта/);
  await name.fill("Правки существующего проекта");
  await page.getByLabel("Сумма, тыс. рублей").fill("3456.789");
  await page.getByLabel("НДС", { exact: true }).selectOption("no");
  failing = true;
  await reconnectWithStaleData(page);
  const error = mainAlert(page, "Не удалось загрузить проект");
  await expect(error).toContainText("503");
  await expect(name).toHaveValue("Правки существующего проекта");
  await expect(page.getByLabel("Сумма, тыс. рублей")).toHaveValue("3456.789");
  await expect(page.getByLabel("НДС", { exact: true })).toHaveValue("no");
  failing = false;
  currentProject = { ...currentProject, updated_at: "2026-10-25T09:00:00Z" };
  await error.getByRole("button", { name: "Повторить", exact: true }).click();
  await expect(error).toHaveCount(0);
  await expect(name).toHaveValue("Правки существующего проекта");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect.poll(() => savedName).toBe("Правки существующего проекта");
  await expect(name).toHaveValue("Правки существующего проекта");
  await expect(page.getByRole("button", { name: "Сохранить", exact: true })).toBeDisabled();
  expect(sentEntries).toEqual([expect.objectContaining({ amount: "3456.789", vat_included: false, status_id: 4 })]);
  await expect(page.getByLabel("Сумма, тыс. рублей")).toHaveValue("3456.789");
  await expect(page.getByLabel("НДС", { exact: true })).toHaveValue("no");
});

test("поиск клиентов: сетевая ошибка имеет повтор и не выдаёт пустой результат", async ({ page }) => {
  let failing = true;
  await mockApi(page, {
    "/clients": (route) => failing ? route.abort("failed") : route.fulfill({ json: [{
      id: 10, name: "Тестовый клиент", inn: "7707083893", segment: REFS.segments[0],
    }] }),
  });
  await page.goto("/projects/new");
  await page.getByLabel(/Название проекта/).fill("Проект с клиентом");
  const client = page.getByLabel("Клиент", { exact: false });
  await client.fill("Тестовый");
  const error = mainAlert(page, "Не удалось загрузить клиентов");
  await expect(error).toContainText("Проверьте подключение");
  await expect(page.getByText("Клиенты не найдены", { exact: true })).toHaveCount(0);
  failing = false;
  await error.getByRole("button", { name: "Повторить", exact: true }).click();
  await page.getByRole("button", { name: /Тестовый клиент ИНН/ }).click();
  await expect(client).toHaveValue("Тестовый клиент");
  await expect(page.getByLabel(/Название проекта/)).toHaveValue("Проект с клиентом");
});

test("диалог клиента: сбой справочников сохраняет введённые поля", async ({ page }) => {
  let failing = false;
  await page.clock.install();
  await mockApi(page, { "/refs": (route) => failing ? unavailable(route) : route.fulfill({ json: REFS }) });
  await page.goto("/projects/new");
  await page.getByLabel("Клиент", { exact: false }).fill("Новый клиент");
  await page.getByRole("button", { name: "+ Новый клиент «Новый клиент»", exact: true }).click();
  const dialog = page.locator("form.modal");
  await dialog.getByLabel(/Название/).fill("Название нового клиента");
  await dialog.getByLabel(/ИНН/).fill("7707083893");
  await dialog.getByLabel(/Сегмент/).selectOption("2");
  failing = true;
  await reconnectWithStaleData(page);
  const error = dialog.getByRole("alert");
  await expect(error).toContainText("Не удалось загрузить справочники");
  await expect(dialog.getByLabel(/Название/)).toHaveValue("Название нового клиента");
  await expect(dialog.getByLabel(/ИНН/)).toHaveValue("7707083893");
  await expect(dialog.getByLabel(/Сегмент/)).toHaveValue("2");
  failing = false;
  await error.getByRole("button", { name: "Повторить", exact: true }).click();
  await expect(error).toHaveCount(0);
  await expect(dialog.getByLabel(/Название/)).toHaveValue("Название нового клиента");
  await expect(dialog.getByLabel(/ИНН/)).toHaveValue("7707083893");
  await expect(dialog.getByLabel(/Сегмент/)).toHaveValue("2");
});

test("чистые редакторы принимают успешное фоновое обновление", async ({ page }) => {
  let updated = false;
  await page.clock.install();
  await mockApi(page, {
    "/dashboards/7": (route) => route.fulfill({ json: updated ? { ...DASHBOARD, name: "Обновлённый дашборд", updated_at: "2026-10-25T10:00:00Z" } : DASHBOARD }),
    "/projects/5": (route) => route.fulfill({ json: updated ? { ...PROJECT, name: "Обновлённый проект", updated_at: "2026-10-25T10:00:00Z" } : PROJECT }),
  });
  await page.goto("/dashboards/7");
  await expect(page.getByLabel("Название дашборда")).toHaveValue(DASHBOARD.name);
  updated = true;
  await reconnectWithStaleData(page);
  await expect(page.getByLabel("Название дашборда")).toHaveValue("Обновлённый дашборд");
  updated = false;
  await page.goto("/projects/5");
  await expect(page.getByLabel(/Название проекта/)).toHaveValue(PROJECT.name);
  updated = true;
  await reconnectWithStaleData(page);
  await expect(page.getByLabel(/Название проекта/)).toHaveValue("Обновлённый проект");
});

test("справочники: повтор без сети показывает причину ожидания и восстанавливается при подключении", async ({ page }) => {
  let failing = true;
  await mockApi(page, { "/refs": (route) => failing ? unavailable(route) : route.fulfill({ json: REFS }) });
  await page.goto("/projects/new");
  const error = mainAlert(page, "Не удалось загрузить справочники");
  await expect(error).toContainText("503");
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  failing = false;
  await error.getByRole("button", { name: "Повторить", exact: true }).click();
  await expect(error).toContainText("Нет подключения к сети");
  await expect(page).toHaveURL(/\/projects\/new$/);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.getByLabel(/Название проекта/)).toBeVisible();
  await expect(error).toHaveCount(0);
});
