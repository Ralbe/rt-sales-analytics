"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { QueryState } from "@/components/QueryState";
import { api } from "@/lib/api";
import { canConfigureDashboards, useMe } from "@/lib/hooks";
import type { Dashboard } from "@/lib/types";

/** Открывает первый доступный дашборд или показывает пустой список. */
export default function DashboardsIndex() {
  const router = useRouter();
  const { data: me } = useMe();
  const query = useQuery({ queryKey: ["dashboards"], queryFn: () => api<Dashboard[]>("/dashboards") });
  const { data } = query;
  useEffect(() => {
    if (!query.error && data?.length) router.replace(`/dashboards/${data[0].id}`);
  }, [data, query.error, router]);
  return (
    <div className="page-body" style={{ paddingTop: 24 }}>
      <QueryState query={query} title="Не удалось загрузить дашборды" />
      {!query.error && data?.length === 0 && (
        <>
          <p className="muted">Пока нет доступных дашбордов.</p>
          {canConfigureDashboards(me?.role) && <Link className="btn primary" href="/dashboards/new">Создать дашборд</Link>}
          <p><Link href="/projects">Перейти к проектам</Link></p>
        </>
      )}
      {!query.error && Boolean(data?.length) && <div className="muted" role="status">Открываем дашборд…</div>}
    </div>
  );
}
