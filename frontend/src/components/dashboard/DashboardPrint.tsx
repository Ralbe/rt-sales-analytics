"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

import { date } from "@/lib/format";
import { SESSION_EXPIRED_EVENT, api } from "@/lib/api";
import { useMe, useRefs } from "@/lib/hooks";
import { resolveProjectFieldLabels } from "@/lib/project-field-labels";
import { segmentFilterOptions, serviceFilterOptions } from "@/lib/reference-options";
import type { BreakdownResponse, Dashboard, DashboardFilters, KpiResponse, ProjectPage, Refs, TrendResponse, User, Widget, WidgetType } from "@/lib/types";

import { widgetQueryKey } from "./widget-data";
import { BreakdownView, KpiView, ProjectsView, TrendView, type ProjectsViewLabels } from "./widgets";

interface Props {
  id: number;
  name: string;
  widgets: Widget[];
  filters: DashboardFilters;
}

type Responses = { kpi: KpiResponse; trend: TrendResponse; breakdown: BreakdownResponse; projects: ProjectPage };
type WidgetSnapshot = { [K in WidgetType]: { type: K; widget: Widget; data: Responses[K]; loadedAt: string } }[WidgetType];
interface Snapshot {
  name: string;
  generatedAt: string;
  filters: { label: string; value: string }[];
  scope: string;
  widgets: WidgetSnapshot[];
  projectLabels: ProjectsViewLabels;
}

const timestamp = (value: number) => new Intl.DateTimeFormat("ru-RU", {
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "short",
}).format(value);

function filterLabels(filters: DashboardFilters, refs: Refs) {
  const names = (ids: number[], options: { id: number; name: string }[]) => ids.length
    ? ids.map((id) => options.find((item) => item.id === id)?.name ?? `Недоступное значение (ID ${id})`).join(", ")
    : "Все";
  return [
    { label: "Сегменты", value: names(filters.segment_ids, segmentFilterOptions(refs)) },
    { label: "Услуги", value: names(filters.service_ids, serviceFilterOptions(refs)) },
    { label: "Менеджеры", value: names(filters.manager_ids, refs.managers.map((item) => ({ id: item.id, name: item.full_name }))) },
  ];
}

function scopeLabel(me: User) {
  return me.role === "user" ? `Только мои проекты: ${me.full_name}` : "Проекты в пределах прав текущего пользователя";
}

/** Снимок сохраняет состояние редактора после повторной проверки данных и доступа. */
export function DashboardPrint({ id, name, widgets, filters }: Props) {
  const client = useQueryClient();
  const refs = useRefs();
  const me = useMe();
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [phase, setPhase] = useState<"idle" | "checking" | "preparing" | "ready">("idle");
  const [error, setError] = useState<string | null>(null);
  const surface = useRef<HTMLElement>(null);
  const running = useRef(false);
  const attempt = useRef(0);
  const revoked = useRef(false);
  const inputKey = JSON.stringify([name, widgets, filters]);
  const latestInput = useRef(inputKey);
  const activeInput = useRef(inputKey);
  const printStarted = useRef(false);
  latestInput.current = inputKey;

  const subscribe = useCallback((notify: () => void) => client.getQueryCache().subscribe(notify), [client]);
  const revision = useCallback(() => widgets.map((widget) => {
    const state = client.getQueryState(widgetQueryKey(widget, filters));
    return state ? `${state.status}:${state.fetchStatus}:${state.dataUpdatedAt}:${state.errorUpdatedAt}` : "pending";
  }).join("|"), [client, filters, widgets]);
  useSyncExternalStore(subscribe, revision, () => "");

  const unavailable = useCallback(() => {
    if (revoked.current) return "Печать недоступна: сессия завершена.";
    if (refs.isError || me.isError) return "Печать недоступна: не удалось загрузить справочники или профиль.";
    if (!refs.data || !me.data || refs.isFetching || me.isFetching) return "Печать будет доступна после загрузки справочников и профиля.";
    for (const widget of widgets) {
      const state = client.getQueryState<Responses[WidgetType]>(widgetQueryKey(widget, filters));
      if (state?.status === "error") return `Печать недоступна: ошибка данных виджета «${widget.title}». Обновите страницу или измените фильтры.`;
      if (!state || state.status !== "success" || state.fetchStatus !== "idle" || !state.data) {
        return `Печать будет доступна после загрузки виджета «${widget.title}».`;
      }
      if (widget.type === "kpi" && !(state.data as KpiResponse).items.some((item) => item.key === (widget.config.metric ?? "funnel"))) {
        return `Печать недоступна: нет показателя для виджета «${widget.title}».`;
      }
    }
    return null;
  }, [client, filters, me.data, me.isError, me.isFetching, refs.data, refs.isError, refs.isFetching, widgets]);
  const reason = unavailable();

  useEffect(() => {
    if (running.current && !printStarted.current && activeInput.current !== inputKey) {
      attempt.current++;
      running.current = false;
      surface.current?.setAttribute("data-ready", "false");
      setSnapshot(null);
      setPhase("idle");
      setError("Печать отменена: настройки дашборда изменились. Повторите попытку.");
    }
  }, [inputKey]);

  useEffect(() => {
    if (phase === "preparing" && reason) {
      attempt.current++;
      running.current = false;
      surface.current?.setAttribute("data-ready", "false");
      setSnapshot(null);
      setPhase("idle");
      setError(reason);
    }
  }, [phase, reason]);

  useEffect(() => {
    setTarget(document.body);
    const finish = () => {
      attempt.current++;
      running.current = false;
      printStarted.current = false;
      setPhase("idle");
      setSnapshot(null);
    };
    const expire = () => {
      revoked.current = true;
      surface.current?.setAttribute("data-ready", "false");
      finish();
    };
    const before = () => {
      if (revoked.current || !running.current) surface.current?.setAttribute("data-ready", "false");
    };
    window.addEventListener("afterprint", finish);
    window.addEventListener("beforeprint", before);
    window.addEventListener(SESSION_EXPIRED_EVENT, expire);
    return () => {
      running.current = false;
      window.removeEventListener("afterprint", finish);
      window.removeEventListener("beforeprint", before);
      window.removeEventListener(SESSION_EXPIRED_EVENT, expire);
    };
  }, []);

  // Снимок остаётся неизменным до закрытия диалога, даже при обновлении кэша.
  useEffect(() => {
    if (!snapshot || phase !== "preparing") return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const deadline = Date.now() + 15_000;
    const fail = () => {
      setError("Не удалось подготовить диаграммы или шрифты для печати. Повторите попытку.");
      setSnapshot(null);
      setPhase("idle");
      running.current = false;
    };
    const check = () => {
      if (cancelled) return;
      const charts = surface.current?.querySelectorAll<HTMLElement>("[data-print-chart]");
      const ready = surface.current && document.fonts.status === "loaded" && charts && Array.from(charts).every((chart) => {
        const svg = chart.querySelector("svg");
        return chart.dataset.printChart === "ready" && svg && svg.getBoundingClientRect().width > 0 && svg.getBoundingClientRect().height > 0;
      });
      if (ready && !revoked.current) {
        setPhase("ready");
      } else if (Date.now() >= deadline) {
        fail();
      } else {
        timer = setTimeout(check, 50);
      }
    };
    check();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [snapshot, phase]);

  useEffect(() => {
    if (phase !== "ready" || !snapshot) return;
    // Два кадра дают браузеру завершить разметку перед открытием диалога.
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => {
        if (revoked.current || !running.current || activeInput.current !== latestInput.current || unavailable()) {
          surface.current?.setAttribute("data-ready", "false");
          running.current = false;
          setSnapshot(null);
          setPhase("idle");
          setError("Печать отменена: данные или доступ изменились. Обновите страницу и повторите попытку.");
          return;
        }
        try {
          printStarted.current = true;
          window.print();
        } catch {
          running.current = false;
          setPhase("idle");
          setSnapshot(null);
          setError("Браузер не смог открыть печать. Проверьте его настройки и повторите попытку.");
        }
      });
    });
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); };
  }, [phase, snapshot, unavailable]);

  const print = async () => {
    if (running.current) return;
    const blocked = unavailable();
    if (blocked || !refs.data || !me.data) { setError(blocked); return; }
    running.current = true;
    const request = ++attempt.current;
    printStarted.current = false;
    activeInput.current = inputKey;
    setError(null);
    setPhase("checking");
    const labels = resolveProjectFieldLabels(refs.data.project_field_labels);
    let currentUser: User;
    try {
      const keys = new Map(widgets.map((widget) => {
        const key = widgetQueryKey(widget, filters);
        return [JSON.stringify(key), key] as const;
      }));
      const results = await Promise.all([
        api<Dashboard>(`/dashboards/${id}`, { cache: "no-store" }),
        api<User>("/auth/me", { cache: "no-store" }),
        ...Array.from(keys.values(), (key) => client.refetchQueries({ queryKey: key, exact: true }, { throwOnError: true })),
      ]);
      currentUser = results[1] as User;
      if (currentUser.id !== me.data.id || currentUser.role !== me.data.role) throw new Error("Доступ изменился");
      if (request !== attempt.current || !running.current || revoked.current) return;
      if (activeInput.current !== latestInput.current) {
        running.current = false;
        setPhase("idle");
        setError("Печать отменена: настройки дашборда изменились. Повторите попытку.");
        return;
      }
      const blockedAfterRefresh = unavailable();
      if (blockedAfterRefresh) throw new Error(blockedAfterRefresh);
    } catch {
      if (request !== attempt.current) return;
      running.current = false;
      setPhase("idle");
      setError("Печать недоступна: не удалось проверить доступ или обновить данные. Обновите страницу и повторите попытку.");
      return;
    }
    setSnapshot({
      name,
      generatedAt: timestamp(Date.now()),
      filters: filterLabels(filters, refs.data),
      scope: scopeLabel(currentUser),
      projectLabels: { name: labels.name, client_id: labels.client_id, manager_id: labels.manager_id, amount: labels.amount },
      widgets: [...widgets].sort((a, b) => a.y - b.y || a.x - b.x).map((widget) => {
        const state = client.getQueryState<Responses[WidgetType]>(widgetQueryKey(widget, filters))!;
        return { type: widget.type, widget: structuredClone(widget), data: structuredClone(state.data!), loadedAt: timestamp(state.dataUpdatedAt) } as WidgetSnapshot;
      }),
    });
    setPhase("preparing");
  };

  return (
    <>
      <div className="dashboard-print-action">
        <button className="btn small" type="button" disabled={!!reason || phase !== "idle" || !target} onClick={print} aria-describedby="dashboard-print-hint">
          PDF / Печать
        </button>
        <span id="dashboard-print-hint" className="muted" role="status">
          {error ?? (phase === "checking" || phase === "preparing" ? "Готовим печатный снимок…" : phase === "ready" ? "Закройте диалог печати, чтобы продолжить." : reason ?? "В диалоге печати выберите «Сохранить как PDF», формат A4.")}
        </span>
      </div>
      {target && createPortal(
        <section ref={surface} className="dashboard-print-surface" data-dashboard-print data-ready={phase === "ready"} aria-label="Печатная версия дашборда" aria-hidden="true">
          {snapshot ? (
            <>
              <header className="print-report-header">
                <p>Отчёт по дашборду</p>
                <h1>{snapshot.name}</h1>
                <p>Дата формирования: {snapshot.generatedAt}</p>
                <h2>Применённые фильтры</h2>
                <dl>{snapshot.filters.map((filter) => <div key={filter.label}><dt>{filter.label}:</dt><dd>{filter.value}</dd></div>)}</dl>
                <p>Область доступа: {snapshot.scope}</p>
              </header>
              {snapshot.widgets.length === 0 && <p>На текущем дашборде нет виджетов.</p>}
              {snapshot.widgets.map((item) => <PrintableWidget key={item.widget.id} item={item} projectLabels={snapshot.projectLabels} />)}
            </>
          ) : <p>Печатная версия не подготовлена. Вернитесь на дашборд и нажмите «PDF / Печать» после загрузки всех виджетов.</p>}
        </section>, target,
      )}
    </>
  );
}

function range(points: { date: string }[]) {
  return points.length ? `${date(points[0].date)} — ${date(points[points.length - 1].date)}` : "Нет данных";
}

function PrintableWidget({ item, projectLabels }: { item: WidgetSnapshot; projectLabels: ProjectsViewLabels }) {
  const { widget } = item;
  return (
    <article className="print-widget" data-widget-id={widget.id}>
      <div className="print-widget-header">
        <h2>{widget.title}</h2>
        <p>Данные загружены: {item.loadedAt}</p>
        {item.type === "trend" && <p>
          История: {widget.config.weeks ?? 6} нед. ({range(item.data.history)}).<br />
          Горизонт прогноза: {widget.config.horizon ?? 14} дн. ({range(item.data.forecast)}).
        </p>}
        {item.type === "kpi" && <p>На дату: {date(item.data.as_of)}. Сравнение: {date(item.data.previous_as_of)}.</p>}
        {item.type === "projects" && <p>Открытые проекты по убыванию суммы. Показано: {item.data.items.length}, всего: {item.data.total}, лимит: {widget.config.limit ?? 8}.</p>}
        {item.type === "breakdown" && <p>Срез по текущим фильтрам из загруженных данных.</p>}
      </div>
      {item.type === "kpi" && <KpiView widget={widget} data={item.data} />}
      {item.type === "trend" && <TrendView widget={widget} data={item.data} printable />}
      {item.type === "breakdown" && <BreakdownView widget={widget} data={item.data} printable />}
      {item.type === "projects" && <ProjectsView data={item.data} labels={projectLabels} printable />}
    </article>
  );
}
