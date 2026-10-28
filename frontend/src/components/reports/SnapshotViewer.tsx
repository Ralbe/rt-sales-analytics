"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { QueryState } from "@/components/QueryState";
import { downloadSnapshot, reportError, reports, type SnapshotPage } from "@/lib/report-api";

function cell(value: unknown): string { return value === null || value === undefined ? "—" : typeof value === "boolean" ? (value ? "Да" : "Нет") : String(value); }
function ReportTable({ page, rows }: { page: SnapshotPage; rows: Record<string, unknown>[] }) {
  return <table className="report-table"><thead><tr>{page.columns.map((c) => <th key={c.id} scope="col">{c.label}</th>)}</tr></thead><tbody>{rows.map((row, i) => <tr key={i}>{page.columns.map((c) => <td key={c.id}>{cell(row[c.id])}</td>)}</tr>)}</tbody></table>;
}
export function SnapshotViewer({ id }: { id: string }) {
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [printData, setPrintData] = useState<{ page: SnapshotPage; rows: Record<string, unknown>[] }>();
  const query = useQuery({ queryKey: ["report-snapshot", id, offset], queryFn: () => reports.page(id, offset), retry: false, staleTime: 0, refetchOnMount: "always" });
  const page = !query.isFetching && !query.error && !query.isPaused ? query.data : undefined;
  useEffect(() => { setOffset(0); setPrintData(undefined); }, [id]);
  useEffect(() => {
    if (!printData) return;
    const timer = window.setTimeout(() => window.print(), 100);
    return () => window.clearTimeout(timer);
  }, [printData]);
  useEffect(() => { const after = () => setPrintData(undefined); window.addEventListener("afterprint", after); return () => window.removeEventListener("afterprint", after); }, []);
  const download = async () => { setError(""); setBusy(true); try { await downloadSnapshot(id); } catch (e) { setError(reportError(e)); } finally { setBusy(false); } };
  const print = async () => {
    setError(""); setBusy(true); setPrintData(undefined);
    try {
      const first = await reports.page(id, 0, 200);
      if (first.total > 10000 || first.total < 0) throw new Error("Некорректный размер снимка");
      const rows: Record<string, unknown>[] = [];
      const expectedColumns = JSON.stringify(first.columns);
      for (let position = 0; position < first.total; position += 200) {
        const part = position === 0 ? first : await reports.page(id, position, 200);
        if (part.snapshot_id !== id || part.total !== first.total || part.title !== first.title || part.offset !== position || JSON.stringify(part.columns) !== expectedColumns || part.rows.length !== Math.min(200, first.total - position)) throw new Error("Снимок получен не полностью");
        rows.push(...part.rows);
      }
      setPrintData({ page: first, rows });
    } catch (e) { setError(e instanceof Error && !("status" in e) ? "Не удалось получить все строки снимка. Печать отменена; повторите попытку." : reportError(e)); }
    finally { setBusy(false); }
  };
  return <div className="report-snapshot">
    <QueryState query={{ ...query, data: page }} title="Не удалось загрузить снимок" loadingText="Проверяем доступ к снимку…" />
    {query.error && <p>Снимок может быть недоступен или срок его действия истёк. Запустите отчёт снова.</p>}
    {page && !query.error && <>
      <h2>{page.title || "Предпросмотр отчёта"}</h2>
      <p role="status">Всего строк: {page.total}. Снимок доступен до {new Date(page.expires_at).toLocaleString("ru-RU")}.</p>
      <div className="report-actions"><button className="btn" disabled={busy} onClick={download}>Скачать XLSX</button><button className="btn" disabled={busy} onClick={print}>{busy ? "Подготовка…" : "PDF / Печать всех строк"}</button></div>
      {error && <div role="alert" className="alert">{error}</div>}
      {page.total === 0 ? <p>По выбранным условиям ничего не найдено.</p> : <><div className="report-table-scroll"><ReportTable page={page} rows={page.rows} /></div><div className="report-actions"><button className="btn" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 100))}>Предыдущая страница</button><span>Строки {offset + 1}–{offset + page.rows.length} из {page.total}</span><button className="btn" disabled={offset + page.rows.length >= page.total} onClick={() => setOffset(offset + 100)}>Следующая страница</button></div></>}
    </>}
    {printData && createPortal(<div className="report-print-surface"><h1>{printData.page.title || "Предпросмотр отчёта"}</h1><p>Всего строк: {printData.page.total}</p>{printData.rows.length ? (printData.page.columns.length <= 6 ? <ReportTable page={printData.page} rows={printData.rows} /> : <div className="report-print-records">{printData.rows.map((row, i) => <section key={i}><h2>Строка {i + 1}</h2><dl>{printData.page.columns.map((column) => <div key={column.id}><dt>{column.label}</dt><dd>{cell(row[column.id])}</dd></div>)}</dl></section>)}</div>) : <p>По выбранным условиям ничего не найдено.</p>}</div>, document.body)}
  </div>;
}
