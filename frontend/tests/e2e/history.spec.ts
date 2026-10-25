import { expect, test, type Page, type Route } from "@playwright/test";

import type { ProjectHistoryItem } from "../../src/lib/history-types";
import type { FinancialEntry, Project, Refs } from "../../src/lib/types";

const author = { id: 7, full_name: "Мария Продажина" };
const status = { id: 20, name: "Начислено" };
const refs: Refs = {
  segments: [{ id: 1, name: "Корпоративные клиенты" }],
  services: [{ id: 2, name: "Облачные услуги", group_name: null }],
  managers: [author],
  stages: [{ id: "proposal", name: "КП отправлено", probability: 50 }],
  payment_types: [], customer_stages: [], project_indicators: [], assessment_statuses: [],
  cost_articles: [], cost_types: [], revenue_statuses: [status], cost_statuses: [], roles: [],
};

function projectFixture(): Project {
  return {
    id: 42, name: "Проект с историей", description: "До изменения",
    client: { id: 1, name: "ООО «Заказчик»" }, segment: refs.segments[0], manager: author,
    service: refs.services[0], stage: "proposal", amount: "1000.00", cost: "0.00", margin: "1000.00",
    margin_pct: 100, probability: 50, start_date: "2026-10-01", expected_close_date: "2026-12-31", closed_at: null,
    payment_type: null, customer_stage: null, indicator: null, accepted_for_forecast: false, assessment_status: null,
    subsidiary_implementation: false, management_control: false, is_industry_solution: false,
    industry_manager: null, industry_project_number: null, implementation_year: null, project_status: null,
    realized_work: "", period_plan: "", created_at: "2026-10-24T12:00:00Z", updated_at: "2026-10-24T12:00:00Z",
    financial_entries: [{ id: 1, kind: "revenue", year: 2026, month: 10, amount: "1.001", vat_included: true, status }],
  };
}

function historyItem(id: number, changes: ProjectHistoryItem["changes"] = []): ProjectHistoryItem {
  return {
    id, action: "update", title: "Изменение карточки", author_name: author.full_name,
    created_at: "2026-10-25T10:20:30Z", changes, note: null,
  };
}

async function mockApi(page: Page, initial: ProjectHistoryItem[] = [], onHistory?: (route: Route) => Promise<void>) {
  const state = { project: projectFixture(), history: [...initial], historyRequests: 0, financialStatus: 200 };
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === "/api/auth/me") return route.fulfill({ json: { ...author, email: "test@example.com", role: "user" } });
    if (path === "/api/dashboards") return route.fulfill({ json: [] });
    if (path === "/api/refs") return route.fulfill({ json: refs });
    if (path === "/api/projects/check-name") return route.fulfill({ json: { available: true } });
    if (path === "/api/projects/42/history") {
      state.historyRequests += 1;
      expect(url.searchParams.get("limit")).toBe("10");
      if (onHistory) return onHistory(route);
      return route.fulfill({ json: {
        items: state.history.slice(0, 10), limit: 10, offset: 0, has_more: state.history.length > 10,
      } });
    }
    if (path === "/api/projects/42" && route.request().method() === "PUT") {
      const body = route.request().postDataJSON() as { description: string };
      if (body.description !== state.project.description) {
        state.history.unshift(historyItem(100, [{
          field: "description", label: "Описание", before: state.project.description, after: body.description,
        }]));
        state.project = { ...state.project, description: body.description, updated_at: "2026-10-25T12:00:00Z" };
      }
      return route.fulfill({ json: state.project });
    }
    if (path === "/api/projects/42/financial-entries") {
      if (state.financialStatus !== 200) {
        return route.fulfill({ status: state.financialStatus, json: { detail: "Не удалось сохранить финансовые строки" } });
      }
      const entries = route.request().postDataJSON() as FinancialEntry[];
      if (entries[0]?.amount !== state.project.financial_entries[0]?.amount) {
        state.history.unshift({ ...historyItem(101, [{
          field: "financial_entries", label: "Финансовая строка добавлена", before: "Строка отсутствовала",
          after: "Выручка · 10.2026 · 2,345 тыс. ₽ · с НДС · Статус: Начислено",
        }]), action: "replace_financial_entries", title: "Изменение финансовых строк" });
      }
      const saved = entries.map((entry, index) => ({ ...entry, id: index + 100, status }));
      state.project = { ...state.project, financial_entries: saved };
      return route.fulfill({ json: saved });
    }
    if (path === "/api/projects/42") return route.fulfill({ json: state.project });
    return route.fulfill({ status: 404, json: { detail: "Тестовый маршрут не найден" } });
  });
  return state;
}

test("последние 10 изменений содержат автора, дату, точные суммы и старые неполные значения", async ({ page }) => {
  const items = Array.from({ length: 12 }, (_, index) => historyItem(12 - index, [{
    field: "name", label: "Название проекта", before: `До ${index}`, after: `После ${index}`,
  }]));
  items[0] = { ...historyItem(12, [{
    field: "financial_entries", label: "Финансовая строка после сохранения", before: null,
    after: "Выручка · 10.2026 · 123 456 789 012,123 тыс. ₽ · с НДС · Статус: Начислено",
  }]), action: "replace_financial_entries", title: "Изменение финансовых строк" };
  await mockApi(page, items);
  await page.goto("/projects/42");
  const history = page.getByRole("region", { name: "История изменений" });
  await expect(history.getByRole("listitem")).toHaveCount(10);
  const first = history.getByRole("listitem").first();
  await expect(first).toContainText(author.full_name);
  await expect(first.locator("time")).toHaveAttribute("datetime", "2026-10-25T10:20:30Z");
  await expect(first).toContainText("123 456 789 012,123 тыс. ₽");
  await expect(first).toContainText("Статус: Начислено");
  await expect(first).toContainText("Не записано");
  await expect(history).not.toContainText("После 10");
});

test("загрузка, ошибка, повторная попытка и пустая история", async ({ page }) => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let requests = 0;
  await mockApi(page, [], async (route) => {
    requests += 1;
    if (requests === 1) {
      await gate;
      return route.fulfill({ status: 503, json: { detail: "Временно недоступно" } });
    }
    return route.fulfill({ json: { items: [], limit: 10, offset: 0, has_more: false } });
  });
  await page.goto("/projects/42");
  const history = page.getByRole("region", { name: "История изменений" });
  await expect(history.getByRole("status")).toHaveText("Загрузка истории…");
  release();
  await expect(history.getByRole("alert")).toContainText("Не удалось загрузить историю изменений.");
  await history.getByRole("button", { name: "Повторить загрузку" }).click();
  await expect(history).toContainText("История изменений пока пуста.");
  expect(requests).toBe(2);
});

test("сохранение карточки и финансов обновляет историю и оставляет сохранённые строки в форме", async ({ page }) => {
  const state = await mockApi(page);
  await page.goto("/projects/42");
  const history = page.getByRole("region", { name: "История изменений" });
  await expect(history).toContainText("История изменений пока пуста.");
  await page.getByLabel("Суть проекта").fill("После сохранения");
  await page.getByLabel("Сумма, тыс. рублей").fill("2.345");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(history).toContainText("После сохранения");
  await expect(history).toContainText("2,345 тыс. ₽");
  await expect(history.getByRole("listitem")).toHaveCount(2);
  await expect(page.getByLabel("Сумма, тыс. рублей")).toHaveValue("2.345");
  await expect(page.getByRole("button", { name: "Сохранить", exact: true })).toBeDisabled();
  expect(state.historyRequests).toBeGreaterThan(1);
});

test("сохранение только финансов обновляет историю и завершает редактирование", async ({ page }) => {
  await mockApi(page);
  await page.goto("/projects/42");
  const history = page.getByRole("region", { name: "История изменений" });
  await expect(history).toContainText("История изменений пока пуста.");
  await page.getByLabel("Сумма, тыс. рублей").fill("2.345");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(history).toContainText("2,345 тыс. ₽");
  await expect(history.getByRole("listitem")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Сохранить", exact: true })).toBeDisabled();
});

test("история обновляется при сохранённой карточке и ошибке следующего запроса финансов", async ({ page }) => {
  const state = await mockApi(page);
  state.financialStatus = 422;
  await page.goto("/projects/42");
  const history = page.getByRole("region", { name: "История изменений" });
  await expect(history).toContainText("История изменений пока пуста.");
  await page.getByLabel("Суть проекта").fill("Карточка сохранена частично");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(page.getByText("Не удалось сохранить финансовые строки", { exact: true })).toBeVisible();
  await expect(history).toContainText("Карточка сохранена частично");
  expect(state.historyRequests).toBeGreaterThan(1);
});
