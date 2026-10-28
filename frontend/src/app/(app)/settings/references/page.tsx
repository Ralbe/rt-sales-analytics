"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { QueryState } from "@/components/QueryState";
import { api, post, put, ApiError } from "@/lib/api";
import { useMe } from "@/lib/hooks";

interface ReferenceValue {
  id: number;
  category: string;
  code: string;
  name: string;
  is_active: boolean;
  position: number;
  probability: number | null;
}

export default function ReferenceSettings() {
  const me = useMe();
  if (!me.data) return <div className="page-body"><QueryState query={me} title="Не удалось проверить права доступа" /></div>;
  if (me.data.role !== "admin") return <div className="page-body"><h1>Справочники</h1>
    <p className="alert" role="alert">Раздел доступен только администратору.</p></div>;
  return <AdminReferences />;
}

function AdminReferences() {
  const client = useQueryClient();
  const [category, setCategory] = useState("payment_type");
  const [name, setName] = useState("");
  const [success, setSuccess] = useState("");
  const categories = useQuery({ queryKey: ["reference-categories"], queryFn: () => api<Record<string, string>>("/reference-admin") });
  const values = useQuery({ queryKey: ["reference-admin", category], queryFn: () => api<ReferenceValue[]>(`/reference-admin/${category}`) });
  const mutation = useMutation({
    mutationFn: async (action: { id?: number; name?: string; active?: boolean }) => {
      setSuccess("");
      if (action.id === undefined) return post<ReferenceValue>(`/reference-admin/${category}`, { name: action.name });
      if (action.name !== undefined) return put<ReferenceValue>(`/reference-admin/${category}/${action.id}/name`, { name: action.name });
      return put<ReferenceValue>(`/reference-admin/${category}/${action.id}/active`, { is_active: action.active });
    },
    onSuccess: async () => {
      setName("");
      setSuccess("Изменения сохранены.");
      await Promise.all([client.invalidateQueries({ queryKey: ["reference-admin"] }), client.invalidateQueries({ queryKey: ["refs"] })]);
    },
  });
  return <>
    <div className="page-header"><h1>Справочники</h1></div>
    <div className="page-body">
      <p>Неактивные значения сохраняются в существующих карточках и недоступны для новых назначений.</p>
      <p className="muted">Порядок, вероятность и доступность этапов по ТЗ требуют отдельного согласования.</p>
      <QueryState query={categories} title="Не удалось загрузить справочники" />
      <label htmlFor="reference-category">Справочник</label>{" "}
      <select id="reference-category" className="select" value={category} disabled={mutation.isPending}
        onChange={(e) => { setCategory(e.target.value); setSuccess(""); mutation.reset(); }}>
        {Object.entries(categories.data ?? {}).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </select>
      {category !== "customer_stage" && <div style={{ margin: "16px 0" }}>
        <label htmlFor="reference-new">Новое значение</label>{" "}
        <input id="reference-new" className="input" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />{" "}
        <button className="btn primary" disabled={mutation.isPending || !name.trim()} onClick={() => mutation.mutate({ name })}>Добавить</button>
      </div>}
      {success && <p className="alert info" role="status">{success}</p>}
      {mutation.error && <p className="alert" role="alert">{mutation.error instanceof ApiError ? mutation.error.message : "Не удалось сохранить значение."}</p>}
      <QueryState query={values} title="Не удалось загрузить значения" />
      {values.data && <div className="card" style={{ overflowX: "auto" }}><table className="table" aria-label="Значения справочника">
        <thead><tr><th>Название</th><th>Состояние</th><th>Действия</th></tr></thead>
        <tbody>{values.data.map((item) => <ReferenceRow key={`${item.id}:${item.name}`} item={item} disabled={mutation.isPending}
          stage={category === "customer_stage"} save={(action) => mutation.mutate({ id: item.id, ...action })} />)}</tbody>
      </table></div>}
    </div>
  </>;
}

function ReferenceRow({ item, disabled, stage, save }: {
  item: ReferenceValue; disabled: boolean; stage: boolean; save: (action: { name?: string; active?: boolean }) => void;
}) {
  const [name, setName] = useState(item.name);
  return <tr><td><input className="input" aria-label={`Название: ${item.name}`} value={name} maxLength={100}
    disabled={disabled} onChange={(e) => setName(e.target.value)} /></td>
    <td>{item.is_active ? "Активно" : "Неактивно"}</td><td>
      <button className="btn small" disabled={disabled || !name.trim() || name.trim() === item.name} onClick={() => save({ name })}>Переименовать</button>{" "}
      {!stage && <button className="btn small" disabled={disabled} onClick={() => save({ active: !item.is_active })}>
        {item.is_active ? "Деактивировать" : "Восстановить"}</button>}
    </td></tr>;
}
