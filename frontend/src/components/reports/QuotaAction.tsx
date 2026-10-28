"use client";
import { useState } from "react";
import { reportError, reports } from "@/lib/report-api";
export function QuotaAction({ onReleased }: { onReleased: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const release = async () => {
    if (!window.confirm("Удалить все ваши снимки отчётов, включая открытые в других вкладках?")) return;
    setBusy(true); setError("");
    try { await reports.releaseAll(); onReleased(); } catch (e) { setError(reportError(e)); } finally { setBusy(false); }
  };
  return <div><p>Можно удалить все свои снимки, включая открытые в других вкладках, и затем повторить действие.</p><button className="btn" disabled={busy} onClick={release}>Освободить квоту снимков</button>{error && <div role="alert">{error}</div>}</div>;
}
