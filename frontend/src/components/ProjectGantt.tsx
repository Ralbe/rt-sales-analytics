"use client";

import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { date } from "@/lib/format";

interface GanttMonth { year: number; month: number; amount: number }
interface GanttResponse {
  stages: { label: string; start: string; end: string }[];
  revenue: GanttMonth[];
  costs: GanttMonth[];
}

const DAY = 86_400_000;
const thousands = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 3 });
const monthTitle = new Intl.DateTimeFormat("ru-RU", { month: "short", year: "numeric", timeZone: "UTC" });

const ts = (iso: string) => Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
const monthStart = (m: GanttMonth) => Date.UTC(m.year, m.month - 1, 1);
const monthEnd = (m: GanttMonth) => Date.UTC(m.year, m.month, 1);

/** Диаграмма Ганта: этапы по истории изменений и месяцы выручки и затрат на общей шкале времени. */
export function ProjectGantt({ projectId }: { projectId: number }) {
  const query = useQuery({
    queryKey: ["project-gantt", projectId],
    queryFn: () => api<GanttResponse>(`/projects/${projectId}/gantt`),
  });
  const data = query.data;
  if (!data) return query.error ? <p className="hint">Не удалось загрузить диаграмму Ганта.</p> : null;
  if (data.stages.length === 0 && data.revenue.length === 0 && data.costs.length === 0) return null;

  const points = [
    ...data.stages.flatMap((s) => [ts(s.start), ts(s.end) + DAY]),
    ...[...data.revenue, ...data.costs].flatMap((m) => [monthStart(m), monthEnd(m)]),
  ];
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = Math.max(max - min, DAY);
  const place = (from: number, to: number) => ({
    left: `${((from - min) / span) * 100}%`,
    width: `${Math.max(((to - from) / span) * 100, 0.6)}%`,
  });
  const years: number[] = [];
  for (let y = new Date(min).getUTCFullYear(); y <= new Date(max).getUTCFullYear(); y++) years.push(y);

  const monthsRow = (label: string, rows: GanttMonth[], kind: string) => rows.length > 0 && (
    <div className="gantt-row">
      <div className="gantt-label">{label}, тыс. ₽</div>
      <div className="gantt-track">
        {rows.map((m) => (
          <div
            key={`${m.year}-${m.month}`}
            className={`gantt-bar gantt-${kind}`}
            style={place(monthStart(m), monthEnd(m))}
            title={`${monthTitle.format(monthStart(m))}: ${thousands.format(m.amount)} тыс. ₽`}
          />
        ))}
      </div>
    </div>
  );

  return (
    <section className="card gantt" aria-label="Диаграмма Ганта">
      <h2>Диаграмма Ганта</h2>
      <div className="gantt-row gantt-scale">
        <div className="gantt-label" />
        <div className="gantt-track">
          {years.map((y) => {
            const at = Date.UTC(y, 0, 1);
            return at >= min && at <= max
              ? <span key={y} className="gantt-tick" style={{ left: `${((at - min) / span) * 100}%` }}>{y}</span>
              : null;
          })}
        </div>
      </div>
      {data.stages.map((s, i) => (
        <div className="gantt-row" key={`${s.label}-${s.start}-${i}`}>
          <div className="gantt-label">{s.label}</div>
          <div className="gantt-track">
            <div
              className="gantt-bar gantt-stage"
              style={place(ts(s.start), ts(s.end) + DAY)}
              title={`${s.label}: ${date(s.start)} — ${date(s.end)}`}
            />
          </div>
        </div>
      ))}
      {monthsRow("Выручка", data.revenue, "revenue")}
      {monthsRow("Затраты", data.costs, "cost")}
      <p className="hint">Этапы построены по истории изменений карточки. Наведите на отрезок, чтобы увидеть даты и суммы.</p>
    </section>
  );
}
