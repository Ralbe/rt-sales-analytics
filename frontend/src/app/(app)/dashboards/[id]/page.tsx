"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import GridLayout, { type Layout } from "react-grid-layout";

import { WidgetCard } from "@/components/dashboard/WidgetCard";
import { WidgetDialog } from "@/components/dashboard/WidgetDialog";
import { newWidget } from "@/components/dashboard/catalog";
import { MultiSelect } from "@/components/MultiSelect";
import { QueryState } from "@/components/QueryState";
import { ApiError, api, del, post, put } from "@/lib/api";
import { canConfigureDashboards, canPublishDashboards, seesAllProjects, useMe, useRefs } from "@/lib/hooks";
import type { Dashboard, DashboardFilters, Widget } from "@/lib/types";

// Сетка рассчитана так, чтобы 12 строк занимали ровно видимую высоту экрана
const ROWS = 12;
const MARGIN = 10;
const EMPTY_FILTERS: DashboardFilters = { segment_ids: [], service_ids: [], manager_ids: [] };

function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize({ width, height });
    });
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}

export default function DashboardPage() {
  const { id } = useParams<{ id: string }>();
  const dashboardQuery = useQuery({
    queryKey: ["dashboard", id],
    queryFn: () => api<Dashboard>(`/dashboards/${id}`),
  });
  const dashboard = dashboardQuery.data;
  if (!dashboard) return <div className="page-body" style={{ paddingTop: 24 }}><QueryState query={dashboardQuery} title="Не удалось загрузить дашборд" /></div>;
  return (
    <>
      <QueryState query={dashboardQuery} title="Не удалось обновить дашборд" />
      <DashboardEditor key={dashboard.id} dashboard={dashboard} />
    </>
  );
}

function DashboardEditor({ dashboard }: { dashboard: Dashboard }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data: me } = useMe();
  const refsQuery = useRefs();
  const refs = refsQuery.data;
  const [widgets, setWidgets] = useState<Widget[]>(dashboard.widgets);
  const [filters, setFilters] = useState<DashboardFilters>({ ...EMPTY_FILTERS, ...dashboard.filters });
  const filtersChanged = useRef(false);
  const [name, setName] = useState(dashboard.name);
  const [shared, setShared] = useState(dashboard.is_shared);
  const [dirty, setDirty] = useState(false);
  const [dialog, setDialog] = useState<{ widget?: Widget } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [hostRef, size] = useSize<HTMLDivElement>();

  const editable = dashboard.editable;
  const rowHeight = Math.max(32, (size.height - MARGIN * (ROWS + 1)) / ROWS);

  // Обновляем чистый редактор, не затирая несохранённые правки при refetch.
  useEffect(() => {
    if (dirty) return;
    setWidgets(dashboard.widgets);
    if (!filtersChanged.current) setFilters({ ...EMPTY_FILTERS, ...dashboard.filters });
    setName(dashboard.name);
    setShared(dashboard.is_shared);
  }, [dashboard, dirty]);

  // Предупреждение о несохранённых изменениях при закрытии вкладки
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const change = (fn: (w: Widget[]) => Widget[]) => {
    setWidgets(fn);
    setDirty(true);
  };

  const onLayoutChange = (layout: Layout[]) => {
    if (!editable) return;
    const byId = new Map(layout.map((l) => [l.i, l]));
    const moved = widgets.some((w) => {
      const l = byId.get(w.id);
      return l && (l.x !== w.x || l.y !== w.y || l.w !== w.w || l.h !== w.h);
    });
    if (moved) change((ws) => ws.map((w) => ({ ...w, ...pick(byId.get(w.id)) })));
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const saved = await put<Dashboard>(`/dashboards/${dashboard.id}`, { name, widgets, filters, is_shared: shared });
      setWidgets(saved.widgets);
      setFilters({ ...EMPTY_FILTERS, ...saved.filters });
      filtersChanged.current = false;
      setName(saved.name);
      setShared(saved.is_shared);
      setDirty(false);
      queryClient.setQueryData(["dashboard", String(dashboard.id)], saved);
      await queryClient.invalidateQueries({ queryKey: ["dashboards"] });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Не удалось сохранить");
    } finally {
      setSaving(false);
    }
  };

  const reset = () => {
    filtersChanged.current = false;
    setWidgets(dashboard.widgets);
    setFilters({ ...EMPTY_FILTERS, ...dashboard.filters });
    setName(dashboard.name);
    setShared(dashboard.is_shared);
    setDirty(false);
  };

  const remove = async () => {
    if (!confirm(`Удалить дашборд «${dashboard.name}»?`)) return;
    await del(`/dashboards/${dashboard.id}`);
    await queryClient.invalidateQueries({ queryKey: ["dashboards"] });
    router.replace("/dashboards");
  };

  const copy = async () => {
    const d = await post<Dashboard>(`/dashboards/${dashboard.id}/copy`);
    await queryClient.invalidateQueries({ queryKey: ["dashboards"] });
    router.push(`/dashboards/${d.id}`);
  };

  const setFilter = (key: keyof DashboardFilters) => (value: number[]) => {
    // Фильтры просмотра сохраняются локально и не дают права редактировать общий дашборд.
    filtersChanged.current = true;
    setFilters((f) => ({ ...f, [key]: value }));
    if (editable) setDirty(true);
  };

  return (
    <>
      <div className="page-header">
        {editable ? (
          <input
            className="input"
            style={{ maxWidth: 280, fontWeight: 600, fontSize: 16 }}
            value={name}
            aria-label="Название дашборда"
            onChange={(e) => {
              setName(e.target.value);
              setDirty(true);
            }}
          />
        ) : (
          <h1>
            {dashboard.name} <span className="muted" style={{ fontSize: 13, fontWeight: 400 }}>· {dashboard.owner.full_name}</span>
          </h1>
        )}
        <div className="filters">
          {refs && (
            <>
              <MultiSelect label="Сегменты" options={refs.segments} value={filters.segment_ids} onChange={setFilter("segment_ids")} />
              <MultiSelect label="Услуги" options={refs.services} value={filters.service_ids} onChange={setFilter("service_ids")} />
              {seesAllProjects(me?.role) && (
                <MultiSelect
                  label="Менеджеры"
                  options={refs.managers.map((m) => ({ id: m.id, name: m.full_name }))}
                  value={filters.manager_ids}
                  onChange={setFilter("manager_ids")}
                />
              )}
            </>
          )}
        </div>
        <div className="spacer" />
        {error && <span className="alert">{error}</span>}
        {editable ? (
          <>
            {canPublishDashboards(me?.role) && (
              <label className="muted" style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input
                  type="checkbox"
                  checked={shared}
                  onChange={(e) => {
                    setShared(e.target.checked);
                    setDirty(true);
                  }}
                />
                Доступен всем
              </label>
            )}
            <button className="btn small" onClick={() => setDialog({})}>
              + Виджет
            </button>
            {dirty && (
              <button className="btn small" onClick={reset}>
                Отменить
              </button>
            )}
            <button className="btn small primary" onClick={save} disabled={!dirty || saving || !name.trim()}>
              {saving ? "Сохраняем…" : "Сохранить"}
            </button>
            <button className="btn icon danger" onClick={remove} title="Удалить дашборд" aria-label="Удалить дашборд">
              🗑
            </button>
          </>
        ) : canConfigureDashboards(me?.role) ? (
          <button className="btn small" onClick={copy}>
            Сделать копию для себя
          </button>
        ) : null}
      </div>

      <div className="page-body" style={{ padding: "0 10px 0" }}>
        <QueryState query={refsQuery} title="Не удалось загрузить справочники фильтров" loadingText="Загружаем справочники фильтров…" />
        <div className="grid-host" ref={hostRef}>
          {widgets.length === 0 && (
            <div className="muted" style={{ padding: 20 }}>
              Дашборд пуст. Нажмите «+ Виджет», чтобы добавить показатели и диаграммы.
            </div>
          )}
          {size.width > 0 && (
            <GridLayout
              width={size.width}
              cols={12}
              rowHeight={rowHeight}
              margin={[MARGIN, MARGIN]}
              layout={widgets.map((w) => ({ i: w.id, x: w.x, y: w.y, w: w.w, h: w.h, minW: 2, minH: 2 }))}
              isDraggable={editable}
              isResizable={editable}
              draggableHandle=".widget-drag"
              onLayoutChange={onLayoutChange}
              compactType="vertical"
            >
              {widgets.map((w) => (
                <div key={w.id}>
                  <WidgetCard
                    widget={w}
                    filters={filters}
                    editable={editable}
                    onChange={(nw) => change((ws) => ws.map((x) => (x.id === nw.id ? nw : x)))}
                    onConfigure={() => setDialog({ widget: w })}
                    onRemove={() => change((ws) => ws.filter((x) => x.id !== w.id))}
                  />
                </div>
              ))}
            </GridLayout>
          )}
        </div>
      </div>

      {dialog && (
        <WidgetDialog
          widget={dialog.widget}
          onClose={() => setDialog(null)}
          onSave={(type, config, title) => {
            const editing = dialog.widget;
            change((ws) =>
              editing
                ? ws.map((w) => (w.id === editing.id ? { ...w, config, title } : w))
                : [...ws, newWidget(type, config, title, ws)],
            );
            setDialog(null);
          }}
        />
      )}
    </>
  );
}

function pick(l?: Layout) {
  return l ? { x: l.x, y: l.y, w: l.w, h: l.h } : {};
}
