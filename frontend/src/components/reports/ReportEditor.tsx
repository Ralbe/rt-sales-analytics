"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { serializeFilters } from "@/lib/report-filter";
import { ApiError } from "@/lib/api";
import { QuotaAction } from "./QuotaAction";
import { QueryState } from "@/components/QueryState";
import { useMe } from "@/lib/hooks";
import { emptyDefinition, reportError, reports, type Grain, type Report, type ReportDefinition, type ReportField } from "@/lib/report-api";
import { SnapshotViewer } from "./SnapshotViewer";

const opNames: Record<string, string> = { eq: "Равно", ne: "Не равно", contains: "Содержит", gt: "Больше", gte: "Не меньше", lt: "Меньше", lte: "Не больше", in: "В списке", is_null: "Не заполнено" };

export function ReportEditor({ id }: { id?: string }) {
  const { data: me } = useMe();
  const allowed = me?.role === "admin" || me?.role === "analyst";
  const fields = useQuery({ queryKey: ["report-fields"], queryFn: reports.fields, enabled: allowed, retry: false });
  const report = useQuery({ queryKey: ["report", id], queryFn: () => reports.get(id!), enabled: allowed && !!id, retry: false, staleTime: 0, refetchOnMount: "always" });
  if (!allowed) return <div className="page-body"><div role="alert">Конструктор доступен аналитикам и администраторам.</div></div>;
  const checking = !!id && (report.isFetching || report.isPaused || !!report.error || !report.data);
  const ownerDenied = !!report.data && !checking && me?.role !== "admin" && report.data.owner_id !== me?.id;
  return <>
    {(!fields.data || checking) && <div className="page-body"><QueryState query={fields} title="Не удалось загрузить поля отчёта" />{id && checking && <QueryState query={{ ...report, data: undefined }} title="Не удалось загрузить отчёт" loadingText="Проверяем доступ к отчёту…" />}</div>}
    {ownerDenied && <div className="page-body"><div role="alert">Редактировать отчёт может его владелец или администратор.</div><Link href={`/reports/${id}`}>Открыть отчёт</Link></div>}
    {fields.data && (!id || report.data) && <EditorForm key={id ?? "new"} fields={fields.data.fields} report={report.data} visible={!checking && !ownerDenied} />}
  </>;
}

function EditorForm({ fields, report, visible }: { fields: ReportField[]; report?: Report; visible: boolean }) {
  const router = useRouter();
  const [title, setTitle] = useState(report?.title ?? "");
  const [baseVersion] = useState(report?.version);
  const [definition, setDefinition] = useState<ReportDefinition>(report?.definition ?? emptyDefinition());
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [quota, setQuota] = useState(false);
  const [previewOutdated, setPreviewOutdated] = useState(false);
  const [preview, setPreview] = useState<string>();
  const [notice, setNotice] = useState("");
  const available = fields.filter((field) => field.grains.includes(definition.grain));
  const byId = (id: string) => fields.find((f) => f.id === id);
  const label = (id: string) => byId(id)?.label ?? `${id} (поле недоступно)`;
  const patch = (change: Partial<ReportDefinition>) => { setDefinition((d) => ({ ...d, ...change })); setPreviewOutdated(true); };
  const changeGrain = (grain: Grain) => {
    const allowed = new Set(fields.filter((f) => f.grains.includes(grain)).map((f) => f.id));
    const next = { grain, columns: definition.columns.filter((id) => allowed.has(id)), filters: definition.filters.filter((f) => allowed.has(f.field)), sort: definition.sort.filter((s) => allowed.has(s.field)) };
    if (next.columns.length !== definition.columns.length || next.filters.length !== definition.filters.length || next.sort.length !== definition.sort.length) setNotice("Несовместимые поля удалены из колонок, фильтров и сортировки."); else setNotice("");
    patch(next);
  };
  const valid = () => {
    if (!definition.columns.length) { setError("Выберите хотя бы одну колонку."); return false; }
    return true;
  };
  const run = async (action: "save" | "preview") => {
    setError(""); setQuota(false);
    if (!valid()) return;
    let serialized: ReportDefinition;
    try { serialized = serializeFilters(definition, fields); } catch (e) { setError(e instanceof Error ? e.message : "Проверьте фильтры."); return; }
    if (action === "save" && !title.trim()) { setError("Введите название отчёта."); return; }
    setBusy(true);
    try {
      if (action === "preview") { if (preview) { try { await reports.release(preview); } catch (e) { if (!(e instanceof ApiError && e.status === 404)) throw e; } setPreview(undefined); } const snapshot = await reports.preview(serialized); setPreview(snapshot.snapshot_id); setPreviewOutdated(false); }
      else { const saved = report ? await reports.update(String(report.id), title.trim(), serialized, baseVersion!) : await reports.create(title.trim(), serialized); router.push(`/reports/${saved.id}`); }
    } catch (e) { setQuota(e instanceof ApiError && e.status === 429); setError(reportError(e)); } finally { setBusy(false); }
  };
  const move = (index: number, direction: number) => { const columns = [...definition.columns]; const target = index + direction; [columns[index], columns[target]] = [columns[target], columns[index]]; patch({ columns }); };
  const setFilter = (i: number, changes: Partial<ReportDefinition["filters"][number]>) => patch({ filters: definition.filters.map((f, n) => n === i ? { ...f, ...changes } : f) });
  if (!visible) return null;
  return <>
    <div className="page-header"><h1>{report ? "Редактирование отчёта" : "Новый табличный отчёт"}</h1></div>
    <div className="page-body report-builder">
      <div className="card report-section">
        <label className="field">Название отчёта<input className="input" value={title} onChange={(e) => setTitle(e.target.value)} /></label>
        <label className="field">Строки отчёта<select className="select" value={definition.grain} onChange={(e) => changeGrain(e.target.value as Grain)}><option value="project">Проекты</option><option value="financial_entry">Финансовые записи</option></select></label>
        <p className="muted">Одна строка — проект или существующая финансовая запись. Суммы и НДС отображаются без дополнительных расчётов.</p>
        {notice && <p role="status">{notice}</p>}
      </div>
      <section className="card report-section"><h2>Колонки и порядок</h2>
        <p className="muted">Выберите поля и установите порядок кнопками.</p>
        <div className="report-field-list">{available.map((f) => <label key={f.id}><input type="checkbox" checked={definition.columns.includes(f.id)} onChange={(e) => patch({ columns: e.target.checked ? [...definition.columns, f.id] : definition.columns.filter((id) => id !== f.id) })} /> {f.label}</label>)}</div>
        {!available.length && <p>Для выбранного режима нет доступных полей.</p>}
        <ol className="report-order">{definition.columns.map((id, i) => <li key={id}><span>{label(id)}</span><button className="btn small" type="button" disabled={i === 0} aria-label={`Переместить ${label(id)} выше`} onClick={() => move(i, -1)}>↑</button><button className="btn small" type="button" disabled={i === definition.columns.length - 1} aria-label={`Переместить ${label(id)} ниже`} onClick={() => move(i, 1)}>↓</button></li>)}</ol>
      </section>
      <section className="card report-section"><h2>Фильтры</h2><p className="muted">Все условия применяются одновременно.</p>
        {definition.filters.map((filter, i) => { const field = byId(filter.field); return <div className="report-rule" key={i}>
          <label className="field">Поле фильтра {i + 1}<select className="select" value={filter.field} onChange={(e) => { const f = byId(e.target.value); setFilter(i, { field: e.target.value, operator: f?.operators[0] ?? "", value: null }); }}>{available.filter((f) => f.operators.length).map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}</select></label>
          <label className="field">Оператор {i + 1}<select className="select" value={filter.operator} onChange={(e) => setFilter(i, { operator: e.target.value, value: null })}>{field?.operators.map((op) => <option key={op} value={op}>{opNames[op] ?? op}</option>)}</select></label>
          <label className="field">Значение {i + 1}{(filter.operator === "is_null" || field?.type === "boolean") ? <select className="select" value={String(filter.value ?? "")} onChange={(e) => setFilter(i, { value: e.target.value === "" ? null : e.target.value === "true" })}><option value="">Выберите</option><option value="true">Да</option><option value="false">Нет</option></select> : (field?.choices || ["project.stage", "project.stage_scheme", "financial.kind"].includes(field?.id ?? "")) ? <select className="select" value={String(filter.value ?? "")} onChange={(e) => setFilter(i, { value: e.target.value || null })}><option value="">Выберите</option>{field?.choices?.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}</select> : <input className="input" type={field?.type === "date" ? "date" : "text"} inputMode={field?.type === "integer" ? "numeric" : field?.type === "decimal" ? "decimal" : undefined} placeholder={field?.type === "datetime" ? "2026-10-28T12:30:00+03:00" : undefined} value={String(filter.value ?? "")} disabled={filter.value === "" && field?.type === "string"} onChange={(e) => setFilter(i, { value: e.target.value || null })} />}</label>
          {field?.type === "string" && !field.choices && !["project.stage", "project.stage_scheme", "financial.kind"].includes(field.id) && ["eq", "ne", "contains"].includes(filter.operator) && <label><input type="checkbox" checked={filter.value === ""} onChange={(e) => setFilter(i, { value: e.target.checked ? "" : null })} /> Искать пустую строку {i + 1}</label>}
          <button className="btn" type="button" aria-label={`Удалить фильтр ${i + 1}`} onClick={() => patch({ filters: definition.filters.filter((_, n) => n !== i) })}>Удалить</button>
        </div>; })}
        <button className="btn" type="button" disabled={!available.some((f) => f.operators.length)} onClick={() => { const f = available.find((item) => item.operators.length); if (f) patch({ filters: [...definition.filters, { field: f.id, operator: f.operators[0], value: null }] }); }}>Добавить фильтр</button>
      </section>
      <section className="card report-section"><h2>Сортировка</h2>
        {definition.sort.map((sort, i) => <div className="report-rule" key={i}><label className="field">Поле сортировки {i + 1}<select className="select" value={sort.field} onChange={(e) => patch({ sort: definition.sort.map((s, n) => n === i ? { ...s, field: e.target.value } : s) })}>{available.filter((f) => f.sortable).map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}</select></label><label className="field">Направление {i + 1}<select className="select" value={sort.direction} onChange={(e) => patch({ sort: definition.sort.map((s, n) => n === i ? { ...s, direction: e.target.value as "asc" | "desc" } : s) })}><option value="asc">По возрастанию</option><option value="desc">По убыванию</option></select></label><button className="btn" type="button" aria-label={`Удалить сортировку ${i + 1}`} onClick={() => patch({ sort: definition.sort.filter((_, n) => n !== i) })}>Удалить</button></div>)}
        <button className="btn" type="button" disabled={!available.some((f) => f.sortable)} onClick={() => { const f = available.find((item) => item.sortable); if (f) patch({ sort: [...definition.sort, { field: f.id, direction: "asc" }] }); }}>Добавить сортировку</button>
      </section>
      {error && <div className="alert" role="alert">{error}</div>}
      {quota && <QuotaAction onReleased={() => { setQuota(false); setError(""); setPreview(undefined); }} />}
      <div className="report-actions"><button className="btn" type="button" disabled={busy} onClick={() => run("preview")}>Предпросмотр</button><button className="btn primary" type="button" disabled={busy} onClick={() => run("save")}>{busy ? "Подождите…" : "Сохранить отчёт"}</button>{report && <Link className="btn" href={`/reports/${report.id}`}>К отчёту</Link>}</div>
      {preview && <section className="card report-section"><h2>Предпросмотр</h2>{previewOutdated && <p>Настройки изменились после создания этого снимка.</p>}<SnapshotViewer id={preview} /><button className="btn" disabled={busy} onClick={async () => { setBusy(true); try { await reports.release(preview); setPreview(undefined); } catch (e) { setError(reportError(e)); } finally { setBusy(false); } }}>Удалить снимок предпросмотра</button></section>}
    </div>
  </>;
}
