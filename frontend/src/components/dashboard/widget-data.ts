import type { DashboardFilters, Widget } from "@/lib/types";

/** Общие ключи для экранных запросов и снимка уже загруженных данных. */
export function widgetQueryKey(widget: Widget, filters: DashboardFilters) {
  const { metric = "funnel", weeks = 6, group_by = "segment", limit = 8 } = widget.config;
  switch (widget.type) {
    case "kpi": return ["kpi", filters];
    case "trend": return ["trend", filters, metric, weeks];
    case "breakdown": return ["breakdown", filters, group_by, metric];
    case "projects": return ["top-projects", filters, limit];
    case "profit": return ["profit", filters, limit];
    case "failures": return ["failures", filters, limit];
  }
}
