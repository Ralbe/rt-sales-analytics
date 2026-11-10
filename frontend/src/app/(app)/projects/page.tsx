"use client";

import { ProjectPrint } from "@/components/ProjectPrint";
import type { Project } from "@/lib/types";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { ChangeBadges } from "@/components/ChangeBadges";
import { ClampedTextCell, FullTextDialog, type ExpandedCellState } from "@/components/ClampedTextCell";
import { MultiSelect } from "@/components/MultiSelect";
import { PipelineSummary } from "@/components/PipelineSummary";
import { QueryState } from "@/components/QueryState";
import { api, toQuery } from "@/lib/api";
import { date } from "@/lib/format";
import { calendarPeriod, isPeriodDate, periodError, type PeriodPreset } from "@/lib/event-period";
import { canEditProjects, seesAllProjects, useDebounced, useMe, useRefs } from "@/lib/hooks";
import { PROJECT_FIELD_DEFAULTS, useProjectFieldLabels, type ProjectFieldKey } from "@/lib/project-field-labels";
import { managerName, managerFilterOptions, segmentFilterOptions, serviceFilterOptions } from "@/lib/reference-options";
import type { PeriodChangesResponse, ProjectPage, Stage } from "@/lib/types";

const PAGE_SIZE = 20;
const COLUMN_FIELDS: Record<string, ProjectFieldKey> = {
  client: "client_id", service: "service_id", manager: "manager_id", margin: "margin_pct", close: "expected_close_date",
};
const YEARS = Array.from({ length: 301 }, (_, i) => 1900 + i);
const amountFormat = new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fullAmount = (value: string) => `${amountFormat.format(Number(value))} ₽`;
const creationFormat = new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short", timeZone: "UTC" });

function creationInPeriod(value: string, from: string, to: string): Date | null {
  if (!from || !to || from > to) return null;
  const timestamp = new Date(/[zZ]$|[+-]\d{2}:?\d{2}$/.test(value) ? value : `${value}Z`);
  if (Number.isNaN(timestamp.getTime())) return null;
  const day = timestamp.toISOString().slice(0, 10);
  return day >= from && day <= to ? timestamp : null;
}

function CreationMarker({ value, from, to }: { value: string; from: string; to: string }) {
  const created = creationInPeriod(value, from, to);
  return created ? (
    <div><time className="badge" dateTime={created.toISOString()} style={{ whiteSpace: "normal" }}>
      Создан за период: {creationFormat.format(created)} UTC
    </time></div>
  ) : null;
}

const COLUMNS: {
  key: string;
  label: string;
  sort?: string;
  num?: boolean;
  minWidth?: number;
  maxWidth?: number;
}[] = [
  { key: "name", label: "Проект", sort: "name", minWidth: 220, maxWidth: 280 },
  { key: "client", label: "Клиент", minWidth: 200, maxWidth: 260 },
  { key: "client_inn", label: "ИНН", sort: "client_inn", minWidth: 130 },
  { key: "segment", label: "Сегмент", minWidth: 140 },
  { key: "service", label: "Услуга", minWidth: 150 },
  { key: "manager", label: "Ответственный", minWidth: 150 },
  { key: "stage", label: "Стадия", minWidth: 140 },
  { key: "customer_stage_id", label: "Этап по ТЗ", sort: "customer_stage_id", minWidth: 180, maxWidth: 240 },
  { key: "implementation_year", label: "Год реализации", sort: "implementation_year", minWidth: 130 },
  { key: "probability", label: "Вероятность, %", num: true, minWidth: 120 },
  { key: "amount", label: "Сумма, ₽", sort: "amount", num: true, minWidth: 170 },
  { key: "weighted_amount", label: "С учётом вероятности, ₽", num: true, minWidth: 190 },
  { key: "cost", label: "Себестоимость, ₽", num: true, minWidth: 170 },
  { key: "margin", label: "Маржа, %", num: true, minWidth: 110 },
  { key: "close", label: "План закрытия", sort: "expected_close_date", minWidth: 130 },
  { key: "project_status", label: "Статус проекта", minWidth: 220, maxWidth: 280 },
  { key: "realized_work", label: "Сделано за период", minWidth: 240, maxWidth: 320 },
  { key: "period_plan", label: "Планы на период", minWidth: 240, maxWidth: 320 },
  { key: "profit", label: "Прибыль, ₽", num: true, minWidth: 150 },
  { key: "project_sheet", label: "Лист проекта", minWidth: 150 },
];

const COL_STYLE = Object.fromEntries(
  COLUMNS.map((c) => [
    c.key,
    {
      minWidth: c.minWidth ?? 140,
      ...(c.maxWidth ? { maxWidth: c.maxWidth } : {}),
    },
  ]),
);

export default function ProjectsPage() {
  const router = useRouter();
  const { data: me } = useMe();
  const refsQuery = useRefs();
  const { heading, label } = useProjectFieldLabels();
  const filterLabel = (key: ProjectFieldKey, original: string) =>
    label(key) === PROJECT_FIELD_DEFAULTS[key].label ? original : label(key);
  const refs = refsQuery.data;
  const [printProject, setPrintProject] = useState<Project>();
  const [expandedCell, setExpandedCell] = useState<ExpandedCellState | null>(null);
  const [search, setSearch] = useState("");
  const [segments, setSegments] = useState<number[]>([]);
  const [services, setServices] = useState<number[]>([]);
  const [managers, setManagers] = useState<number[]>([]);
  const [stages, setStages] = useState<Stage[]>([]);
  const [customerStage, setCustomerStage] = useState<number | undefined>();
  const [implementationYear, setImplementationYear] = useState<number | undefined>();
  const [sort, setSort] = useState("-updated_at");
  const [page, setPage] = useState(1);
  const [archived, setArchived] = useState(false);
  const [openOnly, setOpenOnly] = useState(false);
  const [createdFrom, setCreatedFrom] = useState("");
  const [createdTo, setCreatedTo] = useState("");
  const [periodPreset, setPeriodPreset] = useState<PeriodPreset | "">("");
  const [urlPeriodError, setUrlPeriodError] = useState(false);
  const q = useDebounced(search.trim());

  useEffect(() => {
    const url = new URL(window.location.href);
    const from = url.searchParams.get("date_from") ?? "";
    const to = url.searchParams.get("date_to") ?? "";
    const preset = url.searchParams.get("period_preset");
    if ((!from || isPeriodDate(from)) && (!to || isPeriodDate(to))) {
      setCreatedFrom(from);
      setCreatedTo(to);
      let selected: PeriodPreset | "" = from || to ? "custom" : "";
      if (preset === "week" || preset === "month" || preset === "quarter") {
        const [start, end] = calendarPeriod(preset, new Date());
        if (from === start && to === end) selected = preset;
      }
      setPeriodPreset(selected);
      if (selected === "custom" && preset && preset !== "custom") {
        url.searchParams.set("period_preset", "custom");
        window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
      }
    } else {
      setUrlPeriodError(true);
    }
  }, []);

  const updatePeriod = (from: string, to: string, preset: PeriodPreset | "") => {
    setUrlPeriodError(false);
    setCreatedFrom(from);
    setCreatedTo(to);
    setPeriodPreset(preset);
    const url = new URL(window.location.href);
    for (const [key, value] of Object.entries({ date_from: from, date_to: to, period_preset: preset })) {
      if (value) url.searchParams.set(key, value);
      else url.searchParams.delete(key);
    }
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  };
  const selectPeriod = (preset: PeriodPreset | "") => {
    if (!preset) return updatePeriod("", "", "");
    if (preset === "custom") return updatePeriod(createdFrom, createdTo, preset);
    const [from, to] = calendarPeriod(preset, new Date());
    updatePeriod(from, to, preset);
  };
  const error = urlPeriodError ? "Некорректные даты периода в ссылке." : periodError(createdFrom, createdTo);
  const periodParams = createdFrom && createdTo && !error
    ? { date_from: createdFrom, date_to: createdTo, period_preset: periodPreset || "custom" }
    : {};

  const params = {
    q, segment_id: segments, service_id: services, manager_id: managers, stage: stages,
    customer_stage_id: customerStage, implementation_year: implementationYear, sort, ...periodParams,
    ...(archived && me?.role === "admin" ? { archived: true } : {}),
    ...(openOnly ? { open_only: true } : {}),
  };
  const projectsQuery = useQuery({
    queryKey: ["projects", params, page],
    queryFn: () => api<ProjectPage>("/projects", { query: { ...params, page, size: PAGE_SIZE } }),
    placeholderData: keepPreviousData,
  });
  const { data, isFetching } = projectsQuery;
  const pipelineFilters = { segment_id: segments, service_id: services, manager_id: managers,
    customer_stage_id: customerStage ? [Number(customerStage)] : [], implementation_year: implementationYear || undefined,
    q, archived, open_only: openOnly, stage: stages };
  const changesQuery = useQuery({
    queryKey: ["analytics", "changes", pipelineFilters, createdFrom, createdTo],
    queryFn: () => api<PeriodChangesResponse>("/analytics/changes", {
      query: { ...pipelineFilters, date_from: createdFrom, date_to: createdTo },
    }),
    enabled: Boolean(createdFrom && createdTo && !error),
  });
  const changes = useMemo(
    () => new Map(changesQuery.data?.items.map((item) => [item.project_id, item.indicators] as const)),
    [changesQuery.data],
  );

  const withReset =
    <T,>(setter: (v: T) => void) =>
    (v: T) => {
      setter(v);
      setPage(1);
    };
  const toggleSort = (field: string) => {
    setSort((s) => (s === `-${field}` ? field : `-${field}`));
    setPage(1);
  };
  const stageName = (id: Stage | null) => id === null ? "Не применяется" : refs?.stages.find((s) => s.id === id)?.name ?? id;
  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;
  const columnHeading = (colKey: string, fallback: string) =>
    (COLUMN_FIELDS[colKey] ?? colKey) in PROJECT_FIELD_DEFAULTS
      ? heading((COLUMN_FIELDS[colKey] ?? colKey) as ProjectFieldKey)
      : fallback;

  useEffect(() => {
    if (!expandedCell || !data) return;
    const currentProject = data.items.find((item) => item.id === expandedCell.projectId);
    if (!currentProject) {
      setExpandedCell(null);
      return;
    }
    const latestValue =
      expandedCell.fieldKey === "name"
        ? currentProject.name
        : expandedCell.fieldKey === "client"
          ? currentProject.client.name
          : expandedCell.fieldKey === "project_status"
            ? (currentProject.project_status ?? "")
            : expandedCell.fieldKey === "realized_work"
              ? currentProject.realized_work
              : expandedCell.fieldKey === "period_plan"
                ? currentProject.period_plan
                : "";
    if (!latestValue) {
      setExpandedCell(null);
    } else if (latestValue !== expandedCell.text || currentProject.name !== expandedCell.projectName) {
      setExpandedCell((prev) =>
        prev ? { ...prev, text: latestValue, projectName: currentProject.name } : null,
      );
    }
  }, [data, expandedCell]);

  return (
    <>
      <div className="page-header">
        <h1>Проекты</h1>
        {me?.role === "admin" && (
          <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input type="checkbox" checked={archived} onChange={(event) => { setArchived(event.target.checked); setPage(1); }} />
            Архив проектов
          </label>
        )}
        <input
          className="input"
          style={{ maxWidth: 300 }}
          placeholder="Поиск: проект, клиент или ИНН"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
        />
        {refs && (
          <div className="filters">
            <MultiSelect label={filterLabel("segment", "Сегменты")} options={segmentFilterOptions(refs)} value={segments} onChange={withReset(setSegments)} />
            <MultiSelect label={filterLabel("service_id", "Услуги")} options={serviceFilterOptions(refs)} value={services} onChange={withReset(setServices)} />
            {seesAllProjects(me?.role) && (
              <MultiSelect
                label={filterLabel("manager_id", "Менеджеры")}
                options={managerFilterOptions(refs, managers)}
                value={managers}
                onChange={withReset(setManagers)}
              />
            )}
            <MultiSelect label={filterLabel("stage", "Стадии")} options={refs.stages} value={stages} onChange={withReset(setStages)} />
            <select
              className="input"
              aria-label={label("customer_stage_id")}
              style={{ width: "auto", maxWidth: 280 }}
              value={customerStage ?? ""}
              onChange={(e) => withReset(setCustomerStage)(e.target.value ? Number(e.target.value) : undefined)}
            >
              <option value="">Этапы: все</option>
              {refs.customer_stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <select
              className="input"
              aria-label={label("implementation_year")}
              style={{ width: "auto" }}
              value={implementationYear ?? ""}
              onChange={(e) => withReset(setImplementationYear)(e.target.value ? Number(e.target.value) : undefined)}
            >
              <option value="">{label("implementation_year")}: все</option>
              {YEARS.map((year) => <option key={year} value={year}>{year}</option>)}
            </select>
          </div>
        )}
        <div className="spacer" />
        {seesAllProjects(me?.role) && (
          <a className="btn small" href={`/api/projects/export.xlsx${toQuery(params)}`}>
            Выгрузить в Excel
          </a>
        )}
        {canEditProjects(me?.role) && (
          <Link className="btn small primary" href="/projects/new">
            + Новый проект
          </Link>
        )}
      </div>

      <div className="page-body">
        <details className="overview" open>
          <summary>Воронка по этапам заказчика</summary>
          <PipelineSummary filters={pipelineFilters} changes={createdFrom && createdTo && !error ? changesQuery.data : undefined} />
        </details>
        <fieldset className="period-picker" style={{ border: 0, padding: 0, margin: "0 0 12px" }}>
          <legend>Период создания</legend>
          <div className="filters">
            <label>Период событий <select className="input" aria-label="Период событий" value={periodPreset} onChange={(event) => selectPeriod(event.target.value as PeriodPreset | "")}>
              <option value="">Не выбран</option><option value="week">Неделя</option><option value="month">Месяц</option><option value="quarter">Квартал</option><option value="custom">Произвольный период</option>
            </select></label>
            <label>С <input className="input" type="date" aria-label="Начало периода создания (UTC)" value={createdFrom} onChange={(event) => updatePeriod(event.target.value, createdTo, "custom")} /></label>
            <label>По <input className="input" type="date" aria-label="Конец периода создания (UTC)" value={createdTo} onChange={(event) => updatePeriod(createdFrom, event.target.value, "custom")} /></label>
            <button type="button" className="btn small" disabled={!createdFrom && !createdTo && !periodPreset && !urlPeriodError} onClick={() => updatePeriod("", "", "")}>Сбросить период</button>
          </div>
          {error && <p className="error" role="alert">{error}</p>}
          {changesQuery.error && <p className="hint">Не удалось загрузить индикаторы изменений за период.</p>}
        </fieldset>
        <label className="check">
          <input type="checkbox" checked={openOnly} onChange={(event) => withReset(setOpenOnly)(event.target.checked)} />
          Только открытые проекты
        </label>
        <QueryState query={refsQuery} title="Не удалось загрузить справочники фильтров" loadingText="Загружаем справочники фильтров…" />
        {printProject && <div className="card project-sheet-preview"><div className="gantt-toolbar"><h2>{printProject.name}</h2><button className="btn" onClick={() => setPrintProject(undefined)}>Закрыть лист</button></div><ProjectPrint key={printProject.id} project={printProject} /></div>}
        <QueryState query={projectsQuery} title="Не удалось загрузить проекты" loadingText="Загружаем проекты…" />
        <div className="card" style={{ overflow: "auto", opacity: isFetching ? 0.7 : 1 }}>
          <table className="table projects-table">
            <thead>
              <tr>
                {COLUMNS.map((c) => (
                  <th
                    key={c.key}
                    scope="col"
                    data-field={c.key}
                    style={COL_STYLE[c.key]}
                    className={`${c.sort ? "sortable" : ""} ${c.num ? "num" : ""}`}
                    onClick={c.sort ? () => toggleSort(c.sort!) : undefined}
                  >
                    {columnHeading(c.key, c.label)}
                    {c.sort && sort.replace("-", "") === c.sort ? (sort.startsWith("-") ? " ↓" : " ↑") : ""}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody style={{ verticalAlign: "top", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
              {data?.items.map((p) => (
                <tr key={p.id} className="clickable" onClick={() => router.push(`/projects/${p.id}`)}>
                  <td style={COL_STYLE.name}>
                    <ClampedTextCell
                      text={p.name}
                      projectId={p.id}
                      projectName={p.name}
                      fieldKey="name"
                      fieldLabel={columnHeading("name", "Проект")}
                      onExpand={setExpandedCell}
                    >
                      <CreationMarker value={p.created_at} from={error ? "" : createdFrom} to={createdTo} />
                      <ChangeBadges indicators={changes.get(p.id)?.filter((key) => key !== "new")} />
                    </ClampedTextCell>
                  </td>
                  <td style={COL_STYLE.client}>
                    <ClampedTextCell
                      text={p.client.name}
                      projectId={p.id}
                      projectName={p.name}
                      fieldKey="client"
                      fieldLabel={columnHeading("client", "Клиент")}
                      onExpand={setExpandedCell}
                    />
                  </td>
                  <td style={COL_STYLE.client_inn}>{p.client_inn || "—"}</td>
                  <td style={COL_STYLE.segment}>{p.segment.name}</td>
                  <td style={COL_STYLE.service}>{p.service.name}</td>
                  <td style={COL_STYLE.manager}>{managerName(p.manager, refs)}</td>
                  <td style={COL_STYLE.stage}>
                    <span
                      className={`badge ${p.stage === "won" ? "won" : p.stage === "lost" ? "lost" : ""}`}
                      style={{ whiteSpace: "normal" }}
                    >
                      {stageName(p.stage)}
                    </span>
                  </td>
                  <td style={COL_STYLE.customer_stage_id}>{p.customer_stage?.name ?? "—"}</td>
                  <td style={COL_STYLE.implementation_year}>{p.implementation_year ?? "—"}</td>
                  <td style={COL_STYLE.probability} className="num">{p.probability}%</td>
                  <td style={COL_STYLE.amount} className="num">{fullAmount(p.amount)}</td>
                  <td style={COL_STYLE.weighted_amount} className="num">{fullAmount(String(Number(p.amount) * p.probability / 100))}</td>
                  <td style={COL_STYLE.cost} className="num">{fullAmount(p.cost)}</td>
                  <td style={COL_STYLE.margin} className="num">{p.margin_pct === null ? "—" : `${p.margin_pct}%`}</td>
                  <td style={COL_STYLE.close}>{date(p.expected_close_date)}</td>
                  <td style={COL_STYLE.project_status}>
                    <ClampedTextCell
                      text={p.project_status}
                      projectId={p.id}
                      projectName={p.name}
                      fieldKey="project_status"
                      fieldLabel={columnHeading("project_status", "Статус проекта")}
                      onExpand={setExpandedCell}
                    />
                  </td>
                  <td style={COL_STYLE.realized_work}>
                    <ClampedTextCell
                      text={p.realized_work}
                      projectId={p.id}
                      projectName={p.name}
                      fieldKey="realized_work"
                      fieldLabel={columnHeading("realized_work", "Сделано за период")}
                      onExpand={setExpandedCell}
                    />
                  </td>
                  <td style={COL_STYLE.period_plan}>
                    <ClampedTextCell
                      text={p.period_plan}
                      projectId={p.id}
                      projectName={p.name}
                      fieldKey="period_plan"
                      fieldLabel={columnHeading("period_plan", "Планы на период")}
                      onExpand={setExpandedCell}
                    />
                  </td>
                  <td style={COL_STYLE.profit} className="num">{fullAmount(p.profit ?? "0")}</td>
                  <td style={COL_STYLE.project_sheet}><button className="btn small" onClick={(e) => { e.stopPropagation(); setPrintProject(p); }}>Лист проекта</button></td>
                </tr>
              ))}
              {!projectsQuery.error && data && data.items.length === 0 && (
                <tr>
                  <td colSpan={COLUMNS.length} className="muted" style={{ textAlign: "center", padding: 24 }}>
                    Ничего не найдено
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {expandedCell && (
          <FullTextDialog state={expandedCell} onClose={() => setExpandedCell(null)} />
        )}
        {data && <div className="pager">
          <span className="muted">Всего: {data?.total ?? "…"}</span>
          <button className="btn small" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            ←
          </button>
          <span>
            {page} / {pages}
          </span>
          <button className="btn small" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
            →
          </button>
        </div>}
      </div>
    </>
  );
}
