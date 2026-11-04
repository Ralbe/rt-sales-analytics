"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { EChartsOption } from "echarts";

import { CHANGE_LABELS } from "@/components/ChangeBadges";
import { Chart } from "@/components/Chart";
import { api } from "@/lib/api";
import { chartMoney, count, duration, money } from "@/lib/format";
import type { ChangeIndicator, PeriodChangesResponse, PipelineGroup, PipelineResponse } from "@/lib/types";



interface Props {
  filters: { segment_id: number[]; service_id: number[]; manager_id: number[]; customer_stage_id?: number[]; implementation_year?: number; q?: string; open_only?: boolean; archived?: boolean; stage?: string[] };
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
  const [amount, setAmount] = useState(true);
  const [quantity, setQuantity] = useState(true);
  const [statistics, setStatistics] = useState(["avg_days"]);
  const query = useQuery({
    queryKey: ["analytics", "pipeline", filters],
    queryFn: () => api<PipelineResponse>("/analytics/pipeline", { query: filters }),
  });
  const data = query.data;
  if (query.isLoading) return <p className="muted">Загрузка…</p>;
  if (!data) return query.error ? <p className="hint">Не удалось загрузить показатели воронки.</p> : null;

  if (!data.totals.count) return <p className="muted">Нет проектов на этапах заказчика для выбранных фильтров.</p>;

  const scale = chartMoney(data.by_stage.map((s) => s.amount));
  const stageOption: EChartsOption = {
    grid: { left: 8, right: 16, top: 48, bottom: 44, containLabel: true },
    tooltip: { trigger: "axis" },
    xAxis: [
      { type: "value", name: scale.unit, nameLocation: "middle", nameGap: 28, show: amount, axisLabel: { formatter: scale.format } },
      { type: "value", name: "проектов", nameLocation: "middle", nameGap: 28, show: quantity, minInterval: 1, position: "top" },
    ],
    yAxis: { type: "category", inverse: true, data: data.by_stage.map((s) => s.label) },
    series: [
      ...(amount ? [{ name: "Сумма", type: "bar" as const, data: data.by_stage.map((s) => s.amount), xAxisIndex: 0,
        tooltip: { valueFormatter: (value: unknown) => money(Number(value)) } }] : []),
      ...(quantity ? [{ name: "Количество проектов", type: "bar" as const, data: data.by_stage.map((s) => s.count), xAxisIndex: 1 }] : []),
    ],
  };
  const statLabels = { avg_days: "Среднее", median_days: "Медиана", mode_days: "Мода" };
  const durationOption: EChartsOption = {
    grid: { left: 8, right: 16, top: 24, bottom: 44, containLabel: true },
    tooltip: { trigger: "axis", valueFormatter: (v) => duration(v == null ? null : Number(v)) },
    xAxis: { type: "value", name: "дни", nameLocation: "middle", nameGap: 28 },
    yAxis: { type: "category", inverse: true, data: data.by_stage.map((s) => s.label) },
    series: statistics.filter((key) => key !== "mode_days").map((key) => ({
      name: statLabels[key as keyof typeof statLabels], type: "bar" as const,
      data: data.by_stage.map((s) => key === "avg_days" ? s.avg_days : s.median_days ?? null),
    })),
  };

  return (
    <section aria-label="Показатели воронки">
      <div className="overview-kpis">
        <div className="card"><div className="label">Проектов в воронке</div><div className="kpi"><div className="value">{count(data.totals.count)}</div></div></div>
        <div className="card"><div className="label">Сумма контрактов</div><div className="kpi"><div className="value">{money(data.totals.amount)}</div></div></div>
        <div className="card"><div className="label">С учётом вероятности</div><div className="kpi"><div className="value">{money(data.totals.weighted_amount)}</div></div></div>
        <div className="card">
          <div className="label">Выручка по финансовым строкам</div>
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
          <div className="check-options">
            <label><input type="checkbox" checked={amount} onChange={(e) => setAmount(e.target.checked)} /> Сумма</label>
            <label><input type="checkbox" checked={quantity} onChange={(e) => setQuantity(e.target.checked)} /> Количество проектов</label>
          </div>
          <div className="overview-chart"><Chart option={stageOption} /></div>
        </div>
        <div className="card">
          <h2>Время на этапах</h2>
          <div className="check-options">{Object.entries(statLabels).map(([key, label]) => <label key={key}>
            <input type="checkbox" checked={statistics.includes(key)} onChange={(e) => setStatistics((current) => e.target.checked ? [...current, key] : current.filter((k) => k !== key))} /> {label}
          </label>)}</div>
          <details><summary>Методика</summary><p>Завершённые посещения, без времени в архиве. Среднее арифметическое; медиана — центральное значение; мода — наиболее частое, с точностью до минуты. При равной частоте — несколько мод.</p></details>
          {statistics.some((s) => s !== "mode_days") && <div className="overview-chart"><Chart option={durationOption} /></div>}
          <div className="widget-table"><table className="table"><thead><tr><th>Этап</th><th>Посещений</th>
            {statistics.map((key) => <th key={key}>{statLabels[key as keyof typeof statLabels]}</th>)}
          </tr></thead><tbody>{data.by_stage.map((row) => <tr key={row.key}><td>{row.label}</td><td>{row.visits ?? 0}</td>
            {statistics.map((key) => <td key={key}>{key === "mode_days" ? (row.mode_days?.map(duration).join(", ") || "—") : duration(key === "avg_days" ? row.avg_days : row.median_days)}</td>)}
          </tr>)}</tbody></table></div>
        </div>
        <GroupTable title="По менеджерам" rows={data.by_manager} />
        
        
      </div>
    </section>
  );
}
