"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { z } from "zod";

import { ClientCombobox } from "@/components/ClientCombobox";
import { QueryState } from "@/components/QueryState";
import { ApiError, api, post, put } from "@/lib/api";
import { date, moneyFull, today } from "@/lib/format";
import { canEditProjects, useMe, useRefs } from "@/lib/hooks";
import type { FinancialEntry, Project, Stage } from "@/lib/types";

const DRAFT_KEY = "project-draft";
const STAGES = ["lead", "qualification", "proposal", "negotiation", "won", "lost"] as const;

const toNumber = (v: string) => Number(v.replace(/\s/g, "").replace(",", "."));
const isNumber = (v: string) => v.trim() !== "" && Number.isFinite(toNumber(v));
const money = (label: string, required: boolean) =>
  z
    .string()
    .refine((v) => !required || v.trim() !== "", `Введите ${label}`)
    .refine((v) => v.trim() === "" || isNumber(v), "Введите число, например 1 500 000")
    .refine((v) => v.trim() === "" || toNumber(v) >= 0, "Не может быть отрицательной")
    .refine((v) => v.trim() === "" || toNumber(v) <= 1e12, "Слишком большая сумма")
    .refine((v) => !required || v.trim() === "" || toNumber(v) > 0, "Сумма должна быть больше 0");

const schema = z
  .object({
    name: z.string().trim().min(3, "Минимум 3 символа").max(300, "Не длиннее 300 символов"),
    client: z
      .object({ id: z.number(), name: z.string(), segment: z.string().optional() })
      .nullable()
      .refine((v) => v !== null, "Выберите клиента из списка или создайте нового"),
    service_id: z.string().min(1, "Выберите услугу"),
    manager_id: z.string().min(1, "Выберите ответственного"),
    stage: z.enum(STAGES, { errorMap: () => ({ message: "Выберите стадию" }) }),
    customer_stage_id: z.string(),
    payment_type_id: z.string(),
    indicator_id: z.string(),
    accepted_for_forecast: z.boolean(),
    assessment_status_id: z.string(),
    subsidiary_implementation: z.boolean(),
    management_control: z.boolean(),
    is_industry_solution: z.boolean(),
    industry_manager: z.string().max(200, "Не длиннее 200 символов"),
    industry_project_number: z.string().max(100, "Не длиннее 100 символов"),
    implementation_year: z
      .string()
      .refine(
        (v) => v === "" || (/^\d{4}$/.test(v) && Number(v) >= 1900 && Number(v) <= 2200),
        "Введите год от 1900 до 2200",
      ),
    project_status: z.string().max(100, "Не длиннее 100 символов"),
    realized_work: z.string().max(5000, "Не длиннее 5000 символов"),
    period_plan: z.string().max(5000, "Не длиннее 5000 символов"),
    probability: z
      .string()
      .refine((v) => /^\d{1,3}$/.test(v.trim()) && Number(v) <= 100, "Целое число от 0 до 100"),
    amount: money("сумму контракта", true),
    cost: money("себестоимость", false),
    start_date: z.string().min(1, "Укажите дату начала"),
    expected_close_date: z.string().min(1, "Укажите плановую дату"),
    description: z.string().max(5000, "Не длиннее 5000 символов"),
  })
  .refine((d) => !d.start_date || !d.expected_close_date || d.expected_close_date >= d.start_date, {
    path: ["expected_close_date"],
    message: "Не раньше даты начала",
  });

type FormValues = z.input<typeof schema>;

// Ошибки сервера приходят по именам полей API — сопоставляем с полями формы
const SERVER_FIELD: Record<string, keyof FormValues> = { client_id: "client" };

function fromProject(p?: Project, defaultManager?: number): FormValues {
  return {
    name: p?.name ?? "",
    client: p ? { id: p.client.id, name: p.client.name, segment: p.segment.name } : null,
    service_id: p ? String(p.service.id) : "",
    manager_id: p ? String(p.manager.id) : defaultManager ? String(defaultManager) : "",
    stage: p?.stage ?? "lead",
    customer_stage_id: p?.customer_stage ? String(p.customer_stage.id) : "",
    payment_type_id: p?.payment_type ? String(p.payment_type.id) : "",
    indicator_id: p?.indicator ? String(p.indicator.id) : "",
    accepted_for_forecast: p?.accepted_for_forecast ?? false,
    assessment_status_id: p?.assessment_status ? String(p.assessment_status.id) : "",
    subsidiary_implementation: p?.subsidiary_implementation ?? false,
    management_control: p?.management_control ?? false,
    is_industry_solution: p?.is_industry_solution ?? false,
    industry_manager: p?.industry_manager ?? "",
    industry_project_number: p?.industry_project_number ?? "",
    implementation_year: p?.implementation_year ? String(p.implementation_year) : "",
    project_status: p?.project_status ?? "",
    realized_work: p?.realized_work ?? "",
    period_plan: p?.period_plan ?? "",
    probability: String(p?.probability ?? 10),
    amount: p ? String(Number(p.amount)) : "",
    cost: p ? String(Number(p.cost)) : "",
    start_date: p?.start_date ?? today(),
    expected_close_date: p?.expected_close_date ?? "",
    description: p?.description ?? "",
  };
}

function financialRowsFromProject(project?: Project): FinancialEntry[] {
  return (project?.financial_entries ?? []).map((entry) => ({
    ...entry,
    status_id: entry.status?.id,
    article_id: entry.article?.id,
    cost_type_id: entry.cost_type?.id,
  }));
}

function loadDraft(): FormValues | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    return raw ? (JSON.parse(raw) as FormValues) : null;
  } catch {
    return null;
  }
}

function saveDraft(values: FormValues | null) {
  try {
    if (values) localStorage.setItem(DRAFT_KEY, JSON.stringify(values));
    else localStorage.removeItem(DRAFT_KEY);
  } catch {
    /* хранилище недоступно — черновик просто не сохраняется */
  }
}

export function ProjectForm({ project }: { project?: Project }) {
  const refsQuery = useRefs();
  // Ждём справочники: иначе выпадающие списки не смогут показать восстановленные значения
  return (
    <>
      <QueryState
        query={refsQuery}
        title="Не удалось загрузить справочники"
        loadingText="Загружаем справочники…"
        empty={refsQuery.data?.services.length === 0}
        emptyText="В справочнике пока нет доступных услуг."
      />
      {refsQuery.data && <ProjectFormInner project={project} />}
    </>
  );
}

function ProjectFormInner({ project }: { project?: Project }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data: me } = useMe();
  const { data: refs } = useRefs();
  const isNew = !project;
  const isUser = me?.role === "user";
  const readOnly = !canEditProjects(me?.role);

  const [formError, setFormError] = useState<string | null>(null);
  const [nameTaken, setNameTaken] = useState(false);
  const [draftRestored, setDraftRestored] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const financialBaseline = useRef(financialRowsFromProject(project));
  const [financialEntries, setFinancialEntries] = useState<FinancialEntry[]>(financialBaseline.current);
  const financialDirty = JSON.stringify(financialEntries) !== JSON.stringify(financialBaseline.current);

  const { register, control, handleSubmit, reset, setValue, setError, trigger, getValues, watch, formState } =
    useForm<FormValues>({
      resolver: zodResolver(schema),
      mode: "onTouched", // ошибка появляется, как только пользователь ушёл с поля
      defaultValues: fromProject(project, me?.id),
    });
  const { errors, isSubmitting, isDirty, dirtyFields, touchedFields } = formState;

  // Фоновое обновление может заменить только данные без локальных правок.
  useEffect(() => {
    if (!project || isDirty || financialDirty || isSubmitting) return;
    financialBaseline.current = financialRowsFromProject(project);
    setFinancialEntries(financialBaseline.current);
    reset(fromProject(project));
  }, [project, isDirty, financialDirty, isSubmitting, reset]);

  // Восстановление черновика новой карточки
  useEffect(() => {
    if (!isNew) return;
    const draft = loadDraft();
    if (draft) {
      reset(draft, { keepDefaultValues: true });
      setDraftRestored(true);
    }
  }, [isNew, reset]);

  const values = watch();
  const submittedRef = useRef(false);

  // Автосохранение черновика нового проекта: только на правки полей (reset сюда не попадает)
  useEffect(() => {
    if (!isNew) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sub = watch((_, { name }) => {
      if (!name) return;
      clearTimeout(timer);
      timer = setTimeout(() => !submittedRef.current && saveDraft(getValues()), 500);
    });
    return () => {
      clearTimeout(timer);
      sub.unsubscribe();
    };
  }, [isNew, watch, getValues]);

  // Проверка дубля «клиент + название» во время ввода, а не после отправки
  const checkName = useCallback(async () => {
    const { name, client } = getValues();
    if (!client || name.trim().length < 3) return setNameTaken(false);
    const r = await api<{ available: boolean }>("/projects/check-name", {
      query: { name: name.trim(), client_id: client.id, exclude_id: project?.id },
    }).catch(() => ({ available: true }));
    setNameTaken(!r.available);
  }, [getValues, project?.id]);

  useEffect(() => {
    if (values.client?.id) checkName();
  }, [values.client?.id, checkName]);

  const onStageChange = (stage: Stage) => {
    // Вероятность подставляется автоматически, пока пользователь не ввёл её сам
    if (getValues("customer_stage_id")) return;
    const def = refs?.stages.find((s) => s.id === stage)?.probability;
    if (def !== undefined && !dirtyFields.probability) setValue("probability", String(def), { shouldValidate: true });
  };

  const onCustomerStageChange = (stageId: string) => {
    const stage = refs?.customer_stages.find((item) => String(item.id) === stageId);
    if (stage) setValue("probability", String(stage.probability), { shouldValidate: true });
  };

  const submit = handleSubmit(async (v) => {
    setFormError(null);
    if (nameTaken) return;
    const invalidEntry = financialEntries.find((entry) =>
      !entry.amount.trim() || !Number.isFinite(Number(entry.amount)) || Number(entry.amount) < 0 ||
      !entry.status_id || !Number.isInteger(Number(entry.year)) || Number(entry.year) < 1900 || Number(entry.year) > 2200 ||
      !Number.isInteger(Number(entry.month)) || Number(entry.month) < 1 || Number(entry.month) > 12 ||
      (entry.kind === "cost" && (!entry.article_id || !entry.cost_type_id)),
    );
    if (invalidEntry) return setFormError("Заполните сумму и все справочные поля финансовых строк");
    const body = {
      name: v.name.trim(),
      description: v.description,
      client_id: v.client!.id,
      service_id: Number(v.service_id),
      manager_id: Number(v.manager_id),
      stage: v.stage,
      probability: Number(v.probability),
      amount: toNumber(v.amount).toFixed(2),
      cost: (v.cost.trim() ? toNumber(v.cost) : 0).toFixed(2),
      start_date: v.start_date,
      expected_close_date: v.expected_close_date,
      payment_type_id: v.payment_type_id ? Number(v.payment_type_id) : null,
      customer_stage_id: v.customer_stage_id ? Number(v.customer_stage_id) : null,
      indicator_id: v.indicator_id ? Number(v.indicator_id) : null,
      accepted_for_forecast: v.accepted_for_forecast,
      assessment_status_id: v.accepted_for_forecast && v.assessment_status_id ? Number(v.assessment_status_id) : null,
      subsidiary_implementation: v.subsidiary_implementation,
      management_control: v.management_control,
      is_industry_solution: v.is_industry_solution,
      industry_manager: v.is_industry_solution ? v.industry_manager.trim() || null : null,
      industry_project_number: v.is_industry_solution ? v.industry_project_number.trim() || null : null,
      implementation_year: v.implementation_year ? Number(v.implementation_year) : null,
      project_status: v.project_status.trim() || null,
      realized_work: v.realized_work,
      period_plan: v.period_plan,
    };
    try {
      const saved = project
        ? await put<Project>(`/projects/${project.id}`, body)
        : await post<Project>("/projects", body);
      const savedEntries = await put<FinancialEntry[]>(`/projects/${saved.id}/financial-entries`, financialEntries.map((entry) => ({
        kind: entry.kind, year: Number(entry.year), month: Number(entry.month), amount: entry.amount,
        vat_included: entry.vat_included, status_id: Number(entry.status_id),
        article_id: entry.kind === "cost" ? Number(entry.article_id) : null,
        cost_type_id: entry.kind === "cost" ? Number(entry.cost_type_id) : null,
      })));
      const savedProject = { ...saved, financial_entries: savedEntries };
      await queryClient.invalidateQueries();
      if (isNew) {
        submittedRef.current = true;
        saveDraft(null);
        router.replace(`/projects/${saved.id}`);
      } else {
        queryClient.setQueryData(["project", String(saved.id)], savedProject);
        reset(fromProject(savedProject));
        financialBaseline.current = financialRowsFromProject(savedProject);
        setFinancialEntries(financialBaseline.current);
        setSavedAt(new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }));
      }
    } catch (e) {
      if (!(e instanceof ApiError)) return setFormError("Сервер недоступен, попробуйте ещё раз");
      const fields = Object.entries(e.fields);
      fields.forEach(([f, message]) =>
        setError((SERVER_FIELD[f] ?? f) as keyof FormValues, { type: "server", message }),
      );
      if (!fields.length || e.fields._form) setFormError(e.message);
    }
  });

  const clearDraft = () => {
    saveDraft(null);
    reset(fromProject(undefined, me?.id));
    setDraftRestored(false);
  };

  const amount = isNumber(values.amount ?? "") ? toNumber(values.amount!) : null;
  const cost = values.cost?.trim() ? (isNumber(values.cost) ? toNumber(values.cost) : null) : 0;
  const margin = amount !== null && cost !== null ? amount - cost : null;
  const errorCount = Object.keys(errors).length + (nameTaken ? 1 : 0);

  const err = (name: keyof FormValues) => errors[name]?.message as string | undefined;
  const cls = (name: keyof FormValues) => `field ${err(name) ? "has-error" : ""}`;
  const req = <span className="req">*</span>;

  return (
    <form onSubmit={submit} noValidate className="card" style={{ display: "flex", flexDirection: "column" }}>
      {draftRestored && (
        <div className="alert info" style={{ margin: "14px 20px 0", display: "flex", gap: 10, alignItems: "center" }}>
          Восстановлен несохранённый черновик.
          <button type="button" className="btn small" onClick={clearDraft}>
            Начать заново
          </button>
        </div>
      )}
      <fieldset disabled={readOnly} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
        <div className="form-grid">
          <div className="col">
            <div className={`field ${err("name") || nameTaken ? "has-error" : ""}`}>
              <label htmlFor="name">Название проекта {req}</label>
              <input id="name" className="input" {...register("name", { onBlur: checkName })} />
              <div className="error">
                {err("name") ?? (nameTaken ? "У этого клиента уже есть проект с таким названием" : "")}
              </div>
            </div>

            <div className={cls("client")}>
              <label htmlFor="client">Клиент {req}</label>
              <Controller
                control={control}
                name="client"
                render={({ field }) => (
                  <ClientCombobox
                    id="client"
                    value={field.value}
                    onChange={field.onChange}
                    onBlur={field.onBlur}
                    disabled={readOnly}
                    allowCreate={!readOnly}
                  />
                )}
              />
              {err("client") ? (
                <div className="error">{err("client")}</div>
              ) : (
                <div className="hint">{values.client?.segment ? `Сегмент: ${values.client.segment}` : ""}</div>
              )}
            </div>

            <div className="row2">
              <div className={cls("service_id")}>
                <label htmlFor="service_id">Услуга {req}</label>
                <select id="service_id" className="select" {...register("service_id")}>
                  <option value="">— выберите —</option>
                  {refs?.services.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.group_name ? `${s.group_name} — ${s.name}` : s.name}
                    </option>
                  ))}
                </select>
                <div className="error">{err("service_id")}</div>
              </div>
              <div className={cls("manager_id")}>
                <label htmlFor="manager_id">Ответственный {req}</label>
                {isUser ? (
                  // Пользователь ведёт только свои проекты.
                  <input id="manager_id" className="input" readOnly value={project?.manager.full_name ?? me?.full_name ?? ""} />
                ) : (
                  <select id="manager_id" className="select" {...register("manager_id")}>
                    <option value="">— выберите —</option>
                    {refs?.managers.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.full_name}
                      </option>
                    ))}
                  </select>
                )}
                <div className={isUser ? "hint" : "error"}>
                  {isUser ? "Пользователь ведёт свои проекты" : err("manager_id")}
                </div>
              </div>
            </div>

            <div className={cls("description")}>
              <label htmlFor="description">Суть проекта</label>
              <textarea id="description" className="textarea" rows={4} {...register("description")} />
              <div className="error">{err("description")}</div>
            </div>

            <div className="row2">
              <div className={cls("payment_type_id")}>
                <label htmlFor="payment_type_id">Тип платежа</label>
                <select id="payment_type_id" className="select" {...register("payment_type_id")}>
                  <option value="">— не указан —</option>
                  {refs?.payment_types.map((item) => (
                    <option key={item.id} value={item.id}>{item.name}</option>
                  ))}
                </select>
                <div className="error">{err("payment_type_id")}</div>
              </div>
              <div className={cls("indicator_id")}>
                <label htmlFor="indicator_id">Индикатор проекта</label>
                <select id="indicator_id" className="select" {...register("indicator_id")}>
                  <option value="">— не указан —</option>
                  {refs?.project_indicators.map((item) => (
                    <option key={item.id} value={item.id}>{item.name}</option>
                  ))}
                </select>
                <div className="error">{err("indicator_id")}</div>
              </div>
            </div>

            <div className="row2">
              <div className={cls("customer_stage_id")}>
                <label htmlFor="customer_stage_id">Этап по ТЗ</label>
                <select
                  id="customer_stage_id"
                  className="select"
                  {...register("customer_stage_id", { onChange: (e) => onCustomerStageChange(e.target.value) })}
                >
                  <option value="">— не указан —</option>
                  {refs?.customer_stages.map((item) => (
                    <option key={item.id} value={item.id}>{item.name} ({item.probability}%)</option>
                  ))}
                </select>
                <div className="hint">Старая стадия сохранена отдельно для совместимости.</div>
              </div>
              <div className={cls("implementation_year")}>
                <label htmlFor="implementation_year">Год реализации</label>
                <input
                  id="implementation_year"
                  className="input"
                  inputMode="numeric"
                  {...register("implementation_year")}
                />
                <div className="error">{err("implementation_year")}</div>
              </div>
            </div>

            <div style={{ display: "grid", gap: 8, padding: "4px 0" }}>
              <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input type="checkbox" {...register("accepted_for_forecast")} />
                Принимаемый к прогнозу
              </label>
              <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input type="checkbox" {...register("subsidiary_implementation")} />
                Реализация через ДЗО
              </label>
              <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input type="checkbox" {...register("management_control")} />
                Контроль руководства
              </label>
              <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input type="checkbox" {...register("is_industry_solution")} />
                Отраслевое решение
              </label>
            </div>

            {values.accepted_for_forecast && (
              <div className={cls("assessment_status_id")}>
                <label htmlFor="assessment_status_id">Принимаемый к оценке</label>
                <select id="assessment_status_id" className="select" {...register("assessment_status_id")}>
                  <option value="">— не указан —</option>
                  {refs?.assessment_statuses.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
                <div className="error">{err("assessment_status_id")}</div>
              </div>
            )}

            {values.is_industry_solution && (
              <div className="row2">
                <div className={cls("industry_manager")}>
                  <label htmlFor="industry_manager">Отраслевой менеджер</label>
                  <input id="industry_manager" className="input" {...register("industry_manager")} />
                  <div className="error">{err("industry_manager")}</div>
                </div>
                <div className={cls("industry_project_number")}>
                  <label htmlFor="industry_project_number">Номер отраслевого проекта</label>
                  <input id="industry_project_number" className="input" {...register("industry_project_number")} />
                  <div className="error">{err("industry_project_number")}</div>
                </div>
              </div>
            )}

            <div className={cls("project_status")}>
              <label htmlFor="project_status">Статус проекта</label>
              <input id="project_status" className="input" {...register("project_status")} />
              <div className="error">{err("project_status")}</div>
            </div>
            <div className={cls("realized_work")}>
              <label htmlFor="realized_work">Сделано за период</label>
              <textarea id="realized_work" className="textarea" rows={3} {...register("realized_work")} />
              <div className="error">{err("realized_work")}</div>
            </div>
            <div className={cls("period_plan")}>
              <label htmlFor="period_plan">Планы на период</label>
              <textarea id="period_plan" className="textarea" rows={3} {...register("period_plan")} />
              <div className="error">{err("period_plan")}</div>
            </div>
          </div>

          <div className="col">
            <div className="row2">
              <div className={cls("stage")}>
                <label htmlFor="stage">Стадия системы (совместимость) {req}</label>
                <select
                  id="stage"
                  className="select"
                  {...register("stage", { onChange: (e) => onStageChange(e.target.value as Stage) })}
                >
                  {refs?.stages.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
                <div className="error">{err("stage")}</div>
              </div>
              <div className={cls("probability")}>
                <label htmlFor="probability">Вероятность, % {req}</label>
                <input
                  id="probability"
                  className="input"
                  inputMode="numeric"
                  readOnly={Boolean(values.customer_stage_id)}
                  {...register("probability")}
                />
                <div className={values.customer_stage_id ? "hint" : "error"}>
                  {values.customer_stage_id ? "Определяется выбранным этапом по ТЗ" : err("probability")}
                </div>
              </div>
            </div>

            <div className="row2">
              <div className={cls("amount")}>
                <label htmlFor="amount">Сумма контракта, ₽ {req}</label>
                <input id="amount" className="input" inputMode="decimal" placeholder="1 500 000" {...register("amount")} />
                <div className="error">{err("amount")}</div>
              </div>
              <div className={cls("cost")}>
                <label htmlFor="cost">Себестоимость, ₽</label>
                <input id="cost" className="input" inputMode="decimal" placeholder="0" {...register("cost")} />
                <div className="error">{err("cost")}</div>
              </div>
            </div>

            <div className="field">
              <label>Маржа (рассчитывается автоматически)</label>
              <input
                className="input"
                readOnly
                tabIndex={-1}
                value={
                  margin === null
                    ? "—"
                    : `${moneyFull(margin)}${amount ? ` · ${((margin / amount) * 100).toFixed(1)}%` : ""}`
                }
                style={{ color: margin !== null && margin < 0 ? "var(--bad)" : undefined }}
              />
              <div className="hint" style={{ color: margin !== null && margin < 0 ? "var(--warn)" : undefined }}>
                {margin !== null && margin < 0 ? "Себестоимость выше суммы контракта" : ""}
              </div>
            </div>

            <div className="row2">
              <div className={cls("start_date")}>
                <label htmlFor="start_date">Дата начала {req}</label>
                <input
                  id="start_date"
                  type="date"
                  className="input"
                  {...register("start_date", {
                    onChange: () => touchedFields.expected_close_date && trigger("expected_close_date"),
                  })}
                />
                <div className="error">{err("start_date")}</div>
              </div>
              <div className={cls("expected_close_date")}>
                <label htmlFor="expected_close_date">Плановое закрытие {req}</label>
                <input
                  id="expected_close_date"
                  type="date"
                  className="input"
                  min={values.start_date}
                  {...register("expected_close_date")}
                />
                <div className="error">{err("expected_close_date")}</div>
              </div>
            </div>

            {project?.closed_at && (
              <div className="muted" style={{ fontSize: 13 }}>
                Закрыт {date(project.closed_at)}
              </div>
            )}
          </div>
        </div>
      </fieldset>

      <fieldset className="fieldset" disabled={readOnly}>
        <legend>Помесячная выручка и затраты</legend>
        <p className="hint">Сумма вводится в тыс. ₽. Выберите, включает ли сумма НДС; налог автоматически не пересчитывается.</p>
        {financialEntries.map((entry, index) => {
          const set = (patch: Partial<FinancialEntry>) => setFinancialEntries((items) => items.map((item, i) => i === index ? { ...item, ...patch } : item));
          return <div className="row2" key={entry.id ?? `entry-${index}`} style={{ marginBottom: 10 }}>
            <select className="select" value={entry.kind} onChange={(e) => set({ kind: e.target.value as FinancialEntry["kind"], status_id: undefined, article_id: undefined, cost_type_id: undefined })}>
              <option value="revenue">Выручка</option><option value="cost">Затраты</option>
            </select>
            <input className="input" type="number" min="1900" max="2200" value={entry.year} aria-label="Год" onChange={(e) => set({ year: Number(e.target.value) })} />
            <select className="select" value={entry.month} aria-label="Месяц" onChange={(e) => set({ month: Number(e.target.value) })}>
              {Array.from({ length: 12 }, (_, i) => <option key={i + 1} value={i + 1}>{new Intl.DateTimeFormat("ru", { month: "long" }).format(new Date(2020, i, 1))}</option>)}
            </select>
            <input className="input" type="number" min="0" step="0.001" value={entry.amount} placeholder="тыс. ₽" aria-label="Сумма, тыс. рублей" onChange={(e) => set({ amount: e.target.value })} />
            <select className="select" value={entry.vat_included ? "yes" : "no"} aria-label="НДС" onChange={(e) => set({ vat_included: e.target.value === "yes" })}>
              <option value="yes">С НДС</option><option value="no">Без НДС</option>
            </select>
            {entry.kind === "revenue" ? <select className="select" value={entry.status_id ?? ""} aria-label="Статус начисления выручки" onChange={(e) => set({ status_id: Number(e.target.value) })}>
              <option value="">Статус выручки</option>{refs?.revenue_statuses.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select> : <>
              <select className="select" value={entry.article_id ?? ""} aria-label="Статья затрат" onChange={(e) => set({ article_id: Number(e.target.value) })}>
                <option value="">Статья затрат</option>{refs?.cost_articles.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select>
              <select className="select" value={entry.cost_type_id ?? ""} aria-label="Вид затрат" onChange={(e) => set({ cost_type_id: Number(e.target.value) })}>
                <option value="">Вид затрат</option>{refs?.cost_types.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select>
              <select className="select" value={entry.status_id ?? ""} aria-label="Статус затрат" onChange={(e) => set({ status_id: Number(e.target.value) })}>
                <option value="">Статус затрат</option>{refs?.cost_statuses.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select>
            </>}
            <button type="button" className="btn" onClick={() => setFinancialEntries((items) => items.filter((_, i) => i !== index))}>Удалить</button>
          </div>;
        })}
        <button type="button" className="btn" onClick={() => setFinancialEntries((items) => [...items, { kind: "revenue", year: new Date().getFullYear(), month: new Date().getMonth() + 1, amount: "", vat_included: true }])}>Добавить финансовую строку</button>
      </fieldset>

      <div className="form-footer">
        {formError && <span className="alert">{formError}</span>}
        {!formError && errorCount > 0 && (
          <span className="error" style={{ color: "var(--bad)", fontSize: 13 }}>
            Исправьте поля, отмеченные красным: {errorCount}
          </span>
        )}
        {savedAt && !isDirty && <span className="ok" style={{ color: "var(--good)" }}>Сохранено в {savedAt}</span>}
        {isNew && isDirty && <span className="muted" style={{ fontSize: 12 }}>Черновик сохраняется автоматически</span>}
        <div className="spacer" />
        <button type="button" className="btn" onClick={() => router.push("/projects")}>
          К списку
        </button>
        {!readOnly && (
          <button type="submit" className="btn primary" disabled={isSubmitting || nameTaken || (!isNew && !isDirty && !financialDirty)}>
            {isSubmitting ? "Сохраняем…" : isNew ? "Создать проект" : "Сохранить"}
          </button>
        )}
      </div>
    </form>
  );
}
