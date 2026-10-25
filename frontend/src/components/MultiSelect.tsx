"use client";

import { useEffect, useRef, useState } from "react";

interface Option {
  id: number | string;
  name: string;
}

interface Props<T extends Option> {
  label: string;
  options: T[];
  value: T["id"][];
  onChange: (value: T["id"][]) => void;
}

/** Выпадающий список с несколькими значениями (для фильтров). */
export function MultiSelect<T extends Option>({ label, options, value, onChange }: Props<T>) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const selected = options.filter((o) => value.includes(o.id));
  const caption =
    selected.length === 0 ? `${label}: все` : selected.length === 1 ? selected[0].name : `${label}: ${selected.length}`;

  const toggle = (id: T["id"]) => onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);

  return (
    <div className="ms" ref={ref}>
      <button type="button" className={`btn small ${value.length ? "primary" : ""}`} onClick={() => setOpen((o) => !o)}>
        {caption} ▾
      </button>
      {open && (
        <div className="card ms-panel">
          {options.length === 0 && <div className="muted">Нет доступных значений</div>}
          {options.map((o) => (
            <label key={o.id}>
              <input type="checkbox" checked={value.includes(o.id)} onChange={() => toggle(o.id)} />
              {o.name}
            </label>
          ))}
          {value.length > 0 && (
            <button type="button" className="btn small" style={{ margin: 6 }} onClick={() => onChange([])}>
              Сбросить
            </button>
          )}
        </div>
      )}
    </div>
  );
}
