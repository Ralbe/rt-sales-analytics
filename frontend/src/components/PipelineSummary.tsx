"use client";

import { useQuery } from "@tanstack/react-query";
import type { EChartsOption } from "echarts";

import { CHANGE_LABELS } from "@/components/ChangeBadges";
import { Chart } from "@/components/Chart";
import { api } from "@/lib/api";
import { count, money } from "@/lib/format";
import type { ChangeIndicator, PeriodChangesResponse, PipelineGroup, PipelineResponse } from "@/lib/types";

const days = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 });

interface Props {
  filters: { segment_id: number[]; service_id: number[]; manager_id: number[] };
  changes?: PeriodChangesResponse;
}

function GroupTable({ title, rows }: { title: string; rows: PipelineGroup[] }) {
  return (
    <div className="card">
      <h2>{title}</h2>
      <table className="table">
        <thead>
          <tr>
            <th scope="col">Название</th>
            <th scope="col" className="num">Проектов</th>
            <th scope="col" className="num">Сумма</th>
            <th scope="col" className="num">С учётом вероятности</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td style={{ whiteSpace: "normal" }}>{r.label}</td>
              <td className="num">{count(r.count)}</td>
              <td className="num">{money(r.amount)}</td>
              <td className="num">{money(r.weighted_amount)}</td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={4} className="muted">Нет проектов</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

/** Показатели воронки для стартовой страницы: итоги, этапы, время на этапе и разрезы. */
export function PipelineSummary({ filters, changes }: Props) {
  const query = useQuery({
    queryKey: ["analytics", "pipeline", filters],
    queryFn: () => api<PipelineResponse>("/analytics/pipeline", { query: filters }),
  });
  const data = query.data;
  if (query.isLoading) return <p className="muted">Считаем показатели воронки…</p>;
  if (!data) return query.error ? <p className="hint">Не удалось загрузить показатели воронки.</p> : null;

  const stageOption: EChartsOption = {
    grid: { left: 8, right: 16, top: 28, bottom: 4, containLabel: true },
    legend: { top: 0, right: 0 },
    tooltip: { trigger: "axis", valueFormatter: (v) => money(Number(v)) },
    xAxis: { type: "value", axisLabel: { formatter: (v: number) => money(v) } },
    yAxis: { type: "category", inverse: true, data: data.by_stage.map((s) => `${s.label} (${s.count})`) },
    series: [
      { name: "Сумма", type: "bar", data: data.by_stage.map((s) => s.amount) },
      { name: "С учётом вероятности", type: "bar", data: data.by_stage.map((s) => s.weighted_amount) },
    ],
  };
  const durationOption: EChartsOption = {
    grid: { left: 8, right: 24, top: 8, bottom: 4, containLabel: true },
    tooltip: { trigger: "axis", valueFormatter: (v) => (v === null || v === undefined ? "—" : `${days.format(Number(v))} дн.`) },
    xAxis: { type: "value", name: "дни" },
    yAxis: { type: "category", inverse: true, data: data.by_stage.map((s) => s.label) },
    series: [{ name: "Среднее время на этапе", type: "bar", data: data.by_stage.map((s) => s.avg_days) }],
  };

  return (
    <section aria-label="Показатели воронки">
      <div className="overview-kpis">
        <div className="card"><div className="label">Проектов в воронке</div><div className="kpi"><div className="value">{count(data.totals.count)}</div></div></div>
        <div className="card"><div className="label">Сумма проектов</div><div className="kpi"><div className="value">{money(data.totals.amount)}</div></div></div>
        <div className="card"><div className="label">С учётом вероятности</div><div className="kpi"><div className="value">{money(data.totals.weighted_amount)}</div></div></div>
        <div className="card">
          <div className="label">Выручка по месяцам</div>
          <div className="kpi"><div className="value">{money(data.totals.revenue)}</div></div>
          <div className="muted">с учётом вероятности {money(data.totals.weighted_revenue)}</div>
        </div>
      </div>
      {changes && (
        <div className="change-counts" style={{ marginBottom: 12 }}>
          {(Object.keys(CHANGE_LABELS) as ChangeIndicator[]).map((key) => (
            <span key={key} className={`badge change-${key}`}>{CHANGE_LABELS[key]}: {changes.counts[key] ?? 0}</span>
          ))}
        </div>
      )}
      <div className="overview-grid">
        <div className="card">
          <h2>Проекты по этапам</h2>
          <div className="overview-chart"><Chart option={stageOption} /></div>
        </div>
        <div className="card">
          <h2>Среднее время на этапе</h2>
          <div className="overview-chart"><Chart option={durationOption} /></div>
        </div>
        <GroupTable title="По менеджерам" rows={data.by_manager} />
        <GroupTable title="По сегментам" rows={data.by_segment} />
        <GroupTable title="По услугам" rows={data.by_service} />
      </div>
    </section>
  );
}
