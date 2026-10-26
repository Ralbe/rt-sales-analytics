"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { MultiSelect } from "@/components/MultiSelect";
import { QueryState } from "@/components/QueryState";
import { api, toQuery } from "@/lib/api";
import { date, money } from "@/lib/format";
import { canEditProjects, seesAllProjects, useDebounced, useMe, useRefs } from "@/lib/hooks";
import { useProjectFieldLabels, type ProjectFieldKey } from "@/lib/project-field-labels";
import type { ProjectPage, Stage } from "@/lib/types";

const PAGE_SIZE = 20;
const COLUMNS: { key: string; labelKey: ProjectFieldKey; sort?: string; num?: boolean }[] = [
  { key: "name", labelKey: "name", sort: "name" },
  { key: "client", labelKey: "client_id" },
  { key: "segment", labelKey: "segment" },
  { key: "service", labelKey: "service_id" },
  { key: "manager", labelKey: "manager_id" },
  { key: "stage", labelKey: "stage" },
  { key: "amount", labelKey: "amount", sort: "amount", num: true },
  { key: "margin", labelKey: "margin_pct", num: true },
  { key: "close", labelKey: "expected_close_date", sort: "expected_close_date" },
];

export default function ProjectsPage() {
  const router = useRouter();
  const { data: me } = useMe();
  const refsQuery = useRefs();
  const { label } = useProjectFieldLabels();
  const refs = refsQuery.data;
  const [search, setSearch] = useState("");
  const [segments, setSegments] = useState<number[]>([]);
  const [services, setServices] = useState<number[]>([]);
  const [managers, setManagers] = useState<number[]>([]);
  const [stages, setStages] = useState<Stage[]>([]);
  const [sort, setSort] = useState("-updated_at");
  const [page, setPage] = useState(1);
  const [archived, setArchived] = useState(false);
  const q = useDebounced(search.trim());

  const params = { q, segment_id: segments, service_id: services, manager_id: managers, stage: stages, sort,
    ...(archived && me?.role === "admin" ? { archived: true } : {}) };
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
  const toggleSort = (field: string) => setSort((s) => (s === `-${field}` ? field : `-${field}`));
  const stageName = (id: Stage) => refs?.stages.find((s) => s.id === id)?.name ?? id;
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
            <MultiSelect label={label("segment")} options={refs.segments} value={segments} onChange={withReset(setSegments)} />
            <MultiSelect label={label("service_id")} options={refs.services} value={services} onChange={withReset(setServices)} />
            {seesAllProjects(me?.role) && (
              <MultiSelect
                label={label("manager_id")}
                options={refs.managers.map((m) => ({ id: m.id, name: m.full_name }))}
                value={managers}
                onChange={withReset(setManagers)}
              />
            )}
            <MultiSelect label={label("stage")} options={refs.stages} value={stages} onChange={withReset(setStages)} />
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
        <QueryState query={refsQuery} title="Не удалось загрузить справочники фильтров" loadingText="Загружаем справочники фильтров…" />
        <QueryState query={projectsQuery} title="Не удалось загрузить проекты" loadingText="Загружаем проекты…" />
        <div className="card" style={{ overflow: "auto", opacity: isFetching ? 0.7 : 1 }}>
          <table className="table">
            <thead>
              <tr>
                {COLUMNS.map((c) => (
                  <th
                    key={c.key}
                    className={`${c.sort ? "sortable" : ""} ${c.num ? "num" : ""}`}
                    onClick={c.sort ? () => toggleSort(c.sort!) : undefined}
                  >
                    {label(c.labelKey)}
                    {c.sort && sort.replace("-", "") === c.sort ? (sort.startsWith("-") ? " ↓" : " ↑") : ""}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data?.items.map((p) => (
                <tr key={p.id} className="clickable" onClick={() => router.push(`/projects/${p.id}`)}>
                  <td>{p.name}</td>
                  <td>{p.client.name}</td>
                  <td>{p.segment.name}</td>
                  <td>{p.service.name}</td>
                  <td>{p.manager.full_name}</td>
                  <td>
                    <span className={`badge ${p.stage === "won" ? "won" : p.stage === "lost" ? "lost" : ""}`}>
                      {stageName(p.stage)}
                    </span>
                  </td>
                  <td className="num">{money(p.amount)}</td>
                  <td className="num">{p.margin_pct === null ? "—" : `${p.margin_pct}%`}</td>
                  <td>{date(p.expected_close_date)}</td>
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
