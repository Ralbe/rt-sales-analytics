"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { MultiSelect } from "@/components/MultiSelect";
import { api, toQuery } from "@/lib/api";
import { date, money } from "@/lib/format";
import { canEditProjects, seesAllProjects, useDebounced, useMe, useRefs } from "@/lib/hooks";
import type { ProjectPage, Stage } from "@/lib/types";

const PAGE_SIZE = 20;
const COLUMNS: { key: string; label: string; sort?: string; num?: boolean }[] = [
  { key: "name", label: "Проект", sort: "name" },
  { key: "client", label: "Клиент" },
  { key: "segment", label: "Сегмент" },
  { key: "service", label: "Услуга" },
  { key: "manager", label: "Ответственный" },
  { key: "stage", label: "Стадия" },
  { key: "amount", label: "Сумма", sort: "amount", num: true },
  { key: "margin", label: "Маржа", num: true },
  { key: "close", label: "План закрытия", sort: "expected_close_date" },
];

export default function ProjectsPage() {
  const router = useRouter();
  const { data: me } = useMe();
  const { data: refs } = useRefs();
  const [search, setSearch] = useState("");
  const [segments, setSegments] = useState<number[]>([]);
  const [services, setServices] = useState<number[]>([]);
  const [managers, setManagers] = useState<number[]>([]);
  const [stages, setStages] = useState<Stage[]>([]);
  const [sort, setSort] = useState("-updated_at");
  const [page, setPage] = useState(1);
  const q = useDebounced(search.trim());

  const params = { q, segment_id: segments, service_id: services, manager_id: managers, stage: stages, sort };
  const { data, isFetching } = useQuery({
    queryKey: ["projects", params, page],
    queryFn: () => api<ProjectPage>("/projects", { query: { ...params, page, size: PAGE_SIZE } }),
    placeholderData: keepPreviousData,
  });

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
            <MultiSelect label="Сегменты" options={refs.segments} value={segments} onChange={withReset(setSegments)} />
            <MultiSelect label="Услуги" options={refs.services} value={services} onChange={withReset(setServices)} />
            {seesAllProjects(me?.role) && (
              <MultiSelect
                label="Менеджеры"
                options={refs.managers.map((m) => ({ id: m.id, name: m.full_name }))}
                value={managers}
                onChange={withReset(setManagers)}
              />
            )}
            <MultiSelect label="Стадии" options={refs.stages} value={stages} onChange={withReset(setStages)} />
          </div>
        )}
        <div className="spacer" />
        <a className="btn small" href={`/api/projects/export.xlsx${toQuery(params)}`}>
          Выгрузить в Excel
        </a>
        {canEditProjects(me?.role) && (
          <Link className="btn small primary" href="/projects/new">
            + Новый проект
          </Link>
        )}
      </div>

      <div className="page-body">
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
                    {c.label}
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
              {data && data.items.length === 0 && (
                <tr>
                  <td colSpan={COLUMNS.length} className="muted" style={{ textAlign: "center", padding: 24 }}>
                    Ничего не найдено
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="pager">
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
        </div>
      </div>
    </>
  );
}
