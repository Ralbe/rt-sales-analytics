import { expect, test } from "@playwright/test";

test.use({ timezoneId: "Europe/Moscow" });

test("аналитика: показывает обе схемы, отсутствующую выручку и раздельный НДС", async ({ page }, testInfo) => {
  let legacyRevenue = "100.01";
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/me") return route.fulfill({ json: { id: 1, email: "test@example.test", full_name: "Аналитик", role: "analyst" } });
    if (path === "/api/dashboards") return route.fulfill({ json: [] });
    if (path === "/api/project-timeline/stage-statistics") return route.fulfill({ json: {
      generated_at: "2026-10-30T12:00:00Z", project_count: 3, projects_with_history: 1,
      stage_statistics: [
        { stage_key: "customer:8", stage_label: "8. Заключение РД", completed_visits: 1, average_days: 0.0001 },
        { stage_key: "customer:9", stage_label: "9. Реализация", completed_visits: 0, average_days: null },
      ], notes: [],
    } });
    if (path === "/api/analytics/weighted-revenue") return route.fulfill({ json: {
      stage_scope: "all", project_count: 3, missing_revenue_count: 1,
      scope_note: "Текущая вероятность. Все годы и все статусы. Тысячи рублей переведены в рубли.",
      buckets: [
        { basis: "with_vat", label: "С НДС", revenue_rub: "1000000.00", weighted_revenue_rub: "300000.00" },
        { basis: "without_vat", label: "Без НДС", revenue_rub: "2000.00", weighted_revenue_rub: "740.00" },
        { basis: "unspecified", label: "НДС не указан (прежняя схема)", revenue_rub: legacyRevenue, weighted_revenue_rub: legacyRevenue === "0.00" ? "0.00" : "50.01" },
      ],
    } });
    return route.fulfill({ status: 404, json: { detail: "Не найдено" } });
  });
  await page.goto("/analytics");
  const summary = page.getByRole("region", { name: "Выручка с учётом вероятности", exact: true });
  await expect(summary.getByRole("term")).toHaveText(["Проектов", "Без данных о выручке"]);
  await expect(summary.getByRole("definition")).toHaveText(["3", "1"]);
  await expect(summary.getByRole("columnheader", { name: "Выручка с учётом вероятности, ₽", exact: true })).toBeVisible();
  await expect(page.getByText("Все доступные проекты, кроме архивных", { exact: true })).toHaveCount(0);
  await expect(summary.getByRole("row", { name: /Суммы с НДС/ })).toContainText("300 000,00 ₽");
  await expect(summary.getByRole("row", { name: /Суммы без НДС/ })).toContainText("740,00 ₽");
  await expect(summary.getByRole("row", { name: /прежняя схема/ })).toContainText("50,01 ₽");
  await expect(summary).not.toContainText("Тысячи рублей переведены в рубли");
  const durations = page.getByRole("region", { name: "Среднее время на этапах" });
  await expect(durations.getByRole("term")).toHaveText(["Проектов", "С историей"]);
  await expect(durations.getByRole("definition")).toHaveText(["3", "1"]);
  await expect(durations.getByRole("row", { name: /8\. Заключение РД/ })).toContainText("Менее 1 мин");
  await expect(durations.getByRole("row", { name: /9\. Реализация/ })).toContainText("Нет завершённых периодов");
  await expect(durations).toContainText("30.10.2026, 15:00:00");
  legacyRevenue = "0.00";
  await page.reload();
  await expect(summary.getByRole("row", { name: /прежняя схема/ })).toHaveCount(0);
  await expect(summary.getByRole("row")).toHaveCount(3);
  await page.screenshot({ path: testInfo.outputPath("analytics-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await summary.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("analytics-mobile.png") });
});
