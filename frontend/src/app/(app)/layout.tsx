"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Sidebar } from "@/components/Sidebar";
import { QueryState } from "@/components/QueryState";
import { ApiError, SESSION_EXPIRED_EVENT } from "@/lib/api";
import { useMe } from "@/lib/hooks";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [expired, setExpired] = useState(false);
  const meQuery = useMe(!expired);
  const user = meQuery.data;
  const unauthorized = meQuery.error instanceof ApiError && meQuery.error.status === 401;
  const sessionExpired = expired || unauthorized;

  // Защищённый ресурс может вернуть 401 раньше, чем устареет успешный me в кэше.
  useEffect(() => {
    const expire = () => setExpired(true);
    window.addEventListener(SESSION_EXPIRED_EVENT, expire);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, expire);
  }, []);

  useEffect(() => {
    if (unauthorized) setExpired(true);
  }, [unauthorized]);

  // Сначала скрываем экран и фиксируем флаг: очистка кэша не должна вернуть детей или запустить me заново.
  useEffect(() => {
    if (!expired) return;
    queryClient.clear();
    router.replace("/login");
  }, [expired, queryClient, router]);

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
