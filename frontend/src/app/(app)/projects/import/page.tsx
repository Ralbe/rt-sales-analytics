"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, post, SESSION_EXPIRED_EVENT } from "@/lib/api";
import { useMe } from "@/lib/hooks";
import { QueryState } from "@/components/QueryState";

interface Result { created?: number; skipped?: number; warnings?: string[]; errors?: { row: number; message: string }[] }
interface Preview extends Result {
  id: string; status: string; rows: number; headers: string[]; fields: string[];
  preview: { row: number; client: string; name: string; stage: string }[];
}
interface ImportLog { id: string; filename: string; status: string; created_at: string; result: Result }
const statuses: Record<string, string> = { preview: "Проверен", invalid: "Ошибки в файле", completed: "Загружен", expired: "Срок проверки истёк" };

export default function ProjectImportPage() {
  const { data: me } = useMe();
  const client = useQueryClient();
  const [file, setFile] = useState<File>();
  const [sheet, setSheet] = useState("Список проектов");
  const [header, setHeader] = useState(3);
  const [vat, setVat] = useState(false);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<Preview>();
  const [result, setResult] = useState<Result>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [changed, setChanged] = useState(false);
  const history = useQuery({ queryKey: ["project-imports"], queryFn: () => api<{ items: ImportLog[] }>("/project-imports"), enabled: me?.role === "admin" });
  const check = async () => {
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { setError("Размер файла не должен превышать 10 МБ"); return; }
    setBusy(true); setError(""); setResult(undefined); setPreview(undefined);
    try {
      const params = new URLSearchParams({ filename: file.name, sheet, header_row: String(header), mapping: JSON.stringify(mapping), vat_included: String(vat) });
      const response = await fetch(`/api/project-imports/preview?${params}`, { method: "POST", credentials: "include", body: file });
      if (response.status === 401) window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT));
      const data = await response.json();
      if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : "Не удалось проверить файл");
      setPreview(data); setChanged(false); await history.refetch();
    } catch (e) { setError(e instanceof Error ? e.message : "Ошибка загрузки"); }
    finally { setBusy(false); }
  };
  const commit = async () => {
    if (!preview || changed) return;
    setBusy(true); setError("");
    try {
      setResult(await post<Result>(`/project-imports/${preview.id}/commit`));
      setPreview(undefined); await client.invalidateQueries();
    } catch (e) { setError(e instanceof Error ? e.message : "Не удалось импортировать проекты"); }
    finally { setBusy(false); }
  };
  if (me?.role !== "admin") return <div className="page-body">Импорт доступен администратору.</div>;
  return <><div className="page-header"><h1>Импорт проектов</h1></div><div className="page-body import-page">
    <section className="card"><h2>Файл Excel</h2>
      <p className="muted">XLSX · до 10 МБ · 5000 строк · суммы в тыс. ₽. Совпадения по клиенту и названию пропускаются.</p>
      <div className="form-grid">
        <label className="field">Файл<input type="file" accept=".xlsx" disabled={busy} onChange={(e) => { setFile(e.target.files?.[0]); setPreview(undefined); setMapping({}); setResult(undefined); }} /></label>
        <label className="field">Лист<input className="input" value={sheet} disabled={busy} onChange={(e) => { setSheet(e.target.value); setChanged(true); }} /></label>
        <label className="field">Строка заголовков<input className="input" type="number" min={1} max={30} value={header} disabled={busy} onChange={(e) => { setHeader(Number(e.target.value)); setChanged(true); }} /></label>
        <label className="field">Суммы в файле<select className="select" value={String(vat)} disabled={busy} onChange={(e) => { setVat(e.target.value === "true"); setChanged(true); }}><option value="false">Без НДС</option><option value="true">С НДС</option></select></label>
      </div>
      <button className="btn" disabled={!file || busy} onClick={check}>{busy ? "Обработка…" : "Проверить файл"}</button>
      {error && <p className="alert" role="alert">{error}</p>}
      {preview && <>
        <details><summary>Сопоставить столбцы</summary><div className="form-grid">{preview.fields.map((field) => <label className="field" key={field}>{field === "Столбец1" ? "ИНН" : field}
          <select className="select" value={mapping[field] ?? (preview.headers.includes(field) ? field : "")} disabled={busy} onChange={(e) => { setMapping((m) => ({ ...m, [field]: e.target.value })); setChanged(true); }}>
            <option value="">Не выбран</option>{preview.headers.filter(Boolean).map((name, i) => <option key={i} value={name}>{name}</option>)}
          </select></label>)}</div></details>
        {preview.errors?.length ? <div role="alert"><p>Исправьте ошибки и повторите проверку.</p><ul>{preview.errors.slice(0, 100).map((item, i) => <li key={i}>Строка {item.row}: {item.message}</li>)}</ul></div> : <p>Подготовлено строк: {preview.rows}.</p>}
        <div className="widget-table"><table className="table"><thead><tr><th>Строка</th><th>Клиент</th><th>Проект</th><th>Этап</th></tr></thead>
          <tbody>{preview.preview.map((row) => <tr key={row.row}><td>{row.row}</td><td>{row.client}</td><td>{row.name}</td><td>{row.stage}</td></tr>)}</tbody></table></div>
        {preview.rows > 50 && <p className="muted">Показаны первые 50 строк.</p>}
        <button className="btn primary" disabled={busy || changed || preview.status !== "preview"} onClick={commit}>Импортировать проекты</button>
        {changed && <p role="status">После изменения настроек повторите проверку файла.</p>}
      </>}
      {result && <div role="status"><p>Создано: {result.created}. Пропущено: {result.skipped}.</p>{result.warnings?.map((w, i) => <p key={i}>{w}</p>)}</div>}
    </section>
    <section className="card"><h2>Журнал импорта</h2><QueryState query={history} title="Не удалось загрузить журнал" />
      <div className="widget-table"><table className="table"><thead><tr><th>Дата</th><th>Файл</th><th>Статус</th><th>Результат</th></tr></thead><tbody>{history.data?.items.map((item) => <tr key={item.id}>
        <td>{new Date(item.created_at).toLocaleString("ru-RU")}</td><td>{item.filename}</td><td>{statuses[item.status] ?? item.status}</td><td>{item.status === "completed" ? `Создано: ${item.result.created}, пропущено: ${item.result.skipped}` : `Ошибок: ${item.result.errors?.length ?? 0}`}</td>
      </tr>)}{history.data?.items.length === 0 && <tr><td colSpan={4} className="muted">Загрузок пока нет.</td></tr>}</tbody></table></div>
    </section>
  </div></>;
}
