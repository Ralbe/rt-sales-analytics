"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { UserDialog } from "@/components/UserDialog";
import { ApiError, api, post, put } from "@/lib/api";
import { ROLE_LABELS, useDebounced, useMe } from "@/lib/hooks";
import type { ManagedUser, UserPage, UserSubmission } from "@/lib/user-types";

const PAGE_SIZE = 20;

export default function UsersPage() {
  const { data: me, isLoading: meLoading, isError: meError, refetch: reloadMe } = useMe();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [includeInactive, setIncludeInactive] = useState(true);
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<ManagedUser | "new" | null>(null);
  const [success, setSuccess] = useState("");
  const q = useDebounced(search.trim());
  const { data, isPending, isFetching, error, refetch } = useQuery({
    queryKey: ["users", q, includeInactive, page],
    queryFn: () => api<UserPage>("/users", { query: { q, page, size: PAGE_SIZE, include_inactive: includeInactive } }),
    enabled: me?.role === "admin",
    retry: (count, err) => !(err instanceof ApiError && [401, 403].includes(err.status)) && count < 1,
  });
  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  useEffect(() => {
    // Отключение или переименование может убрать последнюю строку текущей страницы.
    if (data && !isFetching && page > pages) setPage(pages);
  }, [data, isFetching, page, pages]);

  const save = async (values: UserSubmission) => {
    if (!editing) return;
    const { email, full_name, role, is_active, password } = values;
    if (editing === "new") {
      await post<ManagedUser>("/users", { email, full_name, role, password });
    } else {
      await put<ManagedUser>(`/users/${editing.id}`, { email, full_name, role, is_active });
    }
    setEditing(null);
    setSuccess(editing === "new" ? "Пользователь создан. При первом входе потребуется настройка 2FA." : "Изменения сохранены.");
    // Справочники содержат имена и активность, /me — текущие имя и права.
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["users"] }),
      queryClient.invalidateQueries({ queryKey: ["refs"] }),
      queryClient.invalidateQueries({ queryKey: ["me"] }),
    ]);
  };

  if (meLoading) return <div className="page-body muted" role="status">Загрузка…</div>;
  if (meError) return (
    <div className="page-body"><div className="alert" role="alert">Не удалось проверить права доступа.</div>
      <button className="btn" onClick={() => void reloadMe()}>Повторить</button></div>
  );
  if (me?.role !== "admin") return (
    <div className="page-body">
      {success && <p className="alert info" role="status">{success}</p>}
      <h1>Управление пользователями</h1>
      <p className="alert" role="alert">Недостаточно прав. Раздел доступен только администратору.</p>
    </div>
  );

  return (
    <>
      <div className="page-header">
        <h1>Пользователи</h1>
        <input className="input" style={{ maxWidth: 320 }} type="search" aria-label="Поиск по email или ФИО"
          placeholder="Поиск по email или ФИО" maxLength={255} value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input type="checkbox" checked={includeInactive}
            onChange={(e) => { setIncludeInactive(e.target.checked); setPage(1); }} />
          Включать отключённых
        </label>
        <div className="spacer" />
        <button className="btn primary" onClick={() => { setSuccess(""); setEditing("new"); }}>Новый пользователь</button>
      </div>
      <div className="page-body">
        {success && <p className="alert info" role="status">{success}</p>}
        {error && (
          <div className="alert" role="alert" style={{ marginBottom: 12 }}>
            {error instanceof ApiError ? error.message : "Не удалось загрузить пользователей."}{" "}
            <button className="btn small" disabled={isFetching} onClick={() => void refetch()}>Повторить</button>
          </div>
        )}
        {isFetching && <p className="muted" role="status">Загрузка пользователей…</p>}
        {!isPending && !error && data && (
          <>
            <div className="card" style={{ overflowX: "auto" }} aria-busy={isFetching}>
              <table className="table" aria-label="Пользователи">
                <thead><tr><th>ФИО</th><th>Email</th><th>Роль</th><th>Статус</th><th>Действия</th></tr></thead>
                <tbody>
                  {data.items.map((user) => (
                    <tr key={user.id}>
                      <td>{user.full_name}{user.id === me.id && <span className="muted"> (вы)</span>}</td>
                      <td>{user.email}</td>
                      <td>{ROLE_LABELS[user.role]}</td>
                      <td><span className={`badge ${user.is_active ? "won" : "lost"}`}>{user.is_active ? "Активен" : "Отключён"}</span></td>
                      <td><button className="btn small" aria-label={`Редактировать ${user.email}`}
                        onClick={() => { setSuccess(""); setEditing(user); }}>Редактировать</button></td>
                    </tr>
                  ))}
                  {!data.items.length && <tr><td colSpan={5} className="muted">Пользователи не найдены.</td></tr>}
                </tbody>
              </table>
            </div>
            <div className="pager" aria-label="Пагинация пользователей">
              <span className="muted">Всего: {data.total}. Страница {page} из {pages}</span>
              <button className="btn small" disabled={page <= 1 || isFetching} onClick={() => setPage((p) => p - 1)}>Назад</button>
              <button className="btn small" disabled={page >= pages || isFetching} onClick={() => setPage((p) => p + 1)}>Далее</button>
            </div>
          </>
        )}
      </div>
      {editing && <UserDialog user={editing === "new" ? undefined : editing} currentUserId={me.id}
        onSave={save} onClose={() => setEditing(null)} />}
    </>
  );
}
