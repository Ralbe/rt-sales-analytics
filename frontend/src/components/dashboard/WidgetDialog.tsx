"use client";

import { useState } from "react";

import type { ChartKind, GroupBy, KpiKey, Widget, WidgetConfig, WidgetType } from "@/lib/types";

import { CHARTS, GROUPS, METRICS, WIDGET_TYPES, autoTitle, defaultConfig } from "./catalog";

interface Props {
  widget?: Widget;
  onSave: (type: WidgetType, config: WidgetConfig, title: string) => void;
  onClose: () => void;
}

/** Добавление или настройка виджета. */
export function WidgetDialog({ widget, onSave, onClose }: Props) {
  const [type, setType] = useState<WidgetType>(widget?.type ?? "breakdown");
  const [config, setConfig] = useState<WidgetConfig>(widget?.config ?? defaultConfig("breakdown"));
  const [title, setTitle] = useState(widget?.title ?? "");
  const [titleTouched, setTitleTouched] = useState(Boolean(widget));
  const shownTitle = titleTouched ? title : autoTitle(type, config);

  const set = (patch: Partial<WidgetConfig>) => setConfig((c) => ({ ...c, ...patch }));
  const changeType = (t: WidgetType) => {
    setType(t);
    setConfig(defaultConfig(t));
  };
  // Для тренда доступны только «воронка» и «количество»
  const metrics = type === "trend" ? METRICS.filter((m) => m.id !== "won_ytd") : METRICS;

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className="card modal"
        onSubmit={(e) => {
          e.preventDefault();
          onSave(type, config, shownTitle.trim() || autoTitle(type, config));
        }}
      >
        <h2>{widget ? "Настройка виджета" : "Новый виджет"}</h2>

        {!widget && (
          <div className="field">
            <label>Тип</label>
            <select className="select" value={type} onChange={(e) => changeType(e.target.value as WidgetType)}>
              {WIDGET_TYPES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
        )}

        {type !== "projects" && (
          <div className="field">
            <label>Показатель</label>
            <select className="select" value={config.metric} onChange={(e) => set({ metric: e.target.value as KpiKey })}>
              {metrics.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </div>
        )}

        {type === "breakdown" && (
          <div className="field">
            <label>Разбивка по</label>
            <select className="select" value={config.group_by} onChange={(e) => set({ group_by: e.target.value as GroupBy })}>
              {GROUPS.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </div>
        )}

        {(type === "breakdown" || type === "trend") && (
          <div className="field">
            <label>Вид диаграммы</label>
            <select className="select" value={config.chart} onChange={(e) => set({ chart: e.target.value as ChartKind })}>
              {CHARTS[type].map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        )}

        {type === "trend" && (
          <div className="form-grid" style={{ padding: 0 }}>
            <div className="field">
              <label>Период истории</label>
              <select className="select" value={config.weeks} onChange={(e) => set({ weeks: Number(e.target.value) })}>
                {[4, 5, 6, 8, 12].map((w) => (
                  <option key={w} value={w}>
                    {w} недель
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Горизонт прогноза</label>
              <select className="select" value={config.horizon} onChange={(e) => set({ horizon: Number(e.target.value) })}>
                {[7, 14, 21, 30].map((h) => (
                  <option key={h} value={h}>
                    {h} дней
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}

        {type === "projects" && (
          <div className="field">
            <label>Сколько проектов показывать</label>
            <select className="select" value={config.limit} onChange={(e) => set({ limit: Number(e.target.value) })}>
              {[5, 8, 10, 15, 20].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="field">
          <label>Заголовок</label>
          <input
            className="input"
            value={shownTitle}
            maxLength={200}
            onChange={(e) => {
              setTitleTouched(true);
              setTitle(e.target.value);
            }}
          />
        </div>

        <div className="actions">
          <button type="button" className="btn" onClick={onClose}>
            Отмена
          </button>
          <button type="submit" className="btn primary">
            {widget ? "Применить" : "Добавить"}
          </button>
        </div>
      </form>
    </div>
  );
}
