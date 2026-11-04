"use client";

import { useQuery } from "@tanstack/react-query";
import type { EChartsOption } from "echarts";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";

import { Chart } from "@/components/Chart";
import { api } from "@/lib/api";
import { chartMoney, count, date, money, moneyFull, pct } from "@/lib/format";
import { managerName } from "@/lib/reference-options";
import { useRefs } from "@/lib/hooks";
import { PROJECT_FIELD_DEFAULTS, useProjectFieldLabels, type ProjectFieldLabels } from "@/lib/project-field-labels";
import type {
  BreakdownResponse,
  AnalyticsScope,
  DashboardFilters,
  FailuresResponse,
  KpiResponse,
  ProfitResponse,
  ProjectPage,
  Refs,
  TrendResponse,
  Widget,
} from "@/lib/types";

import { widgetQueryKey } from "./widget-data";
import { AnalyticsScopeNote } from "./AnalyticsScopeNote";

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

function AnalyticsFrame({ data, children, printable = false }: { data: AnalyticsScope; children: ReactNode; printable?: boolean }) {
  return <div style={{ height: printable ? undefined : "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
    <AnalyticsScopeNote data={data} />
    <div style={{ flex: 1, minHeight: 0 }}>{children}</div>
  </div>;
}

function State({ loading, error }: { loading: boolean; error: unknown }) {
  if (loading) return <div className="muted">Загрузка…</div>;
  if (error) return <div className="alert">Не удалось загрузить данные</div>;
  return null;
}

export function KpiWidget({ widget, filters }: Props) {
  const q = useQuery({
    queryKey: widgetQueryKey(widget, filters),
    queryFn: () => api<KpiResponse>("/analytics/kpi", { query: filterQuery(filters) }),
  });
  if (!q.data) return <State loading={q.isLoading} error={q.error} />;
  return <KpiView widget={widget} data={q.data} />;
}

export function KpiView({ widget, data }: { widget: Widget; data: KpiResponse }) {
  const item = data.items.find((i) => i.key === (widget.config.metric ?? "funnel"));
  if (!item) return null;
  const show = item.unit === "rub" ? money : count;
  const dir = item.delta_pct === null || item.delta_pct === 0 ? "" : item.delta_pct > 0 ? "up" : "down";
  return (
    <AnalyticsFrame data={data}><div className="kpi">
      <div className="value">{show(item.value)}</div>
      <div className={`delta ${dir}`}>
        {dir === "up" ? "▲" : dir === "down" ? "▼" : ""} {pct(item.delta_pct)}{" "}
        <span className="muted">
          к {date(data.previous_as_of)}: {show(item.previous)}
        </span>
      </div>
    </div></AnalyticsFrame>
  );
}

export function TrendWidget({ widget, filters }: Props) {
  const { metric = "funnel", year = new Date().getFullYear(), months = Array.from({ length: 12 }, (_, i) => i + 1) } = widget.config;
  const q = useQuery({
    queryKey: widgetQueryKey(widget, filters),
    queryFn: () => api<TrendResponse>("/analytics/trend-monthly", { query: { ...filterQuery(filters), metric, year, months } }),
  });
  if (!q.data) return <State loading={q.isLoading} error={q.error} />;
  return <TrendView widget={widget} data={q.data} />;
}

/** Фактическая динамика проектов в работе; прогноз по решению заказчика не строится. */
export function TrendView({ widget, data, printable = false }: { widget: Widget; data: TrendResponse; printable?: boolean }) {
  const { metric = "funnel", chart = "line" } = widget.config;
  const { history } = data;
  const f = fmt(metric);
  const scale = chartMoney(history.map((p) => p.value));
  const option: EChartsOption = {
    grid: { left: 8, right: 24, top: 32, bottom: 8, containLabel: true },
    tooltip: { trigger: "axis", valueFormatter: (v) => (v === null || v === undefined ? "—" : f(Number(v))) },
    xAxis: {
      type: "category", data: history.map((p) => date(p.date).slice(3)), boundaryGap: chart === "bar",
      axisLabel: { hideOverlap: true },
    },
    yAxis: { type: "value", name: isMoney(metric) ? scale.unit : "проектов", nameTextStyle: { align: "left" }, axisLabel: { formatter: (v: number) => isMoney(metric) ? scale.format(v) : count(v) } },
    series: [{
      name: metric === "projects" ? "Проектов в работе" : "Сумма проектов в работе",
      type: chart === "bar" ? "bar" : "line",
      data: history.map((p) => p.value),
      showSymbol: false,
      smooth: true,
      areaStyle: chart === "bar" ? undefined : { opacity: 0.08 },
    }],
  };
  return (
    <div style={{ height: printable ? undefined : "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
      {data.scope_note && <p className="hint" role="note" style={{ flexShrink: 0, margin: "0 0 6px" }}>{data.scope_note}</p>}
      <div style={{ flex: 1, minHeight: 0 }}><Chart option={option} printable={printable} /></div>
    </div>
  );
}

export function BreakdownWidget({ widget, filters }: Props) {
  const { data: refs } = useRefs();
  const { metric = "funnel", group_by = "segment" } = widget.config;
  const q = useQuery({
    queryKey: widgetQueryKey(widget, filters),
    queryFn: () =>
      api<BreakdownResponse>("/analytics/breakdown", { query: { ...filterQuery(filters), group_by, metric } }),
  });
  if (!q.data) return <State loading={q.isLoading} error={q.error} />;
  return <BreakdownView widget={widget} data={q.data} refs={refs} />;
}

export function BreakdownView({ widget, data, printable = false, refs }: { widget: Widget; data: BreakdownResponse; printable?: boolean; refs?: Refs }) {
  const { metric = "funnel" } = widget.config;
  const chart = ["pie", "donut"].includes(widget.config.chart ?? "") ? "hbar" : widget.config.chart ?? "hbar";
  const items = data.group_by === "manager" ? data.items.map((item) => ({
    ...item, label: managerName({ id: Number(item.key), full_name: item.label }, refs),
  })) : data.items;
  const f = fmt(metric);
  if (!items.length) return <AnalyticsFrame data={data} printable={printable}><div className="muted">Нет данных для выбранных фильтров</div></AnalyticsFrame>;

  if (chart === "table") {
    const total = items.reduce((s, i) => s + i.value, 0);
    return (
      <AnalyticsFrame data={data} printable={printable}><div className="widget-table" style={printable ? undefined : { height: "100%", overflow: "auto" }}>
        <table className="table">
          <colgroup><col style={{ width: "60%" }} /><col style={{ width: "25%" }} /><col style={{ width: "15%" }} /></colgroup>
          {printable && <thead><tr><th>Группа</th><th className="num">Значение</th><th className="num">Доля</th></tr></thead>}
          <tbody>
            {items.map((i) => (
              <tr key={i.key}>
                <td>{i.label}</td>
                <td className="num">{f(i.value)}</td>
                <td className="num muted">{new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 }).format(total ? i.value / total * 100 : 0)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div></AnalyticsFrame>
    );
  }

  const scale = chartMoney(items.map((i) => i.value));
  let option: EChartsOption;
  {
    const horizontal = chart === "hbar";
    const cat = {
      type: "category" as const,
      data: items.map((i) => i.label),
      axisLabel: { interval: printable ? "auto" as const : 0, hideOverlap: printable, width: 110, overflow: "truncate" as const },
    };
    const val = { type: "value" as const, name: isMoney(metric) ? scale.unit : "проектов",
      nameLocation: horizontal ? "middle" as const : "end" as const, nameGap: horizontal ? 28 : 15,
      nameTextStyle: { align: horizontal ? "center" as const : "left" as const },
      axisLabel: { formatter: (v: number) => isMoney(metric) ? scale.format(v) : count(v) } };
    option = {
      grid: { left: 8, right: 24, top: horizontal ? 12 : 32, bottom: horizontal ? 40 : 8, containLabel: true },
      tooltip: { trigger: "axis", valueFormatter: (v) => f(Number(v)) },
      xAxis: horizontal ? val : { ...cat, axisLabel: { ...cat.axisLabel, rotate: items.length > 4 ? 25 : 0 } },
      yAxis: horizontal ? { ...cat, inverse: true } : val,
      series: [{ type: "bar", data: items.map((i) => i.value), barMaxWidth: 36, itemStyle: { borderRadius: 3 } }],
    };
  }
  return (
    <AnalyticsFrame data={data} printable={printable}>
      <Chart option={option} printable={printable} />
      {printable && (
        <>
          <p className="print-chart-note">Полные подписи и значения приведены в таблице под диаграммой.</p>
          <table className="table print-chart-values">
            <colgroup><col style={{ width: "70%" }} /><col style={{ width: "30%" }} /></colgroup>
            <thead><tr><th>Группа</th><th className="num">Значение</th></tr></thead>
            <tbody>{items.map((item) => <tr key={item.key}><td>{item.label}</td><td className="num">{f(item.value)}</td></tr>)}</tbody>
          </table>
        </>
      )}
    </AnalyticsFrame>
  );
}

export function ProjectsWidget({ widget, filters }: Props) {
  const { data: refs } = useRefs();
  const { labels } = useProjectFieldLabels();
  const limit = widget.config.limit ?? 8;
  const q = useQuery({
    queryKey: widgetQueryKey(widget, filters),
    queryFn: () =>
      api<ProjectPage>("/projects", {
        query: { ...filterQuery(filters), open_only: true, sort: "-amount", size: limit },
      }),
  });
  if (!q.data) return <State loading={q.isLoading} error={q.error} />;
  return <ProjectsView data={q.data} labels={labels} refs={refs} />;
}

export type ProjectsViewLabels = Pick<ProjectFieldLabels, "name" | "client_id" | "manager_id" | "amount">;

export function ProjectsView({ data, labels, printable = false, refs }: {
  data: ProjectPage; labels: ProjectsViewLabels; printable?: boolean; refs?: Refs;
}) {
  const router = useRouter();
  return (
    <div className="widget-table" style={printable ? undefined : { height: "100%", overflow: "auto" }}>
      <AnalyticsScopeNote data={data} />
      <table className="table">
        <colgroup><col style={{ width: "22%" }} /><col style={{ width: "26%" }} /><col style={{ width: "12%" }} /><col style={{ width: "15%" }} /><col style={{ width: "13%" }} /><col style={{ width: "12%" }} /></colgroup>
        <thead>
          <tr>
            <th>{labels.client_id}</th>
            <th>{labels.name}</th>
            <th>Этап</th>
            <th>{labels.manager_id}</th>
            <th className="num">{labels.amount}{PROJECT_FIELD_DEFAULTS.amount.suffix}</th>
            <th>Последний месяц выручки</th>
          </tr>
        </thead>
        <tbody>
          {data.items.map((p) => (
            <tr key={p.id} className={printable ? undefined : "clickable"} onClick={printable ? undefined : () => router.push(`/projects/${p.id}`)}>
              <td>{p.client.name}</td>
              <td>{p.name}</td>
              <td>{p.customer_stage?.name ?? refs?.stages.find((s) => s.id === p.stage)?.name ?? "—"}</td>
              <td>{managerName(p.manager, refs)}</td>
              <td className="num">{moneyFull(p.amount).replace(/ ₽$/, "")}</td>
              <td>{p.last_revenue_month ? date(p.last_revenue_month).slice(3) : "—"}</td>
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
    case "profit":
      return <ProfitWidget {...props} />;
    case "failures":
      return <FailuresWidget {...props} />;
  }
}

const signedMoney = (v: number) => (v < 0 ? `−${money(-v)}` : money(v));

export function ProfitWidget({ widget, filters }: Props) {
  const limit = widget.config.limit ?? 8;
  const q = useQuery({
    queryKey: widgetQueryKey(widget, filters),
    queryFn: () => api<ProfitResponse>("/analytics/profit", { query: { ...filterQuery(filters), limit } }),
  });
  if (!q.data) return <State loading={q.isLoading} error={q.error} />;
  return <ProfitView data={q.data} />;
}

/** Прибыль = выручка − затраты по месячным строкам; налоги и НДС не вычитаются. */
export function ProfitView({ data, printable = false }: { data: ProfitResponse; printable?: boolean }) {
  const rows = [...data.groups, data.total];
  return (
    <div className="widget-table" style={printable ? undefined : { height: "100%", overflow: "auto" }}>
      <p className="hint" style={{ margin: "0 0 8px" }}>По финансовым строкам, без пересчёта НДС.</p>
      <table className="table">
        <thead><tr><th>Проекты</th><th className="num">Кол-во</th><th className="num">Выручка</th><th className="num">Затраты</th><th className="num">Прибыль</th><th className="num">Маржа</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} style={r.key === "all" ? { fontWeight: 600 } : undefined}>
              <td>{r.label}</td>
              <td className="num">{count(r.count)}</td>
              <td className="num">{money(r.revenue)}</td>
              <td className="num">{money(r.costs)}</td>
              <td className={`num ${r.profit < 0 ? "negative" : ""}`}>{signedMoney(r.profit)}</td>
              <td className="num">{r.margin_pct === null ? "—" : `${r.margin_pct}%`}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {data.items.length > 0 && (
        <table className="table" style={{ marginTop: 8 }}>
          <thead><tr><th>Проект</th><th>Этап</th><th className="num">Прибыль</th></tr></thead>
          <tbody>
            {data.items.map((p) => (
              <tr key={p.project_id}>
                <td style={{ whiteSpace: "normal" }}>{printable ? p.name : <Link href={`/projects/${p.project_id}`}>{p.name}</Link>}<div className="muted">{p.client}</div></td>
                <td style={{ whiteSpace: "normal" }}>{p.stage}</td>
                <td className={`num ${p.profit < 0 ? "negative" : ""}`}>{signedMoney(p.profit)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function FailuresWidget({ widget, filters }: Props) {
  const limit = widget.config.limit ?? 8;
  const q = useQuery({
    queryKey: widgetQueryKey(widget, filters),
    queryFn: () => api<FailuresResponse>("/analytics/failures", { query: { ...filterQuery(filters), limit } }),
  });
  if (!q.data) return <State loading={q.isLoading} error={q.error} />;
  return <FailuresView data={q.data} />;
}

/** Невыполненные проекты: причины, этапы остановки, сегменты и менеджеры. */
export function FailuresView({ data, printable = false }: { data: FailuresResponse; printable?: boolean }) {
  if (!data.total) return <div className="muted">Невыполненных проектов нет</div>;
  const groups: [string, FailuresResponse["by_stage"]][] = [
    ["Этап остановки", data.by_stage], ["Сегмент", data.by_segment], ["Менеджер", data.by_manager],
  ];
  return (
    <div className="widget-table" style={printable ? undefined : { height: "100%", overflow: "auto" }}>
      <table className="table">
        <thead><tr><th>Статус</th><th className="num">Проектов</th><th className="num">Сумма</th></tr></thead>
        <tbody>
          {data.by_reason.filter((r) => r.count > 0).map((r) => (
            <tr key={r.key}><td>{r.label}</td><td className="num">{count(r.count)}</td><td className="num">{money(r.amount)}</td></tr>
          ))}
          <tr style={{ fontWeight: 600 }}><td>Всего</td><td className="num">{count(data.total)}</td><td /></tr>
        </tbody>
      </table>
      <p className="hint" style={{ margin: "6px 0" }}>«Застрял на этапе»: {data.stall_rule}.</p>
      <div className="failure-groups">
        {groups.map(([title, rows]) => (
          <div key={title}>
            <strong>{title}</strong>
            <ul>{rows.slice(0, 5).map((r) => <li key={r.label}>{r.label}: {count(r.count)}</li>)}</ul>
          </div>
        ))}
      </div>
      <table className="table">
        <thead><tr><th>Проект</th><th>Статус</th><th className="num">Дней на этапе</th><th>Причина</th></tr></thead>
        <tbody>
          {data.items.map((p) => (
            <tr key={p.project_id}>
              <td style={{ whiteSpace: "normal" }}>{printable ? p.name : <Link href={`/projects/${p.project_id}`}>{p.name}</Link>}<div className="muted">{p.stage} · {p.manager}</div></td>
              <td style={{ whiteSpace: "normal" }}>{p.reason_label}</td>
              <td className="num">{p.days_on_stage == null ? "—" : count(p.days_on_stage)}</td>
              <td style={{ whiteSpace: "normal" }}>{p.reason === "stalled" ? data.stall_rule : "Не указана"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
