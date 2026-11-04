import type { Route } from "@playwright/test";

export async function emptyPipeline(route: Route): Promise<boolean> {
  if (route.request().method() !== "GET") return false;
  const path = new URL(route.request().url()).pathname;
  if (/^\/api\/projects\/\d+\/gantt$/.test(path)) {
    await route.fulfill({ json: { stages: [], revenue: [], costs: [] } });
    return true;
  }
  if (path === "/api/analytics/pipeline") {
    await route.fulfill({ json: { as_of: "2026-11-04", totals: { count: 0, amount: 0, weighted_amount: 0, revenue: 0, weighted_revenue: 0 }, by_stage: [], by_manager: [], by_segment: [], by_service: [] } });
    return true;
  }
  return false;
}
