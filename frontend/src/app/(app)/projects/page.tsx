"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { MultiSelect } from "@/components/MultiSelect";
import { QueryState } from "@/components/QueryState";
import { api, toQuery } from "@/lib/api";
import { date } from "@/lib/format";
import { canEditProjects, seesAllProjects, useDebounced, useMe, useRefs } from "@/lib/hooks";
import { PROJECT_FIELD_DEFAULTS, useProjectFieldLabels, type ProjectFieldKey } from "@/lib/project-field-labels";
import type { ProjectPage, Stage } from "@/lib/types";

const PAGE_SIZE = 20;
const COLUMN_FIELDS: Record<string, ProjectFieldKey> = {
  client: "client_id", service: "service_id", manager: "manager_id", margin: "margin_pct", close: "expected_close_date",
};
const YEARS = Array.from({ length: 301 }, (_, i) => 1900 + i);
const amountFormat = new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fullAmount = (value: string) => `${amountFormat.format(Number(value))} ₽`;
const COLUMNS: { key: string; label: string; sort?: string; num?: boolean; width?: number }[] = [
  { key: "name", label: "Проект", sort: "name", width: 280 },
  { key: "client", label: "Клиент", width: 260 },
  { key: "client_inn", label: "ИНН", sort: "client_inn" },
  { key: "segment", label: "Сегмент" },
  { key: "service", label: "Услуга" },
  { key: "manager", label: "Ответственный" },
  { key: "stage", label: "Стадия" },
  { key: "customer_stage_id", label: "Этап по ТЗ", sort: "customer_stage_id", width: 240 },
  { key: "implementation_year", label: "Год реализации", sort: "implementation_year" },
  { key: "probability", label: "Вероятность, %", num: true },
  { key: "amount", label: "Сумма, ₽", sort: "amount", num: true, width: 210 },
  { key: "cost", label: "Себестоимость, ₽", num: true, width: 210 },
  { key: "margin", label: "Маржа, %", num: true },
  { key: "close", label: "План закрытия", sort: "expected_close_date" },
  { key: "project_status", label: "Статус проекта", width: 280 },
  { key: "realized_work", label: "Сделано за период", width: 320 },
  { key: "period_plan", label: "Планы на период", width: 320 },
];

export default function ProjectsPage() {
  const router = useRouter();
  const { data: me } = useMe();
  const refsQuery = useRefs();
  const { heading, label } = useProjectFieldLabels();
  const filterLabel = (key: ProjectFieldKey, original: string) =>
    label(key) === PROJECT_FIELD_DEFAULTS[key].label ? original : label(key);
  const refs = refsQuery.data;
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
  const q = useDebounced(search.trim());

  const params = {
    q, segment_id: segments, service_id: services, manager_id: managers, stage: stages,
    customer_stage_id: customerStage, implementation_year: implementationYear, sort,
    ...(archived && me?.role === "admin" ? { archived: true } : {}),
    ...(openOnly ? { open_only: true } : {}),
  };
  const projectsQuery = useQuery({
    queryKey: ["projects", params, page],
    queryFn: () => api<ProjectPage>("/projects", { query: { ...params, page, size: PAGE_SIZE } }),
    placeholderData: keepPreviousData,
  });
  const { data, isFetching } = projectsQuery;

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
            <MultiSelect label={filterLabel("segment", "Сегменты")} options={refs.segments} value={segments} onChange={withReset(setSegments)} />
            <MultiSelect label={filterLabel("service_id", "Услуги")} options={refs.services} value={services} onChange={withReset(setServices)} />
            {seesAllProjects(me?.role) && (
              <MultiSelect
                label={filterLabel("manager_id", "Менеджеры")}
                options={refs.managers.map((m) => ({ id: m.id, name: m.full_name }))}
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
              <option value="">{label("customer_stage_id")}: все</option>
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
        <label className="check">
          <input type="checkbox" checked={openOnly} aria-describedby="open-projects-scope" onChange={(event) => withReset(setOpenOnly)(event.target.checked)} />
          Только открытые проекты прежних стадий
        </label>
        <p className="hint" id="open-projects-scope">Фильтр открытых проектов применяется только к прежним шести стадиям. Проекты с новыми этапами не включаются.</p>
        <QueryState query={refsQuery} title="Не удалось загрузить справочники фильтров" loadingText="Загружаем справочники фильтров…" />
        <QueryState query={projectsQuery} title="Не удалось загрузить проекты" loadingText="Загружаем проекты…" />
        <div className="card" style={{ overflow: "auto", opacity: isFetching ? 0.7 : 1 }}>
          <table className="table" style={{ tableLayout: "fixed", minWidth: COLUMNS.reduce((sum, c) => sum + (c.width ?? 160), 0) }}>
            <colgroup>
              {COLUMNS.map((c) => <col key={c.key} style={{ width: c.width ?? 160 }} />)}
            </colgroup>
            <thead>
              <tr>
                {COLUMNS.map((c) => (
                  <th
                    key={c.key}
                    scope="col"
                    data-field={c.key}
                    className={`${c.sort ? "sortable" : ""} ${c.num ? "num" : ""}`}
                    onClick={c.sort ? () => toggleSort(c.sort!) : undefined}
                  >
                    {heading(COLUMN_FIELDS[c.key] ?? c.key as ProjectFieldKey)}
                    {c.sort && sort.replace("-", "") === c.sort ? (sort.startsWith("-") ? " ↓" : " ↑") : ""}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody style={{ verticalAlign: "top", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
              {data?.items.map((p) => (
                <tr key={p.id} className="clickable" onClick={() => router.push(`/projects/${p.id}`)}>
                  <td>{p.name}</td>
                  <td>{p.client.name}</td>
                  <td>{p.client_inn || "—"}</td>
                  <td>{p.segment.name}</td>
                  <td>{p.service.name}</td>
                  <td>{p.manager.full_name}</td>
                  <td>
                    <span
                      className={`badge ${p.stage === "won" ? "won" : p.stage === "lost" ? "lost" : ""}`}
                      style={{ whiteSpace: "normal" }}
                    >
                      {stageName(p.stage)}
                    </span>
                  </td>
                  <td>{p.customer_stage?.name ?? "—"}</td>
                  <td>{p.implementation_year ?? "—"}</td>
                  <td className="num">{p.probability}%</td>
                  <td className="num">{fullAmount(p.amount)}</td>
                  <td className="num">{fullAmount(p.cost)}</td>
                  <td className="num">{p.margin_pct === null ? "—" : `${p.margin_pct}%`}</td>
                  <td>{date(p.expected_close_date)}</td>
                  <td>{p.project_status || "—"}</td>
                  <td>{p.realized_work || "—"}</td>
                  <td>{p.period_plan || "—"}</td>
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
