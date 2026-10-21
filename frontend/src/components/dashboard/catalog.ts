import type { ChartKind, GroupBy, KpiKey, Widget, WidgetConfig, WidgetType } from "@/lib/types";

export const WIDGET_TYPES: { id: WidgetType; name: string }[] = [
  { id: "kpi", name: "Показатель (KPI)" },
  { id: "trend", name: "Динамика воронки и прогноз" },
  { id: "breakdown", name: "Разбивка (диаграмма)" },
  { id: "projects", name: "Крупнейшие проекты" },
];

export const METRICS: { id: KpiKey; name: string }[] = [
  { id: "funnel", name: "Объём воронки" },
  { id: "projects", name: "Количество проектов" },
  { id: "won_ytd", name: "Выиграно с начала года" },
];

export const GROUPS: { id: GroupBy; name: string }[] = [
  { id: "segment", name: "сегментам" },
  { id: "service", name: "услугам" },
  { id: "manager", name: "менеджерам" },
  { id: "stage", name: "стадиям" },
];

export const CHARTS: Record<"trend" | "breakdown", { id: ChartKind; name: string }[]> = {
  trend: [
    { id: "line", name: "Линия" },
    { id: "bar", name: "Столбцы" },
  ],
  breakdown: [
    { id: "bar", name: "Столбцы" },
    { id: "hbar", name: "Горизонтальные столбцы" },
    { id: "donut", name: "Кольцевая" },
    { id: "pie", name: "Круговая" },
    { id: "table", name: "Таблица" },
  ],
};

const SIZES: Record<WidgetType, { w: number; h: number }> = {
  kpi: { w: 4, h: 2 },
  trend: { w: 7, h: 5 },
  breakdown: { w: 5, h: 5 },
  projects: { w: 6, h: 5 },
};

export function defaultConfig(type: WidgetType): WidgetConfig {
  switch (type) {
    case "kpi":
      return { metric: "funnel" };
    case "trend":
      return { metric: "funnel", weeks: 6, horizon: 14, chart: "line" };
    case "breakdown":
      return { metric: "funnel", group_by: "segment", chart: "bar" };
    case "projects":
      return { limit: 8 };
  }
}

export function autoTitle(type: WidgetType, c: WidgetConfig): string {
  const metric = METRICS.find((m) => m.id === c.metric)?.name ?? "";
  switch (type) {
    case "kpi":
      return metric;
    case "trend":
      return `${c.metric === "projects" ? "Число проектов" : "Объём воронки"}: ${c.weeks} нед. + прогноз ${c.horizon} дн.`;
    case "breakdown":
      return `${metric} по ${GROUPS.find((g) => g.id === c.group_by)?.name ?? ""}`;
    case "projects":
      return "Крупнейшие проекты в работе";
  }
}

/** Новый виджет ставится под существующими. */
export function newWidget(type: WidgetType, config: WidgetConfig, title: string, existing: Widget[]): Widget {
  const bottom = existing.reduce((m, w) => Math.max(m, w.y + w.h), 0);
  return { id: `w-${Date.now().toString(36)}`, type, title, x: 0, y: bottom, ...SIZES[type], config };
}
