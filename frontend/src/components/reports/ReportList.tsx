"use client";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { QueryState } from "@/components/QueryState";
import { useMe } from "@/lib/hooks";
import { api } from "@/lib/api";
import type { Report } from "@/lib/report-api";

export function ReportList() {
  const { data: me } = useMe();
  const [offset, setOffset] = useState(0);
  const allowed = me?.role === "analyst" || me?.role === "admin";
  const query = useQuery({ queryKey: ["reports", offset], queryFn: () => api<{ items: Report[]; total?: number; offset?: number; limit?: number }>("/reports", { query: { offset, limit: 200 } }), enabled: allowed, retry: false });
  if (!allowed) return <div className="page-body"><div role="alert">Список конструктора доступен аналитикам и администраторам.</div></div>;
  return <><div className="page-header"><h1>Доступные отчёты</h1><Link className="btn primary" href="/reports/new">Создать отчёт</Link></div><div className="page-body report-builder"><p className="muted">{me?.role === "admin" ? "Все отчёты, включая личные шаблоны других владельцев." : "Ваши личные и все опубликованные отчёты, включая отчёты других владельцев."}</p><QueryState query={query} title="Не удалось загрузить отчёты" />{query.data && !query.error && (query.data.items.length ? <div className="card report-section"><ul className="report-list">{query.data.items.map((r) => <li key={r.id}><Link href={`/reports/${r.id}`}>{r.title}</Link><span>{r.published ? "Опубликован" : "Личный"}{r.owner_id !== me?.id ? " · Другой владелец" : ""}</span></li>)}</ul></div> : <p>{offset ? "На этой странице отчётов нет." : "Отчётов пока нет. Создайте первый отчёт."}</p>)}{query.data && !query.error && (typeof query.data.total === "number" ? <div className="report-actions"><button className="btn" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 200))}>Предыдущая страница</button><span>Отчёты {query.data.total ? offset + 1 : 0}–{offset + query.data.items.length} из {query.data.total}</span><button className="btn" disabled={offset + query.data.items.length >= query.data.total || query.data.items.length === 0} onClick={() => setOffset(offset + 200)}>Следующая страница</button></div> : <p role="status">Сервер не сообщил об общем количестве отчётов; следующие страницы могут быть недоступны.</p>)}</div></>;
}
