import { emptyPipeline } from "./pipeline-mocks";
import { expect, test, type Page } from "@playwright/test";

import { FONT_FAMILIES, FONT_SCALES } from "../../src/components/FontSettings";
import type { Dashboard, Project, Refs, User } from "../../src/lib/types";

const ADMIN: User = { id: 1, email: "admin@rt.ru", full_name: "Администратор Ростелеком", role: "admin" };

const REFS: Refs = {
  segments: [{ id: 1, name: "Крупный бизнес (B2B)" }, { id: 2, name: "Государственный сектор (B2G)" }],
  services: [{ id: 10, name: "Облачная инфраструктура и ЦОД", group_name: "ИТ-услуги" }],
  managers: [{ id: ADMIN.id, full_name: ADMIN.full_name }],
  stages: [{ id: "lead", name: "Лид", probability: 10 }, { id: "won", name: "Выигран", probability: 100 }],
  payment_types: [{ id: 1, name: "Ежемесячный платёж" }],
  assessment_statuses: [{ id: 1, name: "Подтверждено" }],
  project_indicators: [{ id: 1, name: "Стратегический проект" }],
  customer_stages: [{ id: 1, name: "Инициация и проработка", probability: 20 }],
  cost_articles: [{ id: 1, name: "Оборудование" }],
  cost_types: [{ id: 1, name: "CAPEX" }],
  revenue_statuses: [{ id: 1, name: "План" }],
  cost_statuses: [{ id: 1, name: "План" }],
  roles: [{ id: "admin", name: "Администратор" }],
};

const SAMPLE_PROJECT: Project = {
  id: 101,
  name: "Комплексная цифровизация распределённой филиальной сети заказчика на базе защищённых каналов связи",
  description: "Описание крупного инфраструктурного проекта",
  client: { id: 50, name: "ПАО «Транспортно-логистическая корпорация регионов»" },
  client_inn: "7707049388",
  segment: REFS.segments[0],
  service: REFS.services[0],
  manager: REFS.managers[0],
  stage: "lead",
  stage_scheme: "customer",
  customer_stage: { id: 1, name: "Инициация и проработка" },
  amount: "125000000.00",
  cost: "75000000.00",
  profit: "50000000.00",
  margin: "50000000.00",
  margin_pct: 40,
  probability: 20,
  start_date: "2026-01-15",
  expected_close_date: "2026-12-20",
  closed_at: null,
  payment_type: REFS.payment_types[0],
  indicator: REFS.project_indicators[0],
  accepted_for_forecast: true,
  assessment_status: REFS.assessment_statuses[0],
  subsidiary_implementation: false,
  management_control: true,
  is_industry_solution: true,
  industry_manager: "Смирнов И. В.",
  industry_project_number: "IND-2026-01",
  implementation_year: 2026,
  project_status: "Согласование архитектуры решения, проверка технических требований и резервирования емкости по узлам связи в регионах присутствия клиента",
  realized_work: "Проведено обследование 45 площадок, подготовлен расчёт стоимости последней мили и спецификация серверного оборудования",
  period_plan: "Завершить защиту технико-коммерческого предложения на инвестиционном комитете и подписать рамочный договор",
  created_at: "2026-02-10T09:00:00Z",
  updated_at: "2026-10-20T12:00:00Z",
  financial_entries: [],
};

function makeDashboards(count: number): Dashboard[] {
  return Array.from({ length: count }, (_, idx) => ({
    id: idx + 1,
    name: idx === 0
      ? "Основной дашборд продаж"
      : `Дашборд направления №${idx + 1} — сводная аналитика и выполнение плана`,
    owner: { id: idx % 3 === 0 ? ADMIN.id : 2, full_name: idx % 3 === 0 ? ADMIN.full_name : "Коллега Аналитик" },
    is_shared: idx % 3 === 1,
    editable: true,
    updated_at: "2026-10-24T10:00:00Z",
    filters: { segment_ids: [], service_ids: [], manager_ids: [] },
    widgets: [
      { id: "w-kpi", type: "kpi", title: "Воронка проектов", x: 0, y: 0, w: 4, h: 2, config: { metric: "funnel" } },
      { id: "w-kpi-2", type: "kpi", title: "Выиграно с начала года", x: 4, y: 0, w: 4, h: 2, config: { metric: "won_ytd" } },
      { id: "w-kpi-3", type: "kpi", title: "Количество проектов", x: 8, y: 0, w: 4, h: 2, config: { metric: "projects" } },
      { id: "w-table", type: "projects", title: "Крупнейшие проекты в работе", x: 0, y: 2, w: 12, h: 6, config: { limit: 8 } },
    ],
  }));
}

async function setupMocks(page: Page, dashboardCount = 4) {
  const dashboards = makeDashboards(dashboardCount);
  await page.route("**/api/**", async (route) => {
    if (await emptyPipeline(route)) return;
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, "");
    if (path === "/auth/me") return route.fulfill({ json: ADMIN });
    if (path === "/auth/logout") return route.fulfill({ json: { ok: true } });
    if (path === "/refs") return route.fulfill({ json: REFS });
    if (path === "/dashboards") return route.fulfill({ json: dashboards });
    if (path.startsWith("/dashboards/")) {
      const id = Number(path.split("/")[2]);
      return route.fulfill({ json: dashboards.find((d) => d.id === id) ?? dashboards[0] });
    }
    if (path === "/projects") return route.fulfill({ json: { items: [SAMPLE_PROJECT], total: 1, page: 1, size: 20 } });
    if (path === "/projects/101") return route.fulfill({ json: SAMPLE_PROJECT });
    if (path === "/projects/101/gantt") return route.fulfill({ json: { stages: [], revenue: [], costs: [] } });
    if (path === "/projects/101/history") return route.fulfill({ json: { items: [], has_more: false } });
    if (path === "/projects/check-name") return route.fulfill({ json: { available: true } });
    if (path === "/clients") return route.fulfill({ json: [SAMPLE_PROJECT.client] });
    if (path === "/analytics/kpi") {
      return route.fulfill({
        json: {
          as_of: "2026-10-24",
          previous_as_of: "2026-09-24",
          items: [
            { key: "funnel", label: "Воронка", unit: "rub", value: 125_000_000, previous: 110_000_000, delta_pct: 13.6 },
            { key: "won_ytd", label: "Выиграно", unit: "rub", value: 45_000_000, previous: 40_000_000, delta_pct: 12.5 },
            { key: "projects", label: "Проектов", unit: "count", value: 18, previous: 15, delta_pct: 20 },
          ],
        },
      });
    }
    return route.fulfill({ json: {} });
  });
}

test("боковая панель: все 4 масштаба, 2 шрифта, длинный список дашбордов и сохранение после перезагрузки", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await setupMocks(page, 22);
  await page.goto("/projects");

  const sidebar = page.locator(".sidebar");
  await expect(sidebar.getByRole("link", { name: "Основной дашборд продаж" })).toBeVisible();

  const toggle = sidebar.locator(".font-settings-toggle");
  await toggle.locator("summary").click();
  const fontSelect = toggle.getByLabel("Шрифт");
  const scaleSelect = toggle.getByLabel("Размер");
  const logoutBtn = sidebar.getByRole("button", { name: "Выйти" });

  for (const family of FONT_FAMILIES) {
    await fontSelect.selectOption(family.id);
    for (const scale of FONT_SCALES) {
      await scaleSelect.selectOption(scale.id);

      const rootVars = await page.evaluate(() => ({
        uiScale: document.documentElement.style.getPropertyValue("--ui-scale"),
        font: document.documentElement.style.getPropertyValue("--font"),
        zoom: document.documentElement.style.getPropertyValue("zoom"),
      }));
      expect(rootVars.uiScale).toBe(String(scale.zoom));
      expect(rootVars.font).toBe(family.css);
      expect(rootVars.zoom).toBe(scale.zoom === 1 ? "" : String(scale.zoom));

      // Проверяем, что пункты бокового меню не сжимаются по высоте и текст не обрезается по вертикали
      const metrics = await sidebar.evaluate((nav) => {
        const items = Array.from(nav.querySelectorAll<HTMLElement>("a, button.link"));
        return {
          overflowY: getComputedStyle(nav).overflowY,
          scrollHeight: nav.scrollHeight,
          clientHeight: nav.clientHeight,
          minClientHeight: Math.min(...items.map((el) => el.clientHeight)),
          anyVerticalClip: items.some((el) => el.scrollHeight > el.clientHeight + 2),
        };
      });
      expect(metrics.overflowY).toBe("auto");
      expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
      expect(metrics.minClientHeight).toBeGreaterThanOrEqual(24);
      expect(metrics.anyVerticalClip).toBe(false);

      // Настройки шрифта и кнопка выхода остаются доступными
      await expect(fontSelect).toBeVisible();
      await expect(scaleSelect).toBeVisible();
      await expect(logoutBtn).toBeVisible();
    }
  }

  // Настройка «Arial» + «Очень крупный» сохраняется после перезагрузки страницы
  await page.reload();
  await expect(sidebar.getByRole("link", { name: "Основной дашборд продаж" })).toBeVisible();
  const persisted = await page.evaluate(() => ({
    raw: localStorage.getItem("rt-font-settings"),
    uiScale: document.documentElement.style.getPropertyValue("--ui-scale"),
    zoom: document.documentElement.style.getPropertyValue("zoom"),
  }));
  expect(JSON.parse(persisted.raw ?? "{}")).toEqual({ family: "arial", scale: "130" });
  expect(persisted.uiScale).toBe("1.3");
  expect(persisted.zoom).toBe("1.3");
});

test("дашборд, таблицы и формы при масштабе «Очень крупный», узком окне и браузерном масштабе", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("rt-font-settings", JSON.stringify({ family: "brand", scale: "130" }));
  });
  await setupMocks(page, 6);

  // 1. Дашборд на стандартном экране при «Очень крупный»
  await page.setViewportSize({ width: 1280, height: 760 });
  await page.goto("/dashboards/1");
  await expect(page.locator(".widget .value").first()).toBeVisible();

  // Заголовок виджета не перекрывает значение KPI, а текст KPI не обрезан родительской карточкой
  const kpiCards = page.locator(".widget").filter({ has: page.locator(".kpi") });
  await expect(kpiCards).toHaveCount(3);
  for (let i = 0; i < 3; i++) {
    const card = kpiCards.nth(i);
    const headBox = await card.locator(".widget-head").boundingBox();
    const valueBox = await card.locator(".kpi .value").boundingBox();
    const cardBox = await card.boundingBox();
    expect(valueBox!.y).toBeGreaterThanOrEqual(headBox!.y + headBox!.height - 1);
    expect(valueBox!.y + valueBox!.height).toBeLessThanOrEqual(cardBox!.y + cardBox!.height + 1);
  }

  // Меню правого виджета помещается в пределы видимого окна при zoom 1.3
  const rightCard = kpiCards.nth(2);
  await rightCard.getByRole("button", { name: "Действия с виджетом" }).click();
  const menu = page.locator(".widget-menu");
  await expect(menu).toBeVisible();
  const menuBox = await menu.boundingBox();
  expect(menuBox!.x).toBeGreaterThanOrEqual(0);
  expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(1280);
  expect(menuBox!.y + menuBox!.height).toBeLessThanOrEqual(760);

  // Диалог настройки виджета помещается в окно и кнопки управления доступны
  await menu.getByRole("button", { name: "Настроить…" }).click();
  const modal = page.locator(".modal");
  await expect(modal).toBeVisible();
  const modalBox = await modal.boundingBox();
  expect(modalBox!.y).toBeGreaterThanOrEqual(0);
  expect(modalBox!.y + modalBox!.height).toBeLessThanOrEqual(760);
  await modal.getByRole("button", { name: "Отмена" }).click();

  // 2. Таблица и форма проекта при масштабе «Очень крупный»
  await page.goto("/projects");
  await expect(page.locator(".projects-table tbody tr").first()).toBeVisible();
  const expandBtn = page.locator(".cell-expand-btn").first();
  await expect(expandBtn).toBeVisible();
  await expandBtn.click();
  await expect(page.getByTestId("full-text-modal-content")).toBeVisible();
  await page.getByRole("button", { name: "Закрыть" }).click();

  await page.goto("/projects/101");
  await expect(page.getByLabel(/Дата начала/)).toBeVisible();
  const formOverflow = await page.locator("form.card").evaluate((form) => {
    const inputs = Array.from(form.querySelectorAll<HTMLElement>("input, select, textarea"));
    const formRect = form.getBoundingClientRect();
    return inputs.some((el) => {
      const r = el.getBoundingClientRect();
      return r.right > formRect.right + 1 || r.left < formRect.left - 1;
    });
  });
  expect(formOverflow).toBe(false);

  // 3. Узкое окно (мобильная ширина <= 900px) и браузерный масштаб
  await page.setViewportSize({ width: 390, height: 740 });
  const narrowSidebar = await page.locator(".sidebar").evaluate((nav) => {
    const rect = nav.getBoundingClientRect();
    return { right: rect.right, innerWidth: window.innerWidth };
  });
  expect(narrowSidebar.right).toBeLessThanOrEqual(narrowSidebar.innerWidth + 1);
  await expect(page.locator(".sidebar").getByRole("button", { name: "Выйти" })).toBeVisible();
});
