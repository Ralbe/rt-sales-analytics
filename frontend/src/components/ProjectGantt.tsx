"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { duration } from "@/lib/format";

interface GanttMonth { year: number; month: number; amount: number; vat_included?: boolean; status?: string }
interface GanttResponse {
  stages: { label: string; start: string; end: string; duration_days?: number; known_start?: boolean }[];
  revenue: GanttMonth[];
  costs: GanttMonth[];
}
type Scale = "day" | "month" | "quarter" | "year";
const scales: Record<Scale, string> = { day: "Дни", month: "Месяцы", quarter: "Кварталы", year: "Годы" };
const timestamp = (value: string) => new Date(value).toLocaleString("ru-RU");
const amount = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 3 });

function floor(value: number, scale: Scale): Date {
  const d = new Date(value);
  d.setHours(0, 0, 0, 0);
  if (scale !== "day") d.setDate(1);
  if (scale === "year") d.setMonth(0);
  if (scale === "quarter") d.setMonth(Math.floor(d.getMonth() / 3) * 3);
  return d;
}

function next(value: Date, scale: Scale): Date {
  const d = new Date(value);
  if (scale === "day") d.setDate(d.getDate() + 1);
  else d.setMonth(d.getMonth() + (scale === "year" ? 12 : scale === "quarter" ? 3 : 1));
  return d;
}

export function ProjectGantt({ projectId }: { projectId: number }) {
  const [scale, setScale] = useState<Scale>("month");
  const query = useQuery({ queryKey: ["project-gantt", projectId], queryFn: () => api<GanttResponse>(`/projects/${projectId}/gantt`) });
  if (query.isLoading) return <p role="status">Загрузка диаграммы…</p>;
  if (!query.data) return <p role="alert">Не удалось загрузить диаграмму Ганта. <button className="btn small" onClick={() => void query.refetch()}>Повторить</button></p>;
  const { stages, revenue, costs } = query.data;
  const rows = [
    ...stages.map((s) => ({ label: s.label, start: Date.parse(s.start), end: Date.parse(s.end), kind: "stage",
      value: `${s.known_start === false ? "не менее " : ""}${duration(s.duration_days ?? (Date.parse(s.end) - Date.parse(s.start)) / 86400000)}`,
      title: `${timestamp(s.start)} — ${timestamp(s.end)}` })),
    ...([revenue, costs] as const).flatMap((entries, index) => entries.map((entry) => ({
      label: `${index ? "Затраты" : "Выручка"} · ${String(entry.month).padStart(2, "0")}.${entry.year}`,
      start: new Date(entry.year, entry.month - 1, 1).getTime(), end: new Date(entry.year, entry.month, 1).getTime(),
      kind: index ? "cost" : "revenue", value: `${amount.format(entry.amount)} тыс. ₽`,
      title: [entry.vat_included === undefined ? "" : entry.vat_included ? "С НДС" : "Без НДС", entry.status].filter(Boolean).join(" · "),
    }))),
  ];
  if (!rows.length) return <section className="card gantt" aria-label="Диаграмма Ганта"><h2>Диаграмма Ганта</h2><p className="muted">Нет истории этапов и финансовых строк.</p></section>;
  const min = floor(Math.min(...rows.map((r) => r.start)), scale).getTime();
  const end = Math.max(...rows.map((r) => r.end));
  const ticks: { start: number; end: number; label: string }[] = [];
  for (let at = new Date(min); (at.getTime() < end || !ticks.length) && ticks.length < 401; at = next(at, scale)) {
    const after = next(at, scale);
    const label = scale === "quarter" ? `${Math.floor(at.getMonth() / 3) + 1} кв. ${at.getFullYear()}`
      : scale === "year" ? `${at.getFullYear()}`
      : at.toLocaleDateString("ru-RU", scale === "day" ? { day: "2-digit", month: "2-digit" } : { month: "2-digit", year: "numeric" });
    ticks.push({ start: at.getTime(), end: after.getTime(), label });
  }
  const max = ticks[ticks.length - 1].end;
  const left = (value: number) => `${(value - min) / (max - min) * 100}%`;
  const width = (from: number, to: number) => `${Math.max(0, to - from) / (max - min) * 100}%`;
  const lines = ticks.map((tick) => <span key={tick.start} className="gantt-gridline" style={{ left: left(tick.start) }} />);
  return <section className="card gantt" aria-label="Диаграмма Ганта">
    <div className="gantt-toolbar"><h2>Диаграмма Ганта</h2>
      <label>Масштаб <select className="select" value={scale} onChange={(e) => setScale(e.target.value as Scale)}>
        {Object.entries(scales).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </select></label>
    </div>
    {ticks.length > 400 ? <p role="status">Для этого периода выберите более крупный масштаб.</p> : <div className="gantt-scroll">
      <div style={{ minWidth: Math.max(760, ticks.length * 64 + 300) }}>
        <div className="gantt-row gantt-scale"><div className="gantt-label">Этап / финансовый период</div><div className="gantt-track">
          {ticks.map((tick) => <span key={tick.start} className="gantt-period" style={{ left: left(tick.start), width: width(tick.start, tick.end) }}>{tick.label}</span>)}
        </div></div>
        {rows.map((row, index) => <div className="gantt-row" key={index}>
          <div className="gantt-label"><span>{row.label}</span><small>{row.value}{row.kind !== "stage" && row.title ? ` · ${row.title}` : ""}</small></div>
          <div className="gantt-track">{lines}<div className={`gantt-bar gantt-${row.kind}${row.end === row.start ? " gantt-point" : ""}`}
            style={{ left: left(row.start), width: width(row.start, row.end) }} title={`${row.label}: ${row.value}. ${row.title}`} /></div>
        </div>)}
      </div>
    </div>}
    {!!stages.length && <details><summary>Даты этапов</summary><table className="table"><thead><tr><th>Этап</th><th>Начало</th><th>Конец</th><th>Длительность</th></tr></thead>
      <tbody>{stages.map((s, i) => <tr key={i}><td>{s.label}</td><td>{s.known_start === false ? `Неизвестно; наблюдается с ${timestamp(s.start)}` : timestamp(s.start)}</td><td>{timestamp(s.end)}</td><td>{s.known_start === false ? "не менее " : ""}{duration(s.duration_days)}</td></tr>)}</tbody>
    </table></details>}
  </section>;
}
