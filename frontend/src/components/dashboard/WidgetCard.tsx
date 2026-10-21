"use client";

import { useEffect, useRef, useState } from "react";

import type { ChartKind, DashboardFilters, Widget } from "@/lib/types";

import { CHARTS } from "./catalog";
import { WidgetContent } from "./widgets";

interface Props {
  widget: Widget;
  filters: DashboardFilters;
  editable: boolean;
  onChange: (w: Widget) => void;
  onConfigure: () => void;
  onRemove: () => void;
}

export function WidgetCard({ widget, filters, editable, onChange, onConfigure, onRemove }: Props) {
  const [menu, setMenu] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setMenu(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menu]);

  const charts = widget.type === "trend" || widget.type === "breakdown" ? CHARTS[widget.type] : [];
  const setChart = (chart: ChartKind) => {
    onChange({ ...widget, config: { ...widget.config, chart } });
    setMenu(false);
  };

  return (
    <div className="card widget" ref={ref}>
      <div className="widget-head">
        <div className={`title ${editable ? "widget-drag" : ""}`} title={editable ? "Перетащите, чтобы переместить" : ""}>
          {widget.title}
        </div>
        {editable && (
          <button className="btn icon" onClick={() => setMenu((m) => !m)} aria-label="Действия с виджетом">
            ⋯
          </button>
        )}
      </div>
      {menu && (
        <div className="card widget-menu">
          {charts.length > 0 && <div className="group">Вид диаграммы</div>}
          {charts.map((c) => (
            <button key={c.id} className={widget.config.chart === c.id ? "on" : ""} onClick={() => setChart(c.id)}>
              {c.name}
            </button>
          ))}
          <div className="group">Виджет</div>
          <button
            onClick={() => {
              setMenu(false);
              onConfigure();
            }}
          >
            Настроить…
          </button>
          <button style={{ color: "var(--bad)" }} onClick={onRemove}>
            Удалить с дашборда
          </button>
        </div>
      )}
      <div className="widget-body">
        <WidgetContent widget={widget} filters={filters} />
      </div>
    </div>
  );
}
