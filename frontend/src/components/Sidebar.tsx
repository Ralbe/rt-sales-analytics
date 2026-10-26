"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

import { api, post } from "@/lib/api";
import { QueryState } from "@/components/QueryState";
import { ROLE_LABELS, canConfigureDashboards, canEditProjects } from "@/lib/hooks";
import type { Dashboard, User } from "@/lib/types";

/** Панель управления: состав пунктов зависит от роли пользователя. */
export function Sidebar({ user }: { user: User }) {
  const pathname = usePathname();
  const router = useRouter();
  const queryClient = useQueryClient();
  const dashboardsQuery = useQuery({
    queryKey: ["dashboards"],
    queryFn: () => api<Dashboard[]>("/dashboards"),
  });
  const dashboards = dashboardsQuery.data ?? [];

  const own = dashboards.filter((d) => d.editable);
  const shared = dashboards.filter((d) => !d.editable);
  const active = (href: string) => (pathname === href ? "active" : "");

  const logout = async () => {
    await post("/auth/logout");
    queryClient.clear();
    router.replace("/login");
  };

  return (
    <nav className="sidebar">
      <div className="brand">
        Аналитика <span>продаж</span>
      </div>

      <div className="section">Мои дашборды</div>
      <QueryState query={dashboardsQuery} title="Не удалось загрузить дашборды" loadingText="Загружаем дашборды…" />
      {!dashboardsQuery.error && dashboardsQuery.data?.length === 0 && <div>Нет доступных дашбордов</div>}
      {own.map((d) => (
        <Link key={d.id} href={`/dashboards/${d.id}`} className={active(`/dashboards/${d.id}`)} title={d.name}>
          {d.name}
        </Link>
      ))}
      {canConfigureDashboards(user.role) && (
        <Link href="/dashboards/new" className={active("/dashboards/new")}>
          + Новый дашборд
        </Link>
      )}

      {shared.length > 0 && <div className="section">Общие</div>}
      {shared.map((d) => (
        <Link key={d.id} href={`/dashboards/${d.id}`} className={active(`/dashboards/${d.id}`)} title={d.name}>
          {d.name}
        </Link>
      ))}

      <div className="section">Проекты</div>
      <Link href="/projects" className={active("/projects")}>
        Список проектов
      </Link>
      {canEditProjects(user.role) && (
        <Link href="/projects/new" className={active("/projects/new")}>
          + Новый проект
        </Link>
      )}

      {user.role === "admin" && (
        <>
          <div className="section">Администрирование</div>
          <Link href="/users" className={active("/users")}>
            Пользователи
          </Link>
          <Link href="/settings/project-fields" className={active("/settings/project-fields")}>
            Подписи полей проекта
          </Link>
        </>
      )}

      <div className="user">
        <div>{user.full_name}</div>
        <div className="role">{ROLE_LABELS[user.role]}</div>
        <button className="link" style={{ padding: "8px 0 0" }} onClick={logout}>
          Выйти
        </button>
      </div>
    </nav>
  );
}
