"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ApiError } from "@/lib/api";
import { QuotaAction } from "./QuotaAction";
import { QueryState } from "@/components/QueryState";
import { useMe } from "@/lib/hooks";
import { reportError, reports } from "@/lib/report-api";

export function ReportPage({ id }: { id: string }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data: me } = useMe();
  const query = useQuery({ queryKey: ["report", id], queryFn: () => reports.get(id), retry: false, staleTime: 0, refetchOnMount: "always" });
  const report = !query.isFetching && !query.error && !query.isPaused ? query.data : undefined;
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [quota, setQuota] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [copyTitle, setCopyTitle] = useState("");
  const editor = me?.role === "admin" || me?.role === "analyst";
  const editable = me?.role === "admin" || (me?.role === "analyst" && report?.owner_id === me.id);
  const run = async () => { if (!report) return; setError(""); setQuota(false); setConflict(false); setBusy(true); try { const snapshot = await reports.run(id, report.version); router.push(`/reports/snapshots/${encodeURIComponent(snapshot.snapshot_id)}`); } catch (e) { setQuota(e instanceof ApiError && e.status === 429); setConflict(e instanceof ApiError && e.status === 409); setError(e instanceof ApiError && e.status === 409 ? "Отчёт изменился. Обновите его и запустите актуальную версию." : reportError(e)); } finally { setBusy(false); } };
  const publish = async () => { if (!report) return; setError(""); setConflict(false); setBusy(true); try { await reports.publish(id, !report.published, report.version); await queryClient.invalidateQueries({ queryKey: ["reports"] }); await query.refetch(); } catch (e) { setConflict(e instanceof ApiError && e.status === 409); setError(e instanceof ApiError && e.status === 409 ? "Отчёт изменился. Обновите его перед изменением публикации." : reportError(e)); } finally { setBusy(false); } };
  const duplicate = async () => { setError(""); if (!copyTitle.trim()) { setError("Введите название копии."); return; } setBusy(true); try { const copy = await reports.duplicate(id, copyTitle.trim()); router.push(`/reports/${copy.id}/edit`); } catch (e) { setError(reportError(e)); } finally { setBusy(false); } };
  return <><div className="page-header"><h1>{report?.title ?? "Отчёт"}</h1></div><div className="page-body report-builder"><QueryState query={{ ...query, data: report }} title="Не удалось открыть отчёт" loadingText="Проверяем доступ к отчёту…" />
    {report && !query.error && <div className="card report-section"><p>{report.published ? "Опубликованный отчёт" : "Личный отчёт"}</p><div className="report-actions"><button className="btn primary" disabled={busy || conflict} onClick={run}>Выполнить отчёт</button>{editable && <><Link className="btn" href={`/reports/${id}/edit`}>Редактировать</Link><button className="btn" disabled={busy || conflict} onClick={publish}>{report.published ? "Отозвать публикацию" : "Опубликовать"}</button></>}{editor && <Link className="btn" href="/reports">Доступные отчёты</Link>}</div>
    {editor && <div className="report-copy"><label className="field">Название копии<input className="input" value={copyTitle} onChange={(e) => setCopyTitle(e.target.value)} placeholder={`${report.title} — копия`} /></label><button className="btn" disabled={busy} onClick={duplicate}>Дублировать</button></div>}</div>}
    {error && <div className="alert" role="alert">{error}</div>}{conflict && <button className="btn" onClick={async () => { setConflict(false); setError(""); await query.refetch(); }}>Обновить отчёт</button>}{quota && <QuotaAction onReleased={() => { setQuota(false); setError(""); }} />}</div></>;
}
