"use client";

import { useQuery } from "@tanstack/react-query";
import type { EChartsOption } from "echarts";
import { useRouter } from "next/navigation";

import { Chart } from "@/components/Chart";
import { api } from "@/lib/api";
import { count, date, money, pct } from "@/lib/format";
import type {
  BreakdownResponse,
  DashboardFilters,
  KpiResponse,
  ProjectPage,
  TrendResponse,
  Widget,
} from "@/lib/types";

interface Props {
  widget: Widget;
  filters: DashboardFilters;
}

export const filterQuery = (f: DashboardFilters) => ({
  segment_id: f.segment_ids,
  service_id: f.service_ids,
  manager_id: f.manager_ids,
});

const isMoney = (metric?: string) => metric !== "projects";
const fmt = (metric?: string) => (v: number) => (isMoney(metric) ? money(v) : count(v));

function State({ loading, error }: { loading: boolean; error: unknown }) {
  if (loading) return <div className="muted">Загрузка…</div>;
  if (error) return <div className="alert">Не удалось загрузить данные</div>;
  return null;
}

export function KpiWidget({ widget, filters }: Props) {
  const q = useQuery({
    queryKey: ["kpi", filters],
    queryFn: () => api<KpiResponse>("/analytics/kpi", { query: filterQuery(filters) }),
  });
  if (!q.data) return <State loading={q.isLoading} error={q.error} />;
  const item = q.data.items.find((i) => i.key === (widget.config.metric ?? "funnel"));
  if (!item) return null;
  const show = item.unit === "rub" ? money : count;
  const dir = item.delta_pct === null || item.delta_pct === 0 ? "" : item.delta_pct > 0 ? "up" : "down";
  return (
    <div className="kpi">
      <div className="value">{show(item.value)}</div>
      <div className={`delta ${dir}`}>
        {dir === "up" ? "▲" : dir === "down" ? "▼" : ""} {pct(item.delta_pct)}{" "}
        <span className="muted">
          к {date(q.data.previous_as_of)}: {show(item.previous)}
        </span>
      </div>
    </div>
  );
}

export function TrendWidget({ widget, filters }: Props) {
  const { metric = "funnel", weeks = 6, horizon = 14, chart = "line" } = widget.config;
  const q = useQuery({
    queryKey: ["trend", filters, metric, weeks, horizon],
    queryFn: () =>
      api<TrendResponse>("/analytics/trend", { query: { ...filterQuery(filters), metric, weeks, horizon } }),
  });
  if (!q.data) return <State loading={q.isLoading} error={q.error} />;
  const { history, forecast } = q.data;
  const f = fmt(metric);
  const dates = [...history, ...forecast].map((p) => date(p.date).slice(0, 5));
  const pad = (n: number) => Array<null>(n).fill(null);
  const last = history[history.length - 1];
  // Прогноз стыкуется с последней фактической точкой, чтобы линия была непрерывной
  const forecastLine = [...pad(history.length - 1), last?.value ?? null, ...forecast.map((p) => p.value)];
  const lower = [...pad(history.length), ...forecast.map((p) => p.lower)];
  const band = [...pad(history.length), ...forecast.map((p) => p.upper - p.lower)];

  const option: EChartsOption = {
    grid: { left: 8, right: 16, top: 28, bottom: 4, containLabel: true },
    legend: { top: 0, right: 0, itemWidth: 14, data: ["Факт", "Прогноз"] },
    tooltip: {
      trigger: "axis",
      valueFormatter: (v) => (v === null || v === undefined ? "—" : f(Number(v))),
    },
    xAxis: { type: "category", data: dates, boundaryGap: chart === "bar", axisLabel: { hideOverlap: true } },
    yAxis: { type: "value", scale: true, axisLabel: { formatter: (v: number) => f(v) } },
    series: [
      {
        name: "Факт",
        type: chart === "bar" ? "bar" : "line",
        data: [...history.map((p) => p.value), ...pad(forecast.length)],
        showSymbol: false,
        smooth: true,
        areaStyle: chart === "bar" ? undefined : { opacity: 0.08 },
      },
      {
        name: "Прогноз",
        type: "line",
        data: forecastLine,
        showSymbol: false,
        lineStyle: { type: "dashed" },
        smooth: true,
      },
      { name: "lower", type: "line", data: lower, stack: "band", lineStyle: { opacity: 0 }, symbol: "none", tooltip: { show: false } },
      {
        name: "Диапазон",
        type: "line",
        data: band,
        stack: "band",
        lineStyle: { opacity: 0 },
        symbol: "none",
        areaStyle: { color: "#ff8a3d", opacity: 0.15 },
        tooltip: { show: false },
      },
    ],
  };
  return <Chart option={option} />;
}

export function BreakdownWidget({ widget, filters }: Props) {
  const { metric = "funnel", group_by = "segment", chart = "bar" } = widget.config;
  const q = useQuery({
    queryKey: ["breakdown", filters, group_by, metric],
    queryFn: () =>
      api<BreakdownResponse>("/analytics/breakdown", { query: { ...filterQuery(filters), group_by, metric } }),
  });
  if (!q.data) return <State loading={q.isLoading} error={q.error} />;
  const items = q.data.items;
  const f = fmt(metric);
  if (!items.length) return <div className="muted">Нет данных для выбранных фильтров</div>;

  if (chart === "table") {
    const total = items.reduce((s, i) => s + i.value, 0);
    return (
      <div style={{ height: "100%", overflow: "auto" }}>
        <table className="table">
          <tbody>
            {items.map((i) => (
              <tr key={i.key}>
                <td>{i.label}</td>
                <td className="num">{f(i.value)}</td>
                <td className="num muted">{((i.value / total) * 100).toFixed(1)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  let option: EChartsOption;
  if (chart === "donut" || chart === "pie") {
    option = {
      tooltip: { trigger: "item", valueFormatter: (v) => f(Number(v)) },
      legend: { type: "scroll", orient: "vertical", right: 0, top: "middle", itemWidth: 12, textStyle: { fontSize: 12 } },
      series: [
        {
          type: "pie",
          radius: chart === "donut" ? ["45%", "75%"] : "75%",
          center: ["35%", "50%"],
          label: { show: false },
          data: items.map((i) => ({ name: i.label, value: i.value })),
        },
      ],
    };
  } else {
    const horizontal = chart === "hbar";
    const cat = { type: "category" as const, data: items.map((i) => i.label), axisLabel: { interval: 0, width: 110, overflow: "truncate" as const } };
    const val = { type: "value" as const, axisLabel: { formatter: (v: number) => f(v) } };
    option = {
      grid: { left: 8, right: 16, top: 12, bottom: 4, containLabel: true },
      tooltip: { trigger: "axis", valueFormatter: (v) => f(Number(v)) },
      xAxis: horizontal ? val : { ...cat, axisLabel: { ...cat.axisLabel, rotate: items.length > 4 ? 25 : 0 } },
      yAxis: horizontal ? { ...cat, inverse: true } : val,
      series: [{ type: "bar", data: items.map((i) => i.value), barMaxWidth: 36, itemStyle: { borderRadius: 3 } }],
    };
  }
  return <Chart option={option} />;
}

export function ProjectsWidget({ widget, filters }: Props) {
  const router = useRouter();
  const limit = widget.config.limit ?? 8;
  const q = useQuery({
    queryKey: ["top-projects", filters, limit],
    queryFn: () =>
      api<ProjectPage>("/projects", {
        query: { ...filterQuery(filters), open_only: true, sort: "-amount", size: limit },
      }),
  });
  if (!q.data) return <State loading={q.isLoading} error={q.error} />;
  return (
    <div style={{ height: "100%", overflow: "auto" }}>
      <table className="table">
        <thead>
          <tr>
            <th>Проект</th>
            <th>Клиент</th>
            <th>Ответственный</th>
            <th className="num">Сумма</th>
          </tr>
        </thead>
        <tbody>
          {q.data.items.map((p) => (
            <tr key={p.id} className="clickable" onClick={() => router.push(`/projects/${p.id}`)}>
              <td>{p.name}</td>
              <td>{p.client.name}</td>
              <td>{p.manager.full_name}</td>
              <td className="num">{money(p.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function WidgetContent(props: Props) {
  switch (props.widget.type) {
    case "kpi":
      return <KpiWidget {...props} />;
    case "trend":
      return <TrendWidget {...props} />;
    case "breakdown":
      return <BreakdownWidget {...props} />;
    case "projects":
      return <ProjectsWidget {...props} />;
  }
}
