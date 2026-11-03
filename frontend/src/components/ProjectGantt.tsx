"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";

import { SESSION_EXPIRED_EVENT, api } from "@/lib/api";
import { duration, localTimestamp as timestamp, projectInstant } from "@/lib/project-time";
import { ganttAxis, type GanttScale as Scale } from "@/lib/gantt-axis";
import type { ProjectTimeline, StageStatistic } from "@/lib/timeline-types";

import "./ProjectGantt.css";

const DAY = 86_400_000;
const monthName = (year: number, month: number) => `${String(month).padStart(2, "0")}.${year}`;
const integerFormat = new Intl.NumberFormat("ru-RU");
const amount = (value: string) => {
  if (!/^-?\d+(\.\d+)?$/.test(value)) return "—";
  const [integer, fraction = ""] = value.replace(/^-/, "").split(".");
  return `${value.startsWith("-") ? "-" : ""}${integerFormat.format(BigInt(integer))},${fraction.padEnd(3, "0")}`;
};
const kindLabel = (kind: "revenue" | "cost") => kind === "revenue" ? "Выручка" : "Затраты";

export function StageDurationTable({ rows }: { rows: StageStatistic[] }) {
  return <div className="gantt-table-scroll"><table className="table gantt-table">
    <caption title="По периодам с известным началом, завершённым переходом на другой этап">Средняя длительность этапов</caption>
    <thead><tr><th scope="col">Этап</th><th scope="col">Завершённых периодов</th><th scope="col">Средняя длительность</th></tr></thead>
    <tbody>{rows.map((row) => <tr key={row.stage_key}>
      <th scope="row">{row.stage_label}</th><td>{row.completed_visits}</td><td>{row.average_days === null ? "Нет завершённых периодов" : duration(row.average_days)}</td>
    </tr>)}</tbody>
  </table></div>;
}

function TimelineContent({ data, scale, printed = false }: { data: ProjectTimeline; scale: Scale; printed?: boolean }) {
  const financial = data.finances.map((row) => ({
    ...row, start: new Date(row.year, row.month - 1, 1).valueOf(), end: new Date(row.year, row.month, 1).valueOf(),
  }));
  const ranges = [
    ...data.intervals.map((row) => [projectInstant(row.started_at).valueOf(), projectInstant(row.ended_at).valueOf()]),
    ...financial.map((row) => [row.start, row.end]),
    ...data.archived_periods.map((row) => [projectInstant(row.started_at).valueOf(), projectInstant(row.ended_at).valueOf()]),
  ];
  const first = ranges.length ? Math.min(...ranges.map((range) => range[0])) : projectInstant(data.generated_at).valueOf();
  const last = ranges.length ? Math.max(...ranges.map((range) => range[1])) : first + DAY;
  const axis = ganttAxis(first, last, scale, printed);
  const { start, end, ticks } = axis;
  const width = printed ? "100%" : `${axis.width}px`;
  const left = (date: number) => `${Math.max(0, Math.min(100, (date - start) / (end - start) * 100))}%`;
  const bar = (a: number, b: number) => ({ left: left(a), width: `${Math.max(0, (b - a) / (end - start) * 100)}%` });
  const grid = <div className="gantt-grid" aria-hidden="true">{ticks.slice(1).map((tick) => <span key={tick.at} style={{ left: left(tick.at) }} />)}</div>;
  const now = projectInstant(data.generated_at).valueOf();

  return <>
    <p className="muted">Данные на {timestamp(data.generated_at)}</p>
    {!data.history_complete && <p className="alert info">История неполная</p>}
    {ranges.length === 0 ? <p>Нет данных для диаграммы.</p> : <>
      <p className="gantt-legend"><span>■ Этап</span><span className="gantt-revenue-text">■ Выручка</span><span className="gantt-cost-text">■ Затраты</span><span>▧ Архив</span></p>
      <div className="gantt-scroll" tabIndex={0} role="region" aria-label="Временная шкала этапов, выручки и затрат">
        <div className="gantt-canvas" style={{ width }}>
          <div className="gantt-axis"><span>Этап / период</span><div className="gantt-track">
            {ticks.map((tick) => <span key={tick.at} className="gantt-tick" style={bar(tick.at, tick.end)}>{tick.label}</span>)}
          </div></div>
          {data.intervals.map((row, index) => <div className="gantt-row" key={`stage-${index}`}>
            <span className="gantt-row-label">{row.stage_label}{row.is_current ? " · текущий" : ""}{!row.start_known ? " · начало неизвестно" : ""}</span>
            <div className="gantt-track">
              {data.archived_periods.map((period, i) => <span key={i} className="gantt-archive-background" style={bar(projectInstant(period.started_at).valueOf(), projectInstant(period.ended_at).valueOf())} />)}
              {grid}
              <span className="gantt-bar" style={bar(projectInstant(row.started_at).valueOf(), projectInstant(row.ended_at).valueOf())}
                title={`${row.stage_label}: ${timestamp(row.started_at)} — ${timestamp(row.ended_at)}; ${duration(row.duration_days)}${row.start_known ? "" : " (известная часть)"}`} />
              {now >= start && now <= end && <span className="gantt-now" style={{ left: left(now) }} title="Момент формирования" />}
            </div>
          </div>)}
          {financial.map((row) => <div className="gantt-row" key={`finance-${row.id}`}>
            <span className="gantt-row-label">{kindLabel(row.kind)} · {monthName(row.year, row.month)} · {amount(row.amount)} тыс. ₽ · {row.vat_included ? "с НДС" : "без НДС"} · {row.status}</span>
            <div className="gantt-track">{grid}<span className={`gantt-bar gantt-${row.kind}`} style={bar(row.start, row.end)} title={`${kindLabel(row.kind)}: ${amount(row.amount)} тыс. ₽ · ${row.status}`} /></div>
          </div>)}
          {data.archived_periods.map((row, index) => <div className="gantt-row" key={`archive-${index}`}>
            <span className="gantt-row-label">Архив · {timestamp(row.started_at)} — {timestamp(row.ended_at)}</span>
            <div className="gantt-track">{grid}<span className="gantt-bar gantt-archive" style={bar(projectInstant(row.started_at).valueOf(), projectInstant(row.ended_at).valueOf())} /></div>
          </div>)}
        </div>
      </div>
    </>}
    <div className="gantt-table-scroll"><table className="table gantt-table">
      <caption>Этапы проекта</caption>
      <thead><tr><th scope="col">Этап</th><th scope="col">Начало</th><th scope="col">Конец</th><th scope="col">Длительность</th><th scope="col">Состояние</th></tr></thead>
      <tbody>{data.intervals.map((row, index) => <tr key={index}>
        <th scope="row">{row.stage_label}</th>
        <td>{row.start_known ? timestamp(row.started_at) : `Неизвестно; наблюдается с ${timestamp(row.started_at)}`}</td>
        <td title={row.is_current ? `Расчёт на ${timestamp(row.ended_at)}` : undefined}>{row.is_current ? "Продолжается" : timestamp(row.ended_at)}</td><td>{duration(row.duration_days)}{!row.start_known && " (известная часть)"}</td>
        <td>{row.is_current ? "Текущий этап" : ({ stage_change: "Переход на другой этап", archive: "Архивирование", current: "Текущий этап", unknown: "Разрыв истории" })[row.end_reason]}</td>
      </tr>)}</tbody>
    </table></div>
    {data.intervals.length === 0 && <p className="muted">История переходов отсутствует.</p>}
    {data.stage_statistics.length > 0 && <StageDurationTable rows={data.stage_statistics} />}
    <div className="gantt-table-scroll"><table className="table gantt-table">
      <caption>Выручка и затраты</caption>
      <thead><tr><th scope="col">Тип</th><th scope="col">Месяц</th><th scope="col">Сумма, тыс. ₽</th><th scope="col">НДС</th><th scope="col">Статус</th></tr></thead>
      <tbody>{data.finances.map((row) => <tr key={row.id}>
        <th scope="row">{kindLabel(row.kind)}</th><td>{monthName(row.year, row.month)}</td><td>{amount(row.amount)}</td><td>{row.vat_included ? "С НДС" : "Без НДС"}</td><td>{row.status}</td>
      </tr>)}</tbody>
    </table></div>
    {data.finances.length === 0 && <p className="muted">Финансовые строки не заполнены.</p>}
  </>;
}

export function ProjectGantt({ projectId, projectName }: { projectId: number; projectName: string }) {
  const [open, setOpen] = useState(false);
  const [scale, setScale] = useState<Scale>("month");
  const [printData, setPrintData] = useState<ProjectTimeline | null>(null);
  const [printing, setPrinting] = useState(false);
  const [printError, setPrintError] = useState("");
  const printGeneration = useRef(0);
  const query = useQuery({
    queryKey: ["project-timeline", projectId], enabled: open,
    queryFn: () => api<ProjectTimeline>(`/projects/${projectId}/timeline`), retry: false,
  });

  useEffect(() => {
    const invalidate = () => { printGeneration.current++; };
    const clear = () => { invalidate(); setPrintData(null); setPrinting(false); };
    clear();
    window.addEventListener("afterprint", clear);
    window.addEventListener(SESSION_EXPIRED_EVENT, clear);
    return () => { invalidate(); window.removeEventListener("afterprint", clear); window.removeEventListener(SESSION_EXPIRED_EVENT, clear); };
  }, [projectId]);

  useEffect(() => {
    if (!printData) return;
    const frame = requestAnimationFrame(() => {
      try { window.print(); } catch { setPrintError("Не удалось открыть печать. Повторите попытку."); setPrintData(null); }
      setPrinting(false);
    });
    return () => cancelAnimationFrame(frame);
  }, [printData]);

  async function print() {
    const generation = ++printGeneration.current;
    setPrinting(true); setPrintError(""); setPrintData(null);
    try {
      // The endpoint rechecks access and returns all saved rows in one snapshot.
      const fresh = await api<ProjectTimeline>(`/projects/${projectId}/timeline`);
      if (generation !== printGeneration.current) return;
      setPrintData(fresh);
    } catch {
      if (generation !== printGeneration.current) return;
      setPrintError("Печать недоступна: не удалось проверить данные и доступ к проекту."); setPrinting(false);
    }
  }

  return <section className="card project-gantt" aria-labelledby="project-gantt-title">
    <div className="gantt-toolbar"><h2 id="project-gantt-title">Диаграмма Ганта</h2>
      <button type="button" className="btn small" aria-expanded={open} aria-controls="project-gantt-body" onClick={() => setOpen(!open)}>{open ? "Скрыть диаграмму Ганта" : "Показать диаграмму Ганта"}</button>
    </div>
    {open && <div id="project-gantt-body">
      <div className="gantt-toolbar">
        <label htmlFor="gantt-scale">Масштаб</label><select id="gantt-scale" className="select" value={scale} onChange={(event) => setScale(event.target.value as Scale)}>
          <option value="day">Дни</option><option value="month">Месяцы</option><option value="quarter">Кварталы</option><option value="year">Годы</option>
        </select>
        <button type="button" className="btn small" disabled={query.isFetching} onClick={() => void query.refetch()}>Обновить Гант</button>
        <button type="button" className="btn small" disabled={!query.data || query.isFetching || !!query.error || printing} onClick={() => void print()}>{printing ? "Подготовка Ганта…" : "PDF / Печать Ганта"}</button>
      </div>
      {printError && <p role="alert" className="alert">{printError}</p>}
      {query.isLoading && <p role="status">Загрузка диаграммы…</p>}
      {query.error && <p role="alert" className="alert">Не удалось загрузить диаграмму. Нажмите «Обновить Гант», чтобы повторить.</p>}
      {!query.error && query.data && <TimelineContent data={query.data} scale={scale} />}
    </div>}
    {printData && createPortal(<article className="gantt-print-surface" data-gantt-print>
      <h1>Диаграмма Ганта · {projectName}</h1><p>Проект № {projectId}</p>
      <TimelineContent data={printData} scale="year" printed />
    </article>, document.body)}
  </section>;
}
