"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { Sidebar } from "@/components/Sidebar";
import { QueryState } from "@/components/QueryState";
import { ApiError } from "@/lib/api";
import { useMe } from "@/lib/hooks";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const meQuery = useMe();
  const user = meQuery.data;
  const sessionExpired = meQuery.error instanceof ApiError && meQuery.error.status === 401;

  // Только истёкшая сессия требует повторного входа.
  useEffect(() => {
    if (sessionExpired) router.replace("/login");
  }, [sessionExpired, router]);

  if (sessionExpired) return <div role="status" style={{ padding: 24 }}>Сессия истекла. Переходим на страницу входа…</div>;
  if (!user) {
    return <div style={{ padding: 24 }}><QueryState query={meQuery} title="Не удалось проверить сессию" /></div>;
  }
  return (
    <div className="app">
      <Sidebar user={user} />
      <main className="main">
        <QueryState query={meQuery} title="Не удалось обновить данные сессии" />
        {children}
      </main>
    </div>
  );
}
