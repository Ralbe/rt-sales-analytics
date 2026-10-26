import { expect, test, type Page } from "@playwright/test";

import type { Project, ProjectPage, Refs } from "../../src/lib/types";

const manager = { id: 1, full_name: "Тестовый менеджер" };
const refs: Refs = {
  segments: [{ id: 2, name: "Корпоративные клиенты" }],
  services: [{ id: 3, name: "Связь", group_name: null }], managers: [manager],
  stages: [{ id: "proposal", name: "КП отправлено", probability: 50 }],
  customer_stages: [{ id: 10, name: "Независимый этап ТЗ", probability: 80 }],
  payment_types: [], assessment_statuses: [], project_indicators: [], cost_articles: [], cost_types: [],
  revenue_statuses: [], cost_statuses: [], roles: [],
};

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 42, name: "Проект " + "П".repeat(293), description: "Описание",
    client: { id: 4, name: "Организация " + "К".repeat(238) }, client_inn: "001234567801",
    segment: refs.segments[0], service: refs.services[0], manager, stage: "proposal",
    customer_stage: refs.customer_stages[0], implementation_year: 2027, probability: 37,
    amount: "987654321098.76", cost: "123456789012.34", margin: "864197532086.42", margin_pct: 87.5,
    start_date: "2026-01-01", expected_close_date: "2027-12-31", closed_at: null,
    payment_type: null, indicator: null, accepted_for_forecast: false, assessment_status: null,
    subsidiary_implementation: false, management_control: false, is_industry_solution: false,
    industry_manager: null, industry_project_number: null,
    project_status: "Статус\n" + "С".repeat(93), realized_work: "Сделано\n" + "Д".repeat(1000),
    period_plan: "Планы\n" + "Я".repeat(1000),
    created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-26T00:00:00Z",
    financial_entries: [1, 2].map((month) => ({
      id: month, kind: "revenue", year: 2027, month, amount: "999.123", vat_included: true,
    })),
    ...overrides,
  };
}

async function mockApi(page: Page, items = [project()], total = items.length) {
  const requests: URLSearchParams[] = [];
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/auth/me") {
      return route.fulfill({ json: { ...manager, email: "register@example.test", role: "analyst" } });
    }
    if (url.pathname === "/api/refs") return route.fulfill({ json: refs });
    if (url.pathname === "/api/dashboards") return route.fulfill({ json: [] });
    if (url.pathname === "/api/projects") {
      requests.push(url.searchParams);
      const openOnly = url.searchParams.get("open_only") === "true";
      const filtered = openOnly
        ? items.filter((item) => item.stage_scheme !== "customer" && item.stage !== null && !["won", "lost"].includes(item.stage))
        : items;
      const result: ProjectPage = {
        items: filtered, total: filtered === items ? total : filtered.length, page: Number(url.searchParams.get("page")), size: 20,
        stage_scope: openOnly ? "legacy" : "all",
        scope_note: openOnly ? "Показатели рассчитаны только по проектам с прежними шестью стадиями. Проекты с новыми этапами не включены." : null,
      };
      return route.fulfill({ json: result });
    }
    return route.fulfill({ status: 404, json: { detail: "Тестовый маршрут не найден" } });
  });
  return requests;
}

function cell(page: Page, field: string, row = 0) {
  const header = page.locator(`th[data-field="${field}"]`);
  return header.evaluate((el) => (el as HTMLTableCellElement).cellIndex).then((index) =>
    page.locator("tbody tr").nth(row).getByRole("cell").nth(index));
}

test("реестр: исходные поля, независимые этапы и полные суммы с копейками", async ({ page }) => {
  const source = project();
  await mockApi(page, [source]);
  await page.goto("/projects");
  await expect(page.locator("tbody tr")).toHaveCount(1);
  for (const [field, expected] of Object.entries({
    name: source.name, client: source.client.name, client_inn: "001234567801", implementation_year: "2027",
    stage: "КП отправлено", customer_stage_id: "Независимый этап ТЗ", probability: "37%",
    amount: "987 654 321 098,76 ₽", cost: "123 456 789 012,34 ₽", margin: "87.5%", close: "31.12.2027",
    project_status: source.project_status!, realized_work: source.realized_work, period_plan: source.period_plan,
  })) {
    await expect(await cell(page, field)).toHaveText(expected);
  }
  await expect(page.getByRole("columnheader", { name: "Маржа, %", exact: true })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: /взвешенн/i })).toHaveCount(0);
  await expect(page.locator("tbody")).not.toContainText(/тыс\.|млн|млрд|999[,.]123|1998[,.]246/);
  await (await cell(page, "name")).click();
  await expect(page).toHaveURL(/\/projects\/42$/);
});

test("реестр: старый DTO без ИНН, пустые поля и нулевые суммы", async ({ page }) => {
  const legacy = project({
    customer_stage: null, implementation_year: null, project_status: null, realized_work: "", period_plan: "",
    probability: 0, amount: "0.00", cost: "0.00", margin_pct: null,
  });
  delete legacy.client_inn;
  await mockApi(page, [legacy, project({ id: 43, client_inn: "0012345678", amount: "1000.01", cost: "0.10" })]);
  await page.goto("/projects");
  await expect(page.locator("tbody tr")).toHaveCount(2);
  for (const field of ["client_inn", "customer_stage_id", "implementation_year", "project_status", "realized_work", "period_plan", "margin"]) {
    await expect(await cell(page, field)).toHaveText("—");
  }
  await expect(await cell(page, "probability")).toHaveText("0%");
  await expect(await cell(page, "amount")).toHaveText("0,00 ₽");
  await expect(await cell(page, "cost")).toHaveText("0,00 ₽");
  await expect(await cell(page, "client_inn", 1)).toHaveText("0012345678");
  await expect(await cell(page, "amount", 1)).toHaveText("1 000,01 ₽");
  await expect(await cell(page, "cost", 1)).toHaveText("0,10 ₽");
});

for (const width of [1440, 768]) {
  test(`реестр: длинные строки переносятся целиком при ширине ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await mockApi(page);
    await page.goto("/projects");
    await expect(page.locator("tbody tr")).toHaveCount(1);
    for (const field of ["name", "client", "project_status", "realized_work", "period_plan"]) {
      const target = await cell(page, field);
      const dimensions = await target.evaluate((el) => ({
        width: el.clientWidth, scrollWidth: el.scrollWidth, height: el.clientHeight, scrollHeight: el.scrollHeight,
        whiteSpace: getComputedStyle(el).whiteSpace, overflowWrap: getComputedStyle(el).overflowWrap,
      }));
      expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.width + 1);
      expect(dimensions.scrollHeight).toBeLessThanOrEqual(dimensions.height + 1);
      expect(dimensions.whiteSpace).toBe("pre-wrap");
      expect(dimensions.overflowWrap).toBe("anywhere");
      expect(dimensions.height).toBeGreaterThan(40);
    }
    const container = page.locator("table").locator("..");
    expect(await container.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    await (await cell(page, "period_plan")).scrollIntoViewIfNeeded();
    await expect(await cell(page, "period_plan")).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}

test("реестр: точные фильтры и сортировка передаются API и экспорту со сбросом страницы", async ({ page }) => {
  const requests = await mockApi(page, [project()], 41);
  await page.goto("/projects");
  const lastQuery = () => requests[requests.length - 1];
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await page.getByRole("button", { name: "→", exact: true }).click();
  await expect.poll(() => lastQuery()?.get("page")).toBe("2");
  await page.getByLabel("Этап по ТЗ", { exact: true }).selectOption("10");
  await expect.poll(() => lastQuery()?.get("customer_stage_id")).toBe("10");
  expect(lastQuery().get("page")).toBe("1");
  await page.getByRole("button", { name: "→", exact: true }).click();
  await expect.poll(() => lastQuery()?.get("page")).toBe("2");
  await page.getByLabel("Год реализации", { exact: true }).selectOption("2027");
  await expect.poll(() => lastQuery()?.get("implementation_year")).toBe("2027");
  expect(lastQuery().get("customer_stage_id")).toBe("10");
  expect(lastQuery().get("page")).toBe("1");
  await page.getByRole("button", { name: "Стадии: все ▾", exact: true }).click();
  await page.getByLabel("КП отправлено", { exact: true }).check();
  await expect.poll(() => lastQuery()?.getAll("stage")).toEqual(["proposal"]);
  await page.getByRole("heading", { name: "Проекты", exact: true }).click();
  for (const field of ["client_inn", "implementation_year", "customer_stage_id"]) {
    await page.getByRole("button", { name: "→", exact: true }).click();
    await expect.poll(() => lastQuery()?.get("page")).toBe("2");
    await page.locator(`th[data-field="${field}"]`).click();
    await expect.poll(() => lastQuery()?.get("sort")).toBe(`-${field}`);
    expect(lastQuery().get("page")).toBe("1");
    await page.locator(`th[data-field="${field}"]`).click();
    await expect.poll(() => lastQuery()?.get("sort")).toBe(field);
  }
  const exportUrl = new URL((await page.getByRole("link", { name: "Выгрузить в Excel" }).getAttribute("href"))!, "http://localhost");
  for (const field of ["customer_stage_id", "implementation_year", "stage", "sort"]) {
    expect(exportUrl.searchParams.get(field)).toBe(lastQuery().get(field));
  }
  await page.getByLabel("Год реализации", { exact: true }).selectOption("");
  await expect.poll(() => lastQuery()?.has("implementation_year")).toBe(false);
  await page.getByLabel("Этап по ТЗ", { exact: true }).selectOption("");
  await expect.poll(() => lastQuery()?.has("customer_stage_id")).toBe(false);
});

test("реестр: пустой ответ сохраняет полный заголовок и корректный colspan", async ({ page }) => {
  await mockApi(page, []);
  await page.goto("/projects");
  const empty = page.getByRole("cell", { name: "Ничего не найдено", exact: true });
  await expect(empty).toBeVisible();
  await expect(empty).toHaveAttribute("colspan", String(await page.getByRole("columnheader").count()));
});

test("реестр показывает оба поколения; nullable legacy-поле имеет подпись «Не применяется», open_only ограничен legacy", async ({ page }) => {
  const mixed = [
    project({ id: 41, name: "Прежний открытый проект", stage_scheme: "legacy" }),
    project({ id: 42, name: "Новый проект", stage_scheme: "customer", stage: null, probability: 80 }),
    project({ id: 43, name: "Прежний выигранный проект", stage_scheme: "legacy", stage: "won" }),
  ];
  const requests = await mockApi(page, mixed);
  await page.goto("/projects");
  await expect(page.locator("tbody tr")).toHaveCount(3);
  await expect(await cell(page, "stage", 1)).toHaveText("Не применяется");
  await expect(await cell(page, "customer_stage_id", 1)).toHaveText(refs.customer_stages[0].name);
  await expect(await cell(page, "probability", 0)).toHaveText("37%");
  expect(requests.at(-1)?.has("open_only")).toBe(false);
  const openOnly = page.getByLabel("Только открытые проекты прежних стадий", { exact: true });
  await expect(openOnly).toHaveAccessibleDescription("Фильтр открытых проектов применяется только к прежним шести стадиям. Проекты с новыми этапами не включаются.");
  await openOnly.check();
  await expect.poll(() => requests.at(-1)?.get("open_only")).toBe("true");
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await expect(page.locator("tbody")).toContainText("Прежний открытый проект");
  const exportUrl = new URL((await page.getByRole("link", { name: "Выгрузить в Excel" }).getAttribute("href"))!, "http://localhost");
  expect(exportUrl.searchParams.get("open_only")).toBe("true");
  await openOnly.uncheck();
  await expect(openOnly).not.toBeChecked();
  await expect(page.locator("tbody tr")).toHaveCount(3);
  const allExportUrl = new URL((await page.getByRole("link", { name: "Выгрузить в Excel" }).getAttribute("href"))!, "http://localhost");
  expect(allExportUrl.searchParams.has("open_only")).toBe(false);
});

test("F4: корневой маршрут открывает полный реестр всех поколений, без ограничения top-8", async ({ page }) => {
  const items = Array.from({ length: 12 }, (_, index) => project({
    id: index + 1, name: "Стартовый проект " + (index + 1),
    ...(index % 2 ? { stage_scheme: "customer", stage: null } : { stage_scheme: "legacy" }),
  }));
  const requests = await mockApi(page, items);
  await page.goto("/");
  await expect(page).toHaveURL(/\/projects$/);
  await expect(page.getByRole("heading", { name: "Проекты", exact: true })).toBeVisible();
  await expect(page.locator("tbody tr")).toHaveCount(12);
  expect(requests.at(-1)?.get("size")).toBe("20");
  expect(requests.at(-1)?.has("open_only")).toBe(false);
  expect(requests.at(-1)?.has("stage")).toBe(false);
});

test("реестр отмечает проекты, созданные в выбранном периоде UTC", async ({ page }) => {
  const items = [
    project({ id: 1, name: "Начало периода", created_at: "2026-10-01T00:00:00Z" }),
    project({ id: 2, name: "Конец периода", created_at: "2026-11-01T02:59:59+03:00" }),
    project({ id: 3, name: "Старый изменённый проект", created_at: "2026-09-30T23:59:59Z", updated_at: "2026-10-15T12:00:00Z" }),
    project({ id: 4, name: "После периода", created_at: "2026-11-01T00:00:00Z" }),
  ];
  await mockApi(page, items);
  await page.goto("/projects");
  const row = (name: string) => page.getByRole("row").filter({ hasText: name });
  const start = page.getByLabel("Начало периода создания (UTC)");
  const end = page.getByLabel("Конец периода создания (UTC)");
  await expect(page.getByText(/Создан за период:/)).toHaveCount(0);
  await start.fill("2026-10-01");
  await end.fill("2026-10-31");
  await expect(row("Начало периода")).toContainText(/Создан за период:.*01\.10\.2026.*00:00.*UTC/);
  await expect(row("Конец периода")).toContainText(/Создан за период:.*31\.10\.2026.*23:59.*UTC/);
  await expect(row("Старый изменённый проект")).not.toContainText("Создан за период:");
  await expect(row("После периода")).not.toContainText("Создан за период:");
  await expect(page.getByText(/Создан за период:/)).toHaveCount(2);
  await page.reload();
  await start.fill("2026-10-01");
  await end.fill("2026-10-31");
  await expect(page.getByText(/Создан за период:/)).toHaveCount(2);
  await start.fill("2026-11-01");
  await expect(page.getByRole("alert")).toHaveText("Начало периода не может быть позже конца.");
  await expect(page.getByText(/Создан за период:/)).toHaveCount(0);
});
