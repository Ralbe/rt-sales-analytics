"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { QueryState } from "@/components/QueryState";
import { api } from "@/lib/api";
import { useMe } from "@/lib/hooks";

interface Version { id: string; title: string; created_at: string; report_version: number | null; total: number }

export default function ReportArchivePage() {
  const { data: me } = useMe();
  const allowed = me?.role === "admin" || me?.role === "analyst";
  const query = useQuery({ queryKey: ["report-archives"], queryFn: () => api<{ items: Version[] }>("/report-archives"), enabled: allowed });
  return <><div className="page-header"><h1>История отчётов</h1></div><div className="page-body">
    {!allowed ? <p>Раздел доступен аналитикам и администраторам.</p> : <>
      <QueryState query={query} title="Не удалось загрузить историю" />
      {query.data && <div className="card archive-list"><table className="table"><thead><tr><th>Отчёт</th><th>Дата сохранения</th><th>Версия шаблона</th><th>Строк</th></tr></thead>
        <tbody>{query.data.items.map((item) => <tr key={item.id}><td><Link href={`/reports/archive/${item.id}`}>{item.title}</Link></td>
          <td>{new Date(item.created_at).toLocaleString("ru-RU")}</td><td>{item.report_version ?? "Предпросмотр"}</td><td>{item.total}</td></tr>)}</tbody>
      </table>{!query.data.items.length && <p>Сохранённых версий пока нет.</p>}</div>}
    </>}
  </div></>;
}
