import { expect, test } from "@playwright/test";

test("администратор управляет сегментом и создаёт услугу без группы", async ({ page }) => {
  const items: Record<string, { id: number; name: string; is_active: boolean; group_name: string | null }[]> = {
    segments: [], services: [],
  };
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/auth/me") return route.fulfill({ json: { id: 1, email: "t@example.test", full_name: "Тест", role: "admin" } });
    if (path === "/api/dashboards") return route.fulfill({ json: [] });
    const match = path.match(/^\/api\/structural-references\/(segments|services)(?:\/(\d+)\/(name|active))?$/);
    if (!match) return route.fulfill({ status: 404 });
    const list = items[match[1]];
    if (request.method() === "GET") return route.fulfill({ json: list });
    if (request.method() === "POST") {
      const input = request.postDataJSON();
      const item = { id: list.length + 1, name: input.name, is_active: true, group_name: input.group_name ?? null };
      list.push(item);
      return route.fulfill({ status: 201, json: item });
    }
    const item = list.find((row) => row.id === Number(match[2]))!;
    if (match[3] === "name") item.name = request.postDataJSON().name;
    else item.is_active = request.postDataJSON().is_active;
    return route.fulfill({ json: item });
  });
  await page.goto("/settings/structural-references");
  await page.getByLabel("Новое значение").fill("Сегмент теста");
  await page.getByRole("button", { name: "Добавить" }).click();
  const row = page.getByRole("row").filter({ has: page.getByLabel("Название: Сегмент теста") });
  await row.getByRole("button", { name: "Деактивировать" }).click();
  await expect(row).toContainText("Неактивно");
  await row.getByRole("button", { name: "Восстановить" }).click();
  await expect(row).toContainText("Активно");
  await page.getByLabel("Справочник", { exact: true }).selectOption("services");
  await page.getByLabel("Новое значение").fill("Услуга без группы");
  await page.getByRole("button", { name: "Добавить" }).click();
  const service = page.getByRole("row").filter({ has: page.getByLabel("Название: Услуга без группы") });
  await expect(service).toContainText("—");
  await service.getByRole("button", { name: "Деактивировать" }).click();
  await expect(service).toContainText("Неактивно");
  await service.getByRole("button", { name: "Восстановить" }).click();
  await expect(service).toContainText("Активно");
});

test("обычный пользователь не получает доступ к административному разделу", async ({ page }) => {
  let writes = 0;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/me") return route.fulfill({ json: { id: 1, email: "t@example.test", full_name: "Тест", role: "user" } });
    if (path === "/api/dashboards") return route.fulfill({ json: [] });
    writes++;
    return route.fulfill({ status: 403 });
  });
  await page.goto("/settings/structural-references");
  await expect(page.getByRole("alert").filter({ hasText: "только администратору" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Добавить" })).toHaveCount(0);
  expect(writes).toBe(0);
});

test("сохранённые фильтры и печать показывают неактивные сегмент и услугу", async ({ page }) => {
  const user = { id: 1, email: "t@example.test", full_name: "Тест", role: "analyst" };
  const dashboard = { id: 41, name: "Дашборд", owner: { id: 1, full_name: user.full_name }, widgets: [],
    filters: { segment_ids: [2], service_ids: [3], manager_ids: [] }, is_shared: false, editable: true,
    updated_at: "2026-10-24T12:00:00Z" };
  const refs = { segments: [], services: [], managers: [], stages: [], payment_types: [], assessment_statuses: [],
    project_indicators: [], customer_stages: [], cost_articles: [], cost_types: [], revenue_statuses: [], cost_statuses: [], roles: [],
    filter_segments: [{ id: 2, name: "Старый сегмент", is_active: false }],
    filter_services: [{ id: 3, name: "Старая услуга", group_name: null, is_active: false }] };
  await page.addInitScript(() => { window.print = () => {}; });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/me") return route.fulfill({ json: user });
    if (path === "/api/refs") return route.fulfill({ json: refs });
    if (path === "/api/dashboards") return route.fulfill({ json: [dashboard] });
    if (path === "/api/dashboards/41") return route.fulfill({ json: dashboard });
    return route.fulfill({ status: 404 });
  });
  await page.goto("/dashboards/41");
  await expect(page.getByRole("button", { name: /Старый сегмент \(неактивно\)/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Старая услуга \(неактивно\)/ })).toBeVisible();
  await page.getByRole("button", { name: "PDF / Печать", exact: true }).click();
  const report = page.locator("[data-dashboard-print]");
  await expect(report).toHaveAttribute("data-ready", "true");
  await expect(report).toContainText("Старый сегмент (неактивно)");
  await expect(report).toContainText("Старая услуга (неактивно)");
});

test("старая карточка показывает и сохраняет неактивную услугу, печать сохраняет названия", async ({ page }) => {
  const segment = { id: 2, name: "Старый сегмент" };
  const service = { id: 3, name: "Старая услуга", group_name: "Связь" };
  const refs = { segments: [], services: [{ id: 4, name: "Новая услуга", group_name: null }],
    filter_segments: [{ ...segment, is_active: false }], filter_services: [{ ...service, is_active: false }],
    managers: [{ id: 1, full_name: "Менеджер" }], stages: [{ id: "lead", name: "Лид", probability: 10 }],
    payment_types: [], assessment_statuses: [], project_indicators: [], customer_stages: [],
    cost_articles: [], cost_types: [], revenue_statuses: [], cost_statuses: [], roles: [] };
  const project = { id: 51, name: "Старый проект", description: "", client: { id: 10, name: "Клиент" },
    segment, service, manager: refs.managers[0], stage: "lead", amount: "10000.00", cost: "2000.00",
    margin: "8000.00", margin_pct: 80, probability: 10, start_date: "2026-10-01", expected_close_date: "2026-12-01",
    closed_at: null, payment_type: null, customer_stage: null, indicator: null, accepted_for_forecast: false,
    assessment_status: null, subsidiary_implementation: false, management_control: false, is_industry_solution: false,
    industry_manager: null, industry_project_number: null, implementation_year: null, project_status: null,
    realized_work: "", period_plan: "", created_at: "2026-10-01T10:00:00Z", updated_at: "2026-10-24T10:00:00Z",
    financial_entries: [] };
  let written: { service_id: number } | undefined;
  await page.addInitScript(() => { window.print = () => {}; });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/auth/me") return route.fulfill({ json: { id: 1, email: "t@example.test", full_name: "Менеджер", role: "analyst" } });
    if (path === "/api/dashboards") return route.fulfill({ json: [] });
    if (path === "/api/refs") return route.fulfill({ json: refs });
    if (path === "/api/clients") return route.fulfill({ json: [{ ...project.client, inn: "7707083893", segment }] });
    if (path === "/api/projects/check-name") return route.fulfill({ json: { available: true } });
    if (path === "/api/projects/51/history") return route.fulfill({ json: { items: [], limit: 10, offset: 0, has_more: false } });
    if (path === "/api/projects/51" && request.method() === "GET") return route.fulfill({ json: project });
    if (path === "/api/projects/51" && request.method() === "PUT") { written = request.postDataJSON(); return route.fulfill({ json: project }); }
    return route.fulfill({ status: 404 });
  });
  await page.goto("/projects/51");
  const option = page.locator("#service_id option[value='3']");
  await expect(option).toBeDisabled();
  await expect(page.locator("#service_id")).toHaveValue("3");
  await page.getByLabel("Суть проекта").fill("Изменено");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect.poll(() => written?.service_id).toBe(3);
  await page.getByRole("button", { name: "PDF / Печать карточки" }).click();
  const print = page.locator("[data-project-print]");
  await expect(print).toHaveAttribute("data-ready", "true");
  await expect(print).toContainText("Старый сегмент");
  await expect(print).toContainText("Старая услуга");
});
