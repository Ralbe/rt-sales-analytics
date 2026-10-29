"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { QueryState } from "@/components/QueryState";
import { ApiError, api, post } from "@/lib/api";
import { useDebounced, useRefs } from "@/lib/hooks";
import { innIsValid } from "@/lib/inn";
import type { ClientItem, RefItem } from "@/lib/types";

export interface ClientValue {
  id: number;
  name: string;
  segment?: string;
  segment_id?: number;
}

interface Props {
  id?: string;
  value: ClientValue | null;
  onChange: (v: ClientValue | null) => void;
  onBlur: () => void;
  disabled?: boolean;
  allowCreate: boolean;
}

/** Поле «Клиент»: подсказки по мере ввода (название или ИНН) и создание нового клиента без ухода с формы. */
export function ClientCombobox({ id, value, onChange, onBlur, disabled, allowCreate }: Props) {
  const [text, setText] = useState(value?.name ?? "");
  const [open, setOpen] = useState(false);
  const [hl, setHl] = useState(0);
  const [creating, setCreating] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const q = useDebounced(text.trim(), 200);

  useEffect(() => setText(value?.name ?? ""), [value?.id, value?.name]);

  const clientsQuery = useQuery({
    queryKey: ["clients", q],
    queryFn: () => api<ClientItem[]>("/clients", { query: { q, limit: 10 } }),
    enabled: open,
  });
  const options = clientsQuery.data ?? [];

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setText(value?.name ?? "");
        onBlur();
      }
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open, value, onBlur]);

  const select = (c: ClientItem) => {
    onChange({ id: c.id, name: c.name, segment: c.segment.name, segment_id: c.segment.id });
    setText(c.name);
    setOpen(false);
    onBlur();
  };

  const canCreate = allowCreate && text.trim().length >= 2;
  const count = options.length + (canCreate ? 1 : 0);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setHl((h) => Math.min(h + 1, count - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHl((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter" && open) {
      e.preventDefault();
      if (hl < options.length) select(options[hl]);
      else if (canCreate) setCreating(true);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div className="combo" ref={ref}>
      <input
        id={id}
        className="input"
        value={text}
        disabled={disabled}
        placeholder="Начните вводить название или ИНН"
        autoComplete="off"
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
          setHl(0);
          if (value) onChange(null);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />
      {open && !disabled && (
        <div className="card combo-list">
          <QueryState query={clientsQuery} title="Не удалось загрузить клиентов" loadingText="Ищем клиентов…" />
          {!clientsQuery.error && clientsQuery.data?.length === 0 && <div className="muted">Клиенты не найдены</div>}
          {options.map((c, i) => (
            <button type="button" key={c.id} className={i === hl ? "hl" : ""} onMouseDown={(e) => e.preventDefault()} onClick={() => select(c)}>
              <span>{c.name}</span>
              <span className="muted">ИНН {c.inn}</span>
            </button>
          ))}
          {canCreate && (
            <button
              type="button"
              className={`create ${hl === options.length ? "hl" : ""}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setCreating(true)}
            >
              + Новый клиент «{text.trim()}»
            </button>
          )}
        </div>
      )}
      {creating && (
        <CreateClientDialog
          initialName={/^\d+$/.test(text.trim()) ? "" : text.trim()}
          initialInn={/^\d+$/.test(text.trim()) ? text.trim() : ""}
          onClose={() => setCreating(false)}
          onCreated={(c) => {
            setCreating(false);
            select(c);
          }}
        />
      )}
    </div>
  );
}

function CreateClientDialog({
  initialName,
  initialInn,
  onClose,
  onCreated,
}: {
  initialName: string;
  initialInn: string;
  onClose: () => void;
  onCreated: (c: ClientItem) => void;
}) {
  const refsQuery = useRefs();
  const refs = refsQuery.data;
  const [name, setName] = useState(initialName);
  const [inn, setInn] = useState(initialInn);
  const [segment, setSegment] = useState("");
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Проверка каждого поля сразу, а не после нажатия «Создать»
  const errors: Record<string, string | undefined> = {
    name: name.trim().length < 2 ? "Введите название (от 2 символов)" : serverErrors.name,
    inn: !innIsValid(inn) ? "ИНН: 10 или 12 цифр с верной контрольной суммой" : serverErrors.inn,
    segment_id: !segment ? "Выберите сегмент" : serverErrors.segment_id,
  };
  const valid = !errors.name && !errors.inn && !errors.segment_id;
  const show = (f: string) => (touched[f] ? errors[f] : undefined);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setTouched({ name: true, inn: true, segment_id: true });
    if (!valid || !refs) return;
    setBusy(true);
    setFormError(null);
    try {
      onCreated(await post<ClientItem>("/clients", { name, inn, segment_id: Number(segment) }));
    } catch (err) {
      if (err instanceof ApiError) setServerErrors(err.fields);
      setFormError(err instanceof ApiError ? err.message : "Не удалось создать клиента. Повторите попытку.");
    } finally {
      setBusy(false);
    }
  };

  // Портал: диалог открывается поверх формы проекта, но не вкладывает <form> в <form>
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="card modal" onSubmit={submit}>
        <h2>Новый клиент</h2>
        <QueryState
          query={refsQuery}
          title="Не удалось загрузить справочники"
          loadingText="Загружаем справочники…"
          empty={refs?.segments.length === 0}
          emptyText="В справочнике пока нет доступных сегментов."
        />
        {formError && <div className="alert" role="alert">{formError}</div>}
        <div className={`field ${show("name") ? "has-error" : ""}`}>
          <label htmlFor="new-client-name">Название <span className="req">*</span></label>
          <input
            id="new-client-name"
            className="input"
            value={name}
            autoFocus={!initialName}
            onChange={(e) => {
              setName(e.target.value);
              setServerErrors({});
            }}
            onBlur={() => setTouched((t) => ({ ...t, name: true }))}
          />
          <div className="error">{show("name")}</div>
        </div>
        <div className={`field ${show("inn") ? "has-error" : ""}`}>
          <label htmlFor="new-client-inn">ИНН <span className="req">*</span></label>
          <input
            id="new-client-inn"
            className="input"
            value={inn}
            inputMode="numeric"
            maxLength={12}
            autoFocus={Boolean(initialName)}
            onChange={(e) => {
              setInn(e.target.value.replace(/\D/g, ""));
              setServerErrors({});
            }}
            onBlur={() => setTouched((t) => ({ ...t, inn: true }))}
          />
          {show("inn") ? <div className="error">{show("inn")}</div> : <div className="ok">{innIsValid(inn) ? "ИНН корректен" : ""}</div>}
        </div>
        {refs && <div className={`field ${show("segment_id") ? "has-error" : ""}`}>
          <label htmlFor="new-client-segment">Сегмент <span className="req">*</span></label>
          <select
            id="new-client-segment"
            className="select"
            value={segment}
            onChange={(e) => setSegment(e.target.value)}
            onBlur={() => setTouched((t) => ({ ...t, segment_id: true }))}
          >
            <option value="">— выберите —</option>
            {refs?.segments.map((s: RefItem) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <div className="error">{show("segment_id")}</div>
        </div>}
        <div className="actions">
          <button type="button" className="btn" onClick={onClose}>
            Отмена
          </button>
          <button type="submit" className="btn primary" disabled={busy || !refs}>
            Создать
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
