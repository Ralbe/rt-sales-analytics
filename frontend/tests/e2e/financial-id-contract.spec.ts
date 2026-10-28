import { expect, test } from "@playwright/test";

test("форма передаёт ID сохранённой и явный null новой финансовой строки", async ({ page }) => {
  const refs = {
    segments: [{ id: 2, name: "Сегмент" }], services: [{ id: 3, name: "Услуга", group_name: null }],
    managers: [{ id: 1, full_name: "Менеджер" }], stages: [{ id: "lead", name: "Лид", probability: 10 }],
    payment_types: [], assessment_statuses: [], project_indicators: [], customer_stages: [],
    revenue_statuses: [{ id: 4, name: "План" }], cost_statuses: [{ id: 5, name: "Затраты" }],
    cost_articles: [{ id: 6, name: "Статья" }], cost_types: [{ id: 7, name: "Вид" }], roles: [],
  };
  const project = {
    id: 51, name: "Тестовый проект", description: "", client: { id: 10, name: "Клиент" },
    segment: refs.segments[0], service: refs.services[0], manager: refs.managers[0], stage: "lead",
    amount: "10000.00", cost: "2000.00", margin: "8000.00", margin_pct: 80, probability: 10,
    start_date: "2026-10-01", expected_close_date: "2026-12-01", closed_at: null,
    payment_type: null, customer_stage: null, indicator: null, accepted_for_forecast: false, assessment_status: null,
    subsidiary_implementation: false, management_control: false, is_industry_solution: false,
    industry_manager: null, industry_project_number: null, implementation_year: null, project_status: null,
    realized_work: "", period_plan: "", created_at: "2026-10-01T10:00:00Z", updated_at: "2026-10-24T10:00:00Z",
    financial_entries: [
      { id: 20, kind: "revenue", year: 2026, month: 10, amount: "25.000", vat_included: true, status: refs.revenue_statuses[0] },
      { id: 21, kind: "revenue", year: 2026, month: 11, amount: "15.000", vat_included: true, status: refs.revenue_statuses[0] },
    ],
  };
  let body: { financial_entries: { id?: number | null }[] } | undefined;
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/auth/me") return route.fulfill({ json: { id: 1, email: "t@example.test", full_name: "Менеджер", role: "analyst" } });
    if (path === "/api/dashboards") return route.fulfill({ json: [] });
    if (path === "/api/refs") return route.fulfill({ json: refs });
    if (path === "/api/clients") return route.fulfill({ json: [{ ...project.client, inn: "7707083893", segment: project.segment }] });
    if (path === "/api/projects/check-name") return route.fulfill({ json: { available: true } });
    if (path === "/api/projects/51/history") return route.fulfill({ json: { items: [], limit: 10, offset: 0, has_more: false } });
    if (path === "/api/projects/51" && request.method() === "GET") return route.fulfill({ json: project });
    if (path === "/api/projects/51" && request.method() === "PUT") {
      body = request.postDataJSON();
      return route.fulfill({ status: 422, json: { detail: "Тестовая остановка после чтения запроса" } });
    }
    return route.fulfill({ status: 404 });
  });
  await page.goto("/projects/51");
  const finances = page.getByRole("group", { name: "Помесячная выручка и затраты" });
  await finances.getByRole("button", { name: "Удалить", exact: true }).first().click();
  await finances.getByRole("button", { name: "Добавить финансовую строку" }).click();
  const row = finances.locator(".row2").nth(1);
  await row.getByLabel("Сумма, тыс. ₽").fill("25.000");
  await row.getByLabel("Статус начисления выручки").selectOption("4");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect.poll(() => body?.financial_entries.length).toBe(2);
  expect(body!.financial_entries.map((item) => item.id)).toEqual([21, null]);
  expect(Object.prototype.hasOwnProperty.call(body!.financial_entries[1], "id")).toBe(true);
});
