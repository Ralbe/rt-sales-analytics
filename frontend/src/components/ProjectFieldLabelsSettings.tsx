"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { QueryState } from "@/components/QueryState";
import { ApiError, api, put } from "@/lib/api";
import { useMe } from "@/lib/hooks";
import { PROJECT_FIELD_LABEL_MAX_LENGTH, useProjectFieldLabels, type ProjectFieldLabelItem } from "@/lib/project-field-labels";

const SETTINGS_KEY = ["project-field-labels"];

export function ProjectFieldLabelsSettings() {
  const me = useMe();
  if (!me.data) return <div className="page-body"><QueryState query={me} title="Не удалось проверить права доступа" /></div>;
  if (me.data.role !== "admin") return (
    <div className="page-body"><h1>Подписи полей проекта</h1>
      <p className="alert" role="alert">Недостаточно прав. Раздел доступен только администратору.</p></div>
  );
  return <AdminFieldLabels />;
}

function AdminFieldLabels() {
  const queryClient = useQueryClient();
  const refs = useProjectFieldLabels();
  const query = useQuery({
    queryKey: SETTINGS_KEY, queryFn: () => api<ProjectFieldLabelItem[]>("/project-fields"),
    retry: (count, error) => !(error instanceof ApiError && [401, 403].includes(error.status)) && count < 1,
  });
  const [success, setSuccess] = useState("");
  const mutation = useMutation({
    mutationFn: async ({ item, label }: { item: ProjectFieldLabelItem; label: string | null }) => {
      setSuccess("");
      return label === null
        ? api<ProjectFieldLabelItem>(`/project-fields/${item.key}`, { method: "DELETE" })
        : put<ProjectFieldLabelItem>(`/project-fields/${item.key}`, { label });
    },
    onSuccess: async (saved, { label }) => {
      queryClient.setQueryData<ProjectFieldLabelItem[]>(SETTINGS_KEY, (items) => items?.map((item) => item.key === saved.key ? saved : item));
      // Обновляем уже открытые формы и сохраняем остальные справочники.
      queryClient.setQueryData<Record<string, unknown>>(["refs"], (current) => current && ({
        ...current,
        project_field_labels: { ...(current.project_field_labels as Record<string, string> | undefined), [saved.key]: saved.label },
      }));
      setSuccess(label === null ? "Восстановлена исходная подпись." : "Подпись сохранена.");
      await queryClient.invalidateQueries({ queryKey: ["refs"] });
    },
  });
  const forbidden = query.error instanceof ApiError && [401, 403].includes(query.error.status)
    || mutation.error instanceof ApiError && [401, 403].includes(mutation.error.status);

  return <>
    <div className="page-header"><h1>Подписи полей проекта</h1></div>
    <div className="page-body">
      <p>Подписи применяются к текущим карточкам, реестру и выгрузкам. В истории сохраняются подписи на дату события.</p>
      <p className="muted">Единицы измерения сохраняются. Длина подписи — от 1 до {PROJECT_FIELD_LABEL_MAX_LENGTH} символов.</p>
      <QueryState query={query} title="Не удалось загрузить подписи" />
      <QueryState query={refs} title="Не удалось обновить подписи в справочниках" />
      {success && <p className="alert info" role="status">{success}</p>}
      {mutation.error && <p className="alert" role="alert">{mutation.error instanceof ApiError ? mutation.error.message : "Не удалось сохранить подпись."}</p>}
      {query.data && <div className="card" style={{ overflowX: "auto" }}>
        <table className="table" aria-label="Подписи полей проекта">
          <thead><tr><th>Поле</th><th>Текущая подпись</th><th>Единица</th><th>Действия</th></tr></thead>
          <tbody>{query.data.map((item) => <FieldLabelRow key={item.key} item={item} disabled={mutation.isPending || forbidden}
            save={(label) => mutation.mutate({ item, label })} />)}</tbody>
        </table>
      </div>}
    </div>
  </>;
}

function FieldLabelRow({ item, disabled, save }: {
  item: ProjectFieldLabelItem; disabled: boolean; save: (label: string | null) => void;
}) {
  // Сохранение или сброс меняет ключ редактора; ошибка оставляет введённый текст.
  return <FieldLabelEditor key={`${item.key}:${item.label}`} item={item} disabled={disabled} save={save} />;
}

function FieldLabelEditor({ item, disabled, save }: {
  item: ProjectFieldLabelItem; disabled: boolean; save: (label: string | null) => void;
}) {
  const [value, setValue] = useState(item.label);
  const label = value.trim();
  const valid = label.length >= 1 && Array.from(label).length <= PROJECT_FIELD_LABEL_MAX_LENGTH
    && !/[\p{C}\u2028\u2029]/u.test(value);
  const id = `field-label-${item.key}`;
  return <tr>
    <th scope="row"><label htmlFor={id}>{item.default_label}</label></th>
    <td><input id={id} className="input" aria-label={`Подпись: ${item.default_label}`} value={value}
      disabled={disabled} aria-invalid={!valid} maxLength={PROJECT_FIELD_LABEL_MAX_LENGTH * 2}
      onChange={(event) => setValue(event.target.value)} />
      {!valid && <div className="error">Введите от 1 до {PROJECT_FIELD_LABEL_MAX_LENGTH} символов одной строкой.</div>}
    </td>
    <td>{item.suffix || "—"}</td>
    <td><div style={{ display: "flex", gap: 8 }}>
      <button type="button" className="btn small primary" disabled={disabled || !valid || label === item.label}
        onClick={() => save(label)}>Сохранить</button>
      <button type="button" className="btn small" disabled={disabled || !item.is_overridden}
        onClick={() => save(null)}>Сбросить</button>
    </div></td>
  </tr>;
}
