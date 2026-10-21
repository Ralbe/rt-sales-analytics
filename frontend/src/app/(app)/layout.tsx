"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { Sidebar } from "@/components/Sidebar";
import { useMe } from "@/lib/hooks";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { data: user, isLoading, isError } = useMe();

  // Нет сессии (401) или сервер недоступен — на страницу входа
  useEffect(() => {
    if (isError) router.replace("/login");
  }, [isError, router]);

  if (isLoading || !user) {
    return <div style={{ padding: 24 }} className="muted">Загрузка…</div>;
  }
  return (
    <div className="app">
      <Sidebar user={user} />
      <main className="main">{children}</main>
    </div>
  );
}
