"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

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
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuPosition, setMenuPosition] = useState({ left: 0, top: 0 });

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!ref.current?.contains(target) && !menuRef.current?.contains(target)) setMenu(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menu]);

  useLayoutEffect(() => {
    if (!menu) return;
    const place = () => {
      const trigger = triggerRef.current?.getBoundingClientRect();
      const popup = menuRef.current?.getBoundingClientRect();
      if (!trigger || !popup) return;
      const offsetWidth = menuRef.current?.offsetWidth ?? 0;
      const zoom = offsetWidth > 0 ? popup.width / offsetWidth : 1;
      const gutter = 8 * zoom;
      const left = Math.max(gutter, Math.min(trigger.right - popup.width, window.innerWidth - popup.width - gutter));
      const below = window.innerHeight - trigger.bottom - gutter;
      const above = trigger.top - gutter;
      const preferredTop = below >= popup.height || below >= above
        ? trigger.bottom + 4 * zoom
        : trigger.top - popup.height - 4 * zoom;
      const top = Math.max(gutter, Math.min(preferredTop, window.innerHeight - popup.height - gutter));
      setMenuPosition({ left: left / zoom, top: top / zoom });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
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
          <button ref={triggerRef} className="btn icon" onClick={() => setMenu((m) => !m)} aria-label="Действия с виджетом">
            ⋯
          </button>
        )}
      </div>
      {menu && typeof document !== "undefined" && createPortal(
        <div ref={menuRef} className="card widget-menu" style={menuPosition}>
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
        </div>,
        document.body,
      )}
      <div className="widget-body">
        <WidgetContent widget={widget} filters={filters} />
      </div>
    </div>
  );
}
