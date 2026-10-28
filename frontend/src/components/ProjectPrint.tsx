"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { SESSION_EXPIRED_EVENT, api } from "@/lib/api";
import { useMe, useRefs } from "@/lib/hooks";
import { useProjectFieldLabels, type ProjectFieldKey } from "@/lib/project-field-labels";
import type { FinancialEntry, Project, RefItem, Refs, User } from "@/lib/types";

import "./ProjectPrint.css";

// Единая точка подключения подписей из useProjectFieldLabels при последующей интеграции.
export const PROJECT_PRINT_LABELS = {
  id: "Номер проекта", name: "Название проекта", client: "Клиент", client_inn: "ИНН", segment: "Сегмент",
  manager: "Ответственный", service: "Услуга", service_group: "Группа услуг", description: "Суть проекта",
  payment_type: "Тип платежа", customer_stage: "Этап по ТЗ", stage: "Стадия системы (совместимость)",
  probability: "Вероятность, %", indicator: "Индикатор проекта", implementation_year: "Год реализации",
  accepted_for_forecast: "Принимаемый к прогнозу", assessment_status: "Принимаемый к оценке",
  subsidiary_implementation: "Реализация через ДЗО", management_control: "Контроль руководства",
  is_industry_solution: "Отраслевое решение", industry_manager: "Отраслевой менеджер",
  industry_project_number: "Номер отраслевого проекта", project_status: "Статус проекта",
  realized_work: "Сделано за период", period_plan: "Планы на период",
  amount: "Сумма контракта, ₽", cost: "Себестоимость, ₽", margin: "Маржа, ₽", margin_pct: "Маржинальность, %",
  start_date: "Дата начала", expected_close_date: "Плановое закрытие", closed_at: "Дата закрытия",
  created_at: "Дата создания", updated_at: "Дата обновления", generated_at: "Дата формирования",
  financial_period: "Период", financial_amount: "Сумма, тыс. рублей", vat_included: "НДС",
  revenue_status: "Статус начисления выручки", cost_status: "Статус затрат",
  article: "Статья затрат", cost_type: "Вид затрат", financial_id: "Номер строки",
  revenue_title: "Помесячная выручка", cost_title: "Помесячные затраты", archived_at: "Архивирование",
} as const;

type Labels = Record<keyof typeof PROJECT_PRINT_LABELS, string>;
const LABEL_KEYS: Partial<Record<keyof Labels, ProjectFieldKey>> = {
  id: "id", name: "name", client: "client_id", client_inn: "client_inn", segment: "segment",
  manager: "manager_id", service: "service_id", service_group: "service_group", description: "description",
  payment_type: "payment_type_id", customer_stage: "customer_stage_id", stage: "stage", probability: "probability",
  indicator: "indicator_id", implementation_year: "implementation_year", accepted_for_forecast: "accepted_for_forecast",
  assessment_status: "assessment_status_id", subsidiary_implementation: "subsidiary_implementation",
  management_control: "management_control", is_industry_solution: "is_industry_solution", industry_manager: "industry_manager",
  industry_project_number: "industry_project_number", project_status: "project_status", realized_work: "realized_work",
  period_plan: "period_plan", amount: "amount", cost: "cost", margin: "margin", margin_pct: "margin_pct",
  start_date: "start_date", expected_close_date: "expected_close_date", closed_at: "closed_at",
  created_at: "created_at", updated_at: "updated_at", archived_at: "archived_at",
  financial_amount: "financial_entries.amount", vat_included: "financial_entries.vat_included",
  revenue_status: "financial_entries.revenue_status", cost_status: "financial_entries.cost_status",
  article: "financial_entries.article_id", cost_type: "financial_entries.cost_type_id",
  revenue_title: "financial_entries.revenue", cost_title: "financial_entries.cost",
};
type TextField = { [K in keyof Project]: Project[K] extends string | number | null ? K : never }[keyof Project] & keyof Labels;
type Row = Readonly<{ key: keyof Labels; label: string; value: string }>;
type FinancialRow = Readonly<{ period: string; amount: string; vat: string; status: string; article: string; costType: string; details: readonly Row[] }>;
interface Snapshot {
  readonly id: number;
  readonly name: string;
  readonly generatedAt: string;
  readonly completionNote: string | null;
  readonly labels: Readonly<Labels>;
  readonly sections: readonly Readonly<{ title: string; rows: readonly Row[] }>[];
  readonly revenue: readonly FinancialRow[];
  readonly costs: readonly FinancialRow[];
}

const text = (value: string | number | null | undefined) => value === null || value === undefined || value === "" ? "Не указано" : String(value);
const flag = (value: boolean) => value ? "Да" : "Нет";
const timestamp = (value: string | number) => new Intl.DateTimeFormat("ru-RU", {
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "short",
}).format(new Date(value));

function date(value: string | null | undefined) {
  if (!value) return "Не указано";
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return parts ? `${parts[3]}.${parts[2]}.${parts[1]}` : timestamp(value);
}

function reference(saved: RefItem | null | undefined, id: number | undefined, options: RefItem[]) {
  return saved?.name ?? options.find((item) => item.id === id)?.name ?? (id === undefined ? "Не указано" : `Недоступное значение (ID ${id})`);
}

/** Все значения копируются в текст из сохранённого ProjectOut, без чтения формы и преобразования Decimal. */
function makeSnapshot(project: Project, refs: Refs, labels: Labels): Snapshot {
  const row = (key: keyof Labels, value: string): Row => ({ key, label: labels[key], value });
  const rows = (keys: readonly TextField[]) => keys.map((key) => row(key, text(project[key])));
  const financial = (entry: FinancialEntry): FinancialRow => {
    // ProjectOut содержит даты строк, хотя базовый frontend-тип пока их не объявляет.
    const saved = entry as FinancialEntry & { created_at?: string; updated_at?: string };
    return {
      period: `${String(entry.month).padStart(2, "0")}.${entry.year}`,
      amount: entry.amount,
      vat: entry.vat_included ? "С НДС" : "Без НДС",
      status: reference(entry.status, entry.status_id ?? entry.reference_id, entry.kind === "revenue" ? refs.revenue_statuses : refs.cost_statuses),
      article: reference(entry.article, entry.article_id, refs.cost_articles),
      costType: reference(entry.cost_type, entry.cost_type_id, refs.cost_types),
      details: [
        ...(entry.id === undefined ? [] : [row("financial_id", String(entry.id))]),
        ...(saved.created_at ? [row("created_at", date(saved.created_at))] : []),
        ...(saved.updated_at ? [row("updated_at", date(saved.updated_at))] : []),
      ],
    };
  };
  return {
    id: project.id,
    name: project.name,
    generatedAt: timestamp(Date.now()),
    completionNote: project.stage_scheme === "customer" ? "Состояние завершения: не определено" : null,
    labels: { ...labels },
    sections: [
      { title: "Данные проекта", rows: [
        ...rows(["id", "name"]), row("client", project.client.name), row("client_inn", text(project.client_inn)),
        row("segment", project.segment.name),
        row("manager", project.manager.full_name), row("service", project.service.name), row("service_group", text(project.service.group_name)),
        row("payment_type", text(project.payment_type?.name)), row("description", text(project.description)),
      ] },
      { title: "Этапы и признаки", rows: [
        row("customer_stage", text(project.customer_stage?.name)),
        row("stage", project.stage === null ? "Не применяется" : refs.stages.find((item) => item.id === project.stage)?.name ?? `Недоступное значение (${project.stage})`),
        ...rows(["probability", "implementation_year"]), row("indicator", text(project.indicator?.name)),
        row("accepted_for_forecast", flag(project.accepted_for_forecast)), row("assessment_status", text(project.assessment_status?.name)),
        row("subsidiary_implementation", flag(project.subsidiary_implementation)), row("management_control", flag(project.management_control)),
        row("is_industry_solution", flag(project.is_industry_solution)), ...rows(["industry_manager", "industry_project_number"]),
      ] },
      { title: "Даты проекта", rows: [
        ...(["start_date", "expected_close_date", "closed_at", "created_at", "updated_at"] as const).map((key) => row(key, date(project[key]))),
        ...(project.archived_at ? [row("archived_at", date(project.archived_at))] : []),
      ] },
      { title: "Суммы карточки в рублях (₽)", rows: rows(["amount", "cost", "margin", "margin_pct"]) },
      { title: "Дополнительная информация", rows: rows(["project_status", "realized_work", "period_plan"]) },
    ],
    revenue: project.financial_entries.filter((entry) => entry.kind === "revenue").map(financial),
    costs: project.financial_entries.filter((entry) => entry.kind === "cost").map(financial),
  };
}

export function ProjectPrint({ project, pending = false, failed = false, labels: overrides }: {
  project: Project | undefined;
  pending?: boolean;
  failed?: boolean;
  labels?: Partial<Labels>;
}) {
  const refs = useRefs();
  const configuredLabels = useProjectFieldLabels();
  const me = useMe();
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [phase, setPhase] = useState<"idle" | "preparing" | "ready">("idle");
  const [error, setError] = useState<string | null>(null);
  const surface = useRef<HTMLElement>(null);
  const running = useRef(false);
  const attempt = useRef(0);
  const revoked = useRef(false);
  const invalid = failed || !project || !refs.data || !me.data || refs.isError || me.isError || revoked.current;
  const blocked = invalid || pending || refs.fetchStatus !== "idle" || me.fetchStatus !== "idle";
  const allowed = useRef(false);
  allowed.current = !invalid;

  const finish = () => { attempt.current++; running.current = false; setSnapshot(null); setPhase("idle"); };

  useEffect(() => {
    setTarget(document.body);
    const beforePrint = () => {
      if (!allowed.current || revoked.current || !running.current) surface.current?.setAttribute("data-ready", "false");
    };
    const expire = () => {
      revoked.current = true;
      // Синхронно закрываем печатную поверхность до обработки React события 401.
      surface.current?.setAttribute("data-ready", "false");
      finish();
    };
    window.addEventListener("beforeprint", beforePrint);
    window.addEventListener("afterprint", finish);
    window.addEventListener(SESSION_EXPIRED_EVENT, expire);
    return () => {
      running.current = false;
      window.removeEventListener("beforeprint", beforePrint);
      window.removeEventListener("afterprint", finish);
      window.removeEventListener(SESSION_EXPIRED_EVENT, expire);
    };
  }, []);

  useEffect(() => {
    if (invalid && running.current) {
      finish();
      setError("Печать недоступна: данные или доступ изменились. Обновите страницу и повторите попытку.");
    }
  }, [invalid]);

  useEffect(() => {
    if (!snapshot || phase !== "preparing" || invalid) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      setError("Не удалось подготовить шрифты для печати. Повторите попытку.");
      finish();
    }, 15_000);
    void document.fonts.ready.then(() => {
      if (!cancelled && allowed.current && !revoked.current) { clearTimeout(timer); setPhase("ready"); }
    });
    return () => { cancelled = true; clearTimeout(timer); };
  }, [snapshot, phase, invalid]);

  useEffect(() => {
    if (!snapshot || phase !== "ready" || invalid) return;
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => {
        if (!allowed.current || revoked.current || !running.current) return;
        try { window.print(); } catch {
          setError("Браузер не смог открыть печать. Проверьте его настройки и повторите попытку.");
          finish();
        }
      });
    });
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); };
  }, [snapshot, phase, invalid]);

  const print = async () => {
    if (blocked || revoked.current || running.current || !project || !refs.data) return;
    running.current = true;
    const request = ++attempt.current;
    setError(null);
    setPhase("preparing");
    const labels: Labels = { ...PROJECT_PRINT_LABELS };
    for (const [printKey, fieldKey] of Object.entries(LABEL_KEYS) as [keyof Labels, ProjectFieldKey][]) {
      labels[printKey] = ["created_at", "updated_at"].includes(fieldKey)
        ? configuredLabels.label(fieldKey) : configuredLabels.heading(fieldKey);
    }
    try {
      const [saved, currentUser] = await Promise.all([
        api<Project>(`/projects/${project.id}`, { cache: "no-store" }),
        api<User>("/auth/me", { cache: "no-store" }),
      ]);
      if (currentUser.id !== me.data?.id || currentUser.role !== me.data.role) throw new Error("Доступ изменился");
      if (request !== attempt.current || !running.current || revoked.current) return;
      if (!allowed.current) {
        finish();
        setError("Печать недоступна: данные или доступ изменились. Обновите страницу и повторите попытку.");
        return;
      }
      setSnapshot(makeSnapshot(saved, refs.data, { ...labels, ...overrides }));
    } catch {
      if (request !== attempt.current) return;
      setError("Печать недоступна: не удалось проверить доступ к сохранённому проекту. Обновите страницу и повторите попытку.");
      finish();
    }
  };
  const current = invalid ? null : snapshot;

  return (
    <>
      <div className="project-print-action">
        <button type="button" className="btn small" disabled={blocked || phase !== "idle" || !target} onClick={print} aria-describedby="project-print-hint">
          PDF / Печать карточки
        </button>
        <span id="project-print-hint" className="muted" role="status">
          Печатаются только сохранённые данные. Чтобы включить правки формы, сначала сохраните карточку.
          {" "}{error ?? (blocked ? "Печать недоступна до успешной загрузки проекта, справочников и профиля." : phase === "preparing" ? "Готовим печатный снимок…" : phase === "ready" ? "Закройте диалог печати, чтобы продолжить." : "В диалоге браузера выберите «Сохранить как PDF», формат A4.")}
        </span>
      </div>
      {target && createPortal(
        <section ref={surface} className="project-print-surface" data-project-print data-ready={!!current && phase === "ready"} aria-label="Печатная карточка проекта" aria-hidden="true">
          {current && <>
            <header>
              <p>Карточка проекта</p>
              <h1>{current.name}</h1>
              <p>{current.labels.generated_at}: {current.generatedAt}</p>
              <p>Снимок сохранённых данных. Несохранённые изменения формы не включены.</p>
              <p>Область данных: выбранный проект № {current.id}. Финансовые строки: выручка — {current.revenue.length}, затраты — {current.costs.length}.</p>
              {current.completionNote && <p data-completion-state="unknown">{current.completionNote}</p>}
            </header>
            {current.sections.map((section) => <section key={section.title}>
              <h2>{section.title}</h2>
              <dl>{section.rows.map((item) => <div key={item.key} data-project-field={item.key}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl>
            </section>)}
            <p>Суммы карточки указаны в ₽; помесячные суммы — в тыс. рублей. Значения сохранены без конвертации и округления.</p>
            <FinancialTable title={current.labels.revenue_title} kind="revenue" rows={current.revenue} labels={current.labels} />
            <FinancialTable title={current.labels.cost_title} kind="cost" rows={current.costs} labels={current.labels} />
          </>}
        </section>, target,
      )}
    </>
  );
}

function FinancialTable({ title, kind, rows, labels }: { title: string; kind: "revenue" | "cost"; rows: readonly FinancialRow[]; labels: Readonly<Labels> }) {
  return <section data-project-finance={kind}>
    <h2>{title}</h2>
    {!rows.length ? <p>Нет сохранённых строк.</p> : <table>
      <caption>{title}, тыс. рублей</caption>
      <thead><tr>
        <th scope="col">{labels.financial_period}</th><th scope="col">{labels.financial_amount}</th><th scope="col">{labels.vat_included}</th>
        <th scope="col">{kind === "revenue" ? labels.revenue_status : labels.cost_status}</th>
        {kind === "cost" && <><th scope="col">{labels.article}</th><th scope="col">{labels.cost_type}</th></>}
      </tr></thead>
      <tbody>{rows.map((item, index) => <tr key={index}>
        <td>{item.period}{item.details.map((detail) => <p key={detail.key}>{detail.label}: {detail.value}</p>)}</td>
        <td>{item.amount}</td><td>{item.vat}</td><td>{item.status}</td>
        {kind === "cost" && <><td>{item.article}</td><td>{item.costType}</td></>}
      </tr>)}</tbody>
    </table>}
  </section>;
}
