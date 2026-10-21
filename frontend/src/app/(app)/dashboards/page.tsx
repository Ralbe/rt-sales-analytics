"use client";

import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { api } from "@/lib/api";
import type { Dashboard } from "@/lib/types";

/** Открывает первый дашборд пользователя (при первом входе сервер создаёт его автоматически). */
export default function DashboardsIndex() {
  const router = useRouter();
  const { data } = useQuery({ queryKey: ["dashboards"], queryFn: () => api<Dashboard[]>("/dashboards") });
  useEffect(() => {
    if (data?.length) router.replace(`/dashboards/${data[0].id}`);
  }, [data, router]);
  return <div className="page-body muted" style={{ paddingTop: 24 }}>Загрузка…</div>;
}
