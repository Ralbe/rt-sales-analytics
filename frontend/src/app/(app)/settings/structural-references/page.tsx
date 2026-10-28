"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { QueryState } from "@/components/QueryState";
import { api, ApiError, post, put } from "@/lib/api";
import { useMe } from "@/lib/hooks";

interface Item { id: number; name: string; is_active: boolean; group_name: string | null }
type Category = "segments" | "services";

export default function StructuralReferences() {
  const me = useMe();
  if (!me.data) return <div className="page-body"><QueryState query={me} title="Не удалось проверить права доступа" /></div>;
  if (me.data.role !== "admin") return <div className="page-body"><h1>Сегменты и услуги</h1>
    <p className="alert" role="alert">Раздел доступен только администратору.</p></div>;
  return <AdminItems />;
}

function AdminItems() {
  const client = useQueryClient();
  const [category, setCategory] = useState<Category>("segments");
  const [name, setName] = useState("");
  const [group, setGroup] = useState("");
  const [success, setSuccess] = useState("");
  const query = useQuery({ queryKey: ["structural-references", category],
    queryFn: () => api<Item[]>(`/structural-references/${category}`) });
  const mutation = useMutation({
    mutationFn: (action: { id?: number; name?: string; active?: boolean }) => {
      setSuccess("");
      if (action.id === undefined) return post<Item>(`/structural-references/${category}`, {
        name: action.name, ...(category === "services" ? { group_name: group.trim() || null } : {}),
      });
      if (action.name !== undefined) return put<Item>(`/structural-references/${category}/${action.id}/name`, { name: action.name });
      return put<Item>(`/structural-references/${category}/${action.id}/active`, { is_active: action.active });
    },
    onSuccess: async () => {
      setName(""); setGroup(""); setSuccess("Изменения сохранены.");
      await Promise.all([client.invalidateQueries({ queryKey: ["structural-references"] }), client.invalidateQueries({ queryKey: ["refs"] })]);
    },
  });
  return <><div className="page-header"><h1>Сегменты и услуги</h1></div><div className="page-body">
    <p>Неактивные значения сохраняются в существующих записях и фильтрах.</p>
    <label htmlFor="structural-category">Справочник</label>{" "}
    <select id="structural-category" className="select" value={category} disabled={mutation.isPending}
      onChange={(e) => { setCategory(e.target.value as Category); setName(""); setGroup(""); mutation.reset(); setSuccess(""); }}>
      <option value="segments">Сегменты</option><option value="services">Услуги</option>
    </select>
    <div style={{ margin: "16px 0" }}><label htmlFor="structural-name">Новое значение</label>{" "}
      <input id="structural-name" className="input" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />{" "}
      {category === "services" && <><label htmlFor="structural-group">Группа услуги (необязательно)</label>{" "}
        <input id="structural-group" className="input" value={group} maxLength={100} onChange={(e) => setGroup(e.target.value)} />{" "}</>}
      <button className="btn primary" disabled={mutation.isPending || !name.trim()} onClick={() => mutation.mutate({ name })}>Добавить</button>
    </div>
    {success && <p className="alert info" role="status">{success}</p>}
    {mutation.error && <p className="alert" role="alert">{mutation.error instanceof ApiError ? mutation.error.message : "Не удалось сохранить значение."}</p>}
    <QueryState query={query} title="Не удалось загрузить значения" />
    {query.data && <div className="card" style={{ overflowX: "auto" }}><table className="table" aria-label="Значения справочника">
      <thead><tr><th>Название</th>{category === "services" && <th>Группа</th>}<th>Состояние</th><th>Действия</th></tr></thead>
      <tbody>{query.data.map((item) => <ItemRow key={`${item.id}:${item.name}`} item={item} category={category}
        disabled={mutation.isPending} save={(action) => mutation.mutate({ id: item.id, ...action })} />)}</tbody>
    </table></div>}
  </div></>;
}

function ItemRow({ item, category, disabled, save }: {
  item: Item; category: Category; disabled: boolean; save: (action: { name?: string; active?: boolean }) => void;
}) {
  const [name, setName] = useState(item.name);
  return <tr><td><input className="input" aria-label={`Название: ${item.name}`} value={name} maxLength={100}
    disabled={disabled} onChange={(e) => setName(e.target.value)} /></td>
    {category === "services" && <td>{item.group_name || "—"}</td>}
    <td>{item.is_active ? "Активно" : "Неактивно"}</td><td>
      <button className="btn small" disabled={disabled || !name.trim() || name.trim() === item.name}
        onClick={() => save({ name })}>Переименовать</button>{" "}
      <button className="btn small" disabled={disabled}
        onClick={() => save({ active: !item.is_active })}>{item.is_active ? "Деактивировать" : "Восстановить"}</button>
    </td></tr>;
}
