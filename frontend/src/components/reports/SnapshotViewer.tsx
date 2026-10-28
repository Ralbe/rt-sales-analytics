"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { QueryState } from "@/components/QueryState";
import { useMe } from "@/lib/hooks";
import { downloadSnapshot, reportError, reports, type SnapshotPage } from "@/lib/report-api";
import { SESSION_EXPIRED_EVENT } from "@/lib/api";

function cell(value: unknown): string { return value === null || value === undefined ? "—" : typeof value === "boolean" ? (value ? "Да" : "Нет") : String(value); }
const operators: Record<string, string> = { eq: "равно", ne: "не равно", contains: "содержит", lt: "меньше", lte: "не больше", gt: "больше", gte: "не меньше" };
function filterText(filter: NonNullable<SnapshotPage["metadata"]>["filters"][number]) {
  if (filter.operator === "is_null") return `${filter.label}: ${filter.value ? "не заполнено" : "заполнено"}`;
  const value = filter.value_label === "" ? "пустая строка" : cell(filter.value_label);
  return `${filter.label}: ${operators[filter.operator] ?? filter.operator} «${value}»`;
}
function ReportTable({ page, rows }: { page: SnapshotPage; rows: Record<string, unknown>[] }) {
  return <table className="report-table"><thead><tr>{page.columns.map((c) => <th key={c.id} scope="col">{c.label}</th>)}</tr></thead><tbody>{rows.map((row, i) => <tr key={i}>{page.columns.map((c) => <td key={c.id}>{cell(row[c.id])}</td>)}</tr>)}</tbody></table>;
}
export function SnapshotViewer({ id }: { id: string }) {
  const { data: me } = useMe();
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [printData, setPrintData] = useState<{ page: SnapshotPage; rows: Record<string, unknown>[]; printedAt: string }>();
  const generation = useRef(0);
  const surface = useRef<HTMLDivElement>(null);
  const printAuthorized = useRef(false);
  const query = useQuery({ queryKey: ["report-snapshot", id, offset], queryFn: () => reports.page(id, offset), retry: false, staleTime: 0, refetchOnMount: "always" });
  const page = !query.isFetching && !query.error && !query.isPaused ? query.data : undefined;
  useEffect(() => {
    if (query.error) { generation.current++; printAuthorized.current = false; surface.current?.setAttribute("data-ready", "false"); setPrintData(undefined); setBusy(false); }
  }, [query.error]);
  useEffect(() => { const active = generation; setOffset(0); setPrintData(undefined); active.current++; return () => { active.current++; }; }, [id]);
  useEffect(() => {
    const expire = () => { generation.current++; printAuthorized.current = false; surface.current?.setAttribute("data-ready", "false"); setPrintData(undefined); setBusy(false); };
    const before = () => { if (!printAuthorized.current) surface.current?.setAttribute("data-ready", "false"); };
    window.addEventListener(SESSION_EXPIRED_EVENT, expire);
    window.addEventListener("beforeprint", before);
    return () => { window.removeEventListener(SESSION_EXPIRED_EVENT, expire); window.removeEventListener("beforeprint", before); };
  }, []);
  useEffect(() => {
    if (!printData) return;
    const request = generation.current;
    let cancelled = false;
    void (async () => {
      try {
        const check = await reports.page(id, 0, 1);
        if (cancelled || request !== generation.current) return;
        if (check.snapshot_id !== id || check.offset !== 0 || check.total !== printData.page.total ||
            check.title !== printData.page.title || JSON.stringify(check.columns) !== JSON.stringify(printData.page.columns) ||
            JSON.stringify(check.metadata) !== JSON.stringify(printData.page.metadata) ||
            JSON.stringify(check.rows) !== JSON.stringify(printData.rows.slice(0, 1))) throw new Error("Снимок изменился");
        if (!surface.current) return;
        const printTime = surface.current.querySelector("[data-print-time]");
        if (printTime) printTime.textContent = `Дата печати: ${new Date().toLocaleString("ru-RU", { timeZoneName: "short" })}`;
        surface.current.setAttribute("data-ready", "true");
        printAuthorized.current = true;
        try { window.print(); } catch { throw new Error("Браузер не смог открыть печать. Проверьте его настройки и повторите попытку."); }
        finally { printAuthorized.current = false; }
      } catch (e) {
        if (!cancelled && request === generation.current) {
          surface.current?.setAttribute("data-ready", "false");
          setPrintData(undefined);
          setError(e instanceof Error && !("status" in e) ? e.message : reportError(e));
        }
      } finally { if (!cancelled && request === generation.current) setBusy(false); }
    })();
    return () => { cancelled = true; };
  }, [id, printData]);
  useEffect(() => { const after = () => { setPrintData(undefined); setBusy(false); }; window.addEventListener("afterprint", after); return () => window.removeEventListener("afterprint", after); }, []);
  const download = async () => { setError(""); setBusy(true); try { await downloadSnapshot(id); } catch (e) { setError(reportError(e)); } finally { setBusy(false); } };
  const print = async () => {
    setError(""); setBusy(true); setPrintData(undefined);
    const request = ++generation.current;
    let prepared = false;
    try {
      const first = await reports.page(id, 0, 200);
      if (first.snapshot_id !== id || first.offset !== 0 || first.total > 10000 || first.total < 0 || first.rows.length !== Math.min(200, first.total)) throw new Error("Некорректный размер снимка");
      const rows: Record<string, unknown>[] = [];
      const expectedColumns = JSON.stringify(first.columns);
      for (let position = 0; position < first.total; position += 200) {
        const part = position === 0 ? first : await reports.page(id, position, 200);
        if (request !== generation.current || part.snapshot_id !== id || part.total !== first.total || part.title !== first.title || part.offset !== position || JSON.stringify(part.columns) !== expectedColumns || JSON.stringify(part.metadata) !== JSON.stringify(first.metadata) || part.rows.length !== Math.min(200, first.total - position)) throw new Error("Снимок получен не полностью");
        rows.push(...part.rows);
      }
      if (request === generation.current) { prepared = true; setPrintData({ page: first, rows, printedAt: new Date().toLocaleString("ru-RU", { timeZoneName: "short" }) }); }
    } catch (e) { if (request === generation.current) setError(e instanceof Error && !("status" in e) ? "Не удалось получить все строки снимка. Печать отменена; повторите попытку." : reportError(e)); }
    finally { if (!prepared && request === generation.current) setBusy(false); }
  };
  return <div className="report-snapshot">
    <QueryState query={{ ...query, data: page }} title="Не удалось загрузить снимок" loadingText="Проверяем доступ к снимку…" />
    {query.error && <p>Снимок может быть недоступен или срок его действия истёк. Запустите отчёт снова.</p>}
    {page && !query.error && <>
      <h2>{page.title || "Предпросмотр отчёта"}</h2>
      <p role="status">Всего строк: {page.total}. Снимок доступен до {new Date(page.expires_at).toLocaleString("ru-RU")}.</p>
      <div className="report-actions">{(me?.role === "analyst" || me?.role === "admin") && <button className="btn" disabled={busy} onClick={download}>Скачать XLSX</button>}<button className="btn" disabled={busy} onClick={print}>{busy ? "Подготовка…" : "PDF / Печать всех строк"}</button></div>
      {error && <div role="alert" className="alert">{error}</div>}
      {page.total === 0 ? <p>По выбранным условиям ничего не найдено.</p> : <><div className="report-table-scroll"><ReportTable page={page} rows={page.rows} /></div><div className="report-actions"><button className="btn" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 100))}>Предыдущая страница</button><span>Строки {offset + 1}–{offset + page.rows.length} из {page.total}</span><button className="btn" disabled={offset + page.rows.length >= page.total} onClick={() => setOffset(offset + 100)}>Следующая страница</button></div></>}
    </>}
    {printData && createPortal(<div ref={surface} data-ready="false" className="report-print-surface"><h1>{printData.page.title || "Предпросмотр отчёта"}</h1><p data-print-time>Дата печати: {printData.printedAt}</p><p>Всего строк: {printData.page.total}</p>{printData.page.metadata ? <><p>Область доступа: {printData.page.metadata.scope === "own" ? "Только свои проекты" : "Все доступные проекты"}; архивные проекты исключены.</p><p>Строки отчёта: {printData.page.metadata.grain === "project" ? "проекты" : "финансовые записи"}.</p><p>Ограничения снимка: {printData.page.metadata.max_rows.toLocaleString("ru-RU")} строк, {printData.page.metadata.max_bytes.toLocaleString("ru-RU")} байт; данные не усечены.</p><h2>Применённые фильтры</h2>{printData.page.metadata.filters.length ? <ul>{printData.page.metadata.filters.map((filter, index) => <li key={index}>{filterText(filter)}</li>)}</ul> : <p>Нет.</p>}</> : <p>Фильтры, область доступа и ограничения на момент формирования снимка не сохранены.</p>}{printData.rows.length ? (printData.page.columns.length <= 6 ? <ReportTable page={printData.page} rows={printData.rows} /> : <div className="report-print-records">{printData.rows.map((row, i) => <section key={i}><h2>Строка {i + 1}</h2><dl>{printData.page.columns.map((column) => <div key={column.id}><dt>{column.label}</dt><dd>{cell(row[column.id])}</dd></div>)}</dl></section>)}</div>) : <p>По выбранным условиям ничего не найдено.</p>}</div>, document.body)}
  </div>;
}
