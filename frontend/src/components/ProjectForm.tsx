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
import { useProjectFieldLabels } from "@/lib/project-field-labels";
import { projectHistoryKey } from "@/lib/history-types";
import type { FinancialEntry, Project } from "@/lib/types";

const DRAFT_KEY = "project-draft";
const STAGES = ["lead", "qualification", "proposal", "negotiation", "won", "lost"] as const;
// Как Pydantic и PostgreSQL, считаем символы Unicode, а не кодовые единицы UTF-16.
const projectText = z.string().refine((v) => Array.from(v).length <= 1000, "Не длиннее 1000 символов");

const toNumber = (v: string) => Number(v.replace(/\s/g, "").replace(",", "."));
const isNumber = (v: string) => v.trim() !== "" && Number.isFinite(toNumber(v));
const money = (label: string, required: boolean) =>
  z
    .string()
    .refine((v) => !required || v.trim() !== "", `Введите ${label}`)
    .refine((v) => v.trim() === "" || isNumber(v), "Введите число, например 1 500 000")
    .refine((v) => v.trim() === "" || toNumber(v) >= 0, "Не может быть отрицательной")
    .refine((v) => v.trim() === "" || toNumber(v) <= 999999999999.99, "Слишком большая сумма")
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
    stage: z.union([z.enum(STAGES), z.literal("")]),
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
    project_status: projectText,
    realized_work: projectText,
    period_plan: projectText,
    probability: z
      .string()
      .refine((v) => v === "" || (/^\d{1,3}$/.test(v.trim()) && Number(v) <= 100), "Целое число от 0 до 100"),
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

function projectSchema(customerScheme: boolean) {
  return schema
    .refine((v) => customerScheme ? v.customer_stage_id !== "" : v.stage !== "", {
      path: [customerScheme ? "customer_stage_id" : "stage"],
      message: customerScheme ? "Выберите этап проекта" : "Выберите стадию",
    })
    .refine((v) => customerScheme || v.probability !== "", {
      path: ["probability"], message: "Целое число от 0 до 100",
    });
}

// Ошибки сервера приходят по именам полей API — сопоставляем с полями формы
const SERVER_FIELD: Record<string, keyof FormValues> = { client_id: "client" };

function fromProject(p?: Project, defaultManager?: number): FormValues {
  return {
    name: p?.name ?? "",
    client: p ? { id: p.client.id, name: p.client.name, segment: p.segment.name } : null,
    service_id: p ? String(p.service.id) : "",
    manager_id: p ? String(p.manager.id) : defaultManager ? String(defaultManager) : "",
    stage: p?.stage ?? "",
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
    probability: p ? String(p.probability) : "",
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

export function ProjectForm({ project, readOnly = false }: { project?: Project; readOnly?: boolean }) {
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
      {refsQuery.data && <ProjectFormInner project={project} readOnly={readOnly} />}
    </>
  );
}

function ProjectFormInner({ project, readOnly: forcedReadOnly }: { project?: Project; readOnly: boolean }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data: me } = useMe();
  const { data: refs } = useRefs();
  const { label, heading } = useProjectFieldLabels();
  const isNew = !project;
  const customerScheme = isNew || project.stage_scheme === "customer";
  const isUser = me?.role === "user";
  const readOnly = forcedReadOnly || !canEditProjects(me?.role);

  const [formError, setFormError] = useState<string | null>(null);
  const [nameTaken, setNameTaken] = useState(false);
  const [draftRestored, setDraftRestored] = useState(false);
  const draftLoadedRef = useRef(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [pendingProjectId, setPendingProjectId] = useState<number | null>(null);
  const persistedIdRef = useRef(project?.id);
  const savingRef = useRef(false);
  const persistedId = project?.id ?? pendingProjectId;
  const financialBaseline = useRef(financialRowsFromProject(project));
  const [financialEntries, setFinancialEntries] = useState<FinancialEntry[]>(financialBaseline.current);
  const financialDirty = JSON.stringify(financialEntries) !== JSON.stringify(financialBaseline.current);

  const { register, control, handleSubmit, reset, setValue, setError, trigger, getValues, watch, formState } =
    useForm<FormValues>({
      resolver: zodResolver(projectSchema(customerScheme)),
      mode: "onTouched", // ошибка появляется, как только пользователь ушёл с поля
      defaultValues: fromProject(project, me?.id),
    });
  const { errors, isSubmitting, isDirty, touchedFields } = formState;
  const hasUnsavedChanges = isDirty || financialDirty;

  // Фоновое обновление не должно затирать несохранённый ввод.
  useEffect(() => {
    if (!project || hasUnsavedChanges || isSubmitting) return;
    financialBaseline.current = financialRowsFromProject(project);
    setFinancialEntries(financialBaseline.current);
    reset(fromProject(project));
  }, [project, hasUnsavedChanges, isSubmitting, reset]);

  // Восстановление черновика новой карточки
  useEffect(() => {
    if (!isNew || draftLoadedRef.current) return;
    draftLoadedRef.current = true;
    const draft = loadDraft();
    if (draft) {
      // Старый черновик не переносит шестистадийную схему в новый проект.
      const stage = refs?.customer_stages.find((item) => String(item.id) === draft.customer_stage_id);
      reset({ ...draft, stage: "", probability: stage ? String(stage.probability) : "" }, { keepDefaultValues: true });
      setDraftRestored(true);
    }
  }, [isNew, reset, refs?.customer_stages]);

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
      query: { name: name.trim(), client_id: client.id, exclude_id: persistedId },
    }).catch(() => ({ available: true }));
    setNameTaken(!r.available);
  }, [getValues, persistedId]);

  useEffect(() => {
    if (values.client?.id) checkName();
  }, [values.client?.id, checkName]);

  const onCustomerStageChange = (stageId: string) => {
    const stage = refs?.customer_stages.find((item) => String(item.id) === stageId);
    const retainedStage = project?.stage_scheme === "customer" && stageId === String(project.customer_stage?.id);
    const probability = retainedStage ? String(project.probability) : stage ? String(stage.probability) : "";
    setValue("probability", probability, { shouldValidate: true });
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
      ...(customerScheme
        ? { customer_stage_id: Number(v.customer_stage_id) }
        : { stage: v.stage, probability: Number(v.probability) }),
      amount: toNumber(v.amount).toFixed(2),
      cost: (v.cost.trim() ? toNumber(v.cost) : 0).toFixed(2),
      start_date: v.start_date,
      expected_close_date: v.expected_close_date,
      payment_type_id: v.payment_type_id ? Number(v.payment_type_id) : null,
      indicator_id: v.indicator_id ? Number(v.indicator_id) : null,
      accepted_for_forecast: v.accepted_for_forecast,
      assessment_status_id: v.accepted_for_forecast && v.assessment_status_id ? Number(v.assessment_status_id) : null,
      subsidiary_implementation: v.subsidiary_implementation,
      management_control: v.management_control,
      is_industry_solution: v.is_industry_solution,
      industry_manager: v.is_industry_solution ? v.industry_manager.trim() || null : null,
      industry_project_number: v.is_industry_solution ? v.industry_project_number.trim() || null : null,
      implementation_year: v.implementation_year ? Number(v.implementation_year) : null,
      project_status: v.project_status || null,
      realized_work: v.realized_work,
      period_plan: v.period_plan,
      financial_entries: financialEntries.map((entry) => ({
        id: entry.id ?? null, kind: entry.kind, year: Number(entry.year), month: Number(entry.month), amount: entry.amount,
        vat_included: entry.vat_included, status_id: Number(entry.status_id),
        article_id: entry.kind === "cost" ? Number(entry.article_id) : null,
        cost_type_id: entry.kind === "cost" ? Number(entry.cost_type_id) : null,
      })),
    };
    const projectId = project?.id ?? persistedIdRef.current;
    let saved: Project;
    try {
      saved = projectId
        ? await put<Project>(`/projects/${projectId}`, body)
        : await post<Project>("/projects", body);
    } catch (e) {
      const uncertainCreation = !projectId && (!(e instanceof ApiError) || e.status === 0 || e.status >= 500 || (e.status >= 200 && e.status < 300))
        ? "Не удалось подтвердить создание проекта. Проверьте список проектов перед повтором: проект мог быть создан. "
        : "";
      if (!(e instanceof ApiError)) return setFormError(uncertainCreation + "Сервер недоступен, попробуйте ещё раз");
      const fields = Object.entries(e.fields);
      const financialErrors: string[] = [];
      fields.forEach(([f, message]) => {
        const field = SERVER_FIELD[f] ?? f;
        if (field in v) setError(field as keyof FormValues, { type: "server", message });
        else financialErrors.push(message);
      });
      if (uncertainCreation || !fields.length || financialErrors.length) {
        setFormError(uncertainCreation + (financialErrors.length ? financialErrors.join(". ") : e.message));
      }
      return;
    }

    // Ответ атомарного сохранения подтверждает и карточку, и полный список финансов.
    persistedIdRef.current = saved.id;
    if (isNew) setPendingProjectId(saved.id);
    const projectKey = ["project", String(saved.id)];
    await queryClient.cancelQueries({ queryKey: projectKey, exact: true });
    queryClient.setQueryData(projectKey, saved);
    financialBaseline.current = financialRowsFromProject(saved);
    setFinancialEntries(financialBaseline.current);
    reset(fromProject(saved));
    setSavedAt(new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }));
    if (isNew) {
      submittedRef.current = true;
      saveDraft(null);
      router.replace(`/projects/${saved.id}`);
    }
    // Ошибка фонового чтения не меняет результат уже подтверждённой записи.
    void queryClient.invalidateQueries({
      predicate: (query) => query.queryKey[0] !== "project-history" &&
        !(query.queryKey[0] === "project" && String(query.queryKey[1]) === String(saved.id)),
    }).catch(() => undefined);
    void queryClient.invalidateQueries({ queryKey: projectHistoryKey(saved.id) }).catch(() => undefined);
  });

  const clearDraft = () => {
    setPendingProjectId(null);
    persistedIdRef.current = undefined;
    setFormError(null);
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
    <form onSubmit={(event) => {
      if (savingRef.current) return event.preventDefault();
      savingRef.current = true;
      void submit(event).finally(() => { savingRef.current = false; });
    }} noValidate className="card" style={{ display: "flex", flexDirection: "column" }}>
      {draftRestored && (
        <div className="alert info" style={{ margin: "14px 20px 0", display: "flex", gap: 10, alignItems: "center" }}>
          Восстановлен несохранённый черновик.
          <button type="button" className="btn small" disabled={readOnly || isSubmitting} onClick={clearDraft}>
            Начать заново
          </button>
        </div>
      )}
      <fieldset disabled={readOnly || isSubmitting} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
        <div className="form-grid">
          <div className="col">
            <div className={`field ${err("name") || nameTaken ? "has-error" : ""}`}>
              <label htmlFor="name">{label("name")} {req}</label>
              <input id="name" className="input" {...register("name", { onBlur: checkName })} />
              <div className="error">
                {err("name") ?? (nameTaken ? "У этого клиента уже есть проект с таким названием" : "")}
              </div>
            </div>

            <div className={cls("client")}>
              <label htmlFor="client">{label("client_id")} {req}</label>
              <Controller
                control={control}
                name="client"
                render={({ field }) => (
                  <ClientCombobox
                    id="client"
                    value={field.value}
                    onChange={field.onChange}
                    onBlur={field.onBlur}
                    disabled={readOnly || isSubmitting}
                    allowCreate={!readOnly}
                  />
                )}
              />
              {err("client") ? (
                <div className="error">{err("client")}</div>
              ) : (
                <div className="hint">{values.client?.segment ? `${label("segment")}: ${values.client.segment}` : ""}</div>
              )}
            </div>

            <div className="row2">
              <div className={cls("service_id")}>
                <label htmlFor="service_id">{label("service_id")} {req}</label>
                <select id="service_id" className="select" {...register("service_id")}>
                  <option value="">— выберите —</option>
                  {project?.service && !refs?.services.some((item) => item.id === project.service.id) &&
                    <option value={project.service.id} disabled>{project.service.name} (неактивно)</option>}
                  {refs?.services.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.group_name ? `${s.group_name} — ${s.name}` : s.name}
                    </option>
                  ))}
                </select>
                <div className="error">{err("service_id")}</div>
              </div>
              <div className={cls("manager_id")}>
                <label htmlFor="manager_id">{label("manager_id")} {req}</label>
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
              <label htmlFor="description">{label("description")}</label>
              <textarea id="description" className="textarea" rows={4} {...register("description")} />
              <div className="error">{err("description")}</div>
            </div>

            <div className="row2">
              <div className={cls("payment_type_id")}>
                <label htmlFor="payment_type_id">{label("payment_type_id")}</label>
                <select id="payment_type_id" className="select" {...register("payment_type_id")}>
                  <option value="">— не указан —</option>
                  {project?.payment_type && !refs?.payment_types.some((item) => item.id === project.payment_type?.id) &&
                    <option value={project.payment_type.id} disabled>{project.payment_type.name} (неактивно)</option>}
                  {refs?.payment_types.map((item) => (
                    <option key={item.id} value={item.id}>{item.name}</option>
                  ))}
                </select>
                <div className="error">{err("payment_type_id")}</div>
              </div>
              <div className={cls("indicator_id")}>
                <label htmlFor="indicator_id">{label("indicator_id")}</label>
                <select id="indicator_id" className="select" {...register("indicator_id")}>
                  <option value="">— не указан —</option>
                  {project?.indicator && !refs?.project_indicators.some((item) => item.id === project.indicator?.id) &&
                    <option value={project.indicator.id} disabled>{project.indicator.name} (неактивно)</option>}
                  {refs?.project_indicators.map((item) => (
                    <option key={item.id} value={item.id}>{item.name}</option>
                  ))}
                </select>
                <div className="error">{err("indicator_id")}</div>
              </div>
            </div>

            <div className="row2">
              <div className={cls("customer_stage_id")}>
                <label htmlFor="customer_stage_id">{label("customer_stage_id")} {customerScheme && req}</label>
                {customerScheme ? <select
                  id="customer_stage_id"
                  className="select"
                  {...register("customer_stage_id", { onChange: (e) => onCustomerStageChange(e.target.value) })}
                >
                  <option value="">— выберите этап —</option>
                  {project?.customer_stage && !refs?.customer_stages.some((item) => item.id === project.customer_stage?.id) &&
                    <option value={project.customer_stage.id} disabled>{project.customer_stage.name} (неактивно)</option>}
                  {refs?.customer_stages.map((item) => (
                    <option key={item.id} value={item.id}>{item.name} ({item.probability}%)</option>
                  ))}
                </select> : <input id="customer_stage_id" className="input" readOnly value={project?.customer_stage?.name ?? "Не указан"} />}
                {customerScheme ? <div className="error">{err("customer_stage_id")}</div> :
                  <div className="hint">Сохранённый вспомогательный этап. Не изменяет прежнюю стадию и вероятность.</div>}
                {customerScheme && <div className="hint" role="note" data-completion-state="unknown">Состояние завершения: не определено</div>}
              </div>
              <div className={cls("implementation_year")}>
                <label htmlFor="implementation_year">{label("implementation_year")}</label>
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
                {label("accepted_for_forecast")}
              </label>
              <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input type="checkbox" {...register("subsidiary_implementation")} />
                {label("subsidiary_implementation")}
              </label>
              <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input type="checkbox" {...register("management_control")} />
                {label("management_control")}
              </label>
              <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input type="checkbox" {...register("is_industry_solution")} />
                {label("is_industry_solution")}
              </label>
            </div>

            {values.accepted_for_forecast && (
              <div className={cls("assessment_status_id")}>
                <label htmlFor="assessment_status_id">{label("assessment_status_id")}</label>
                <select id="assessment_status_id" className="select" {...register("assessment_status_id")}>
                  <option value="">— не указан —</option>
                  {project?.assessment_status && !refs?.assessment_statuses.some((item) => item.id === project.assessment_status?.id) &&
                    <option value={project.assessment_status.id} disabled>{project.assessment_status.name} (неактивно)</option>}
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
                  <label htmlFor="industry_manager">{label("industry_manager")}</label>
                  <input id="industry_manager" className="input" {...register("industry_manager")} />
                  <div className="error">{err("industry_manager")}</div>
                </div>
                <div className={cls("industry_project_number")}>
                  <label htmlFor="industry_project_number">{label("industry_project_number")}</label>
                  <input id="industry_project_number" className="input" {...register("industry_project_number")} />
                  <div className="error">{err("industry_project_number")}</div>
                </div>
              </div>
            )}

            <div className={cls("project_status")}>
              <label htmlFor="project_status">{label("project_status")}</label>
              <textarea id="project_status" className="textarea" rows={3} {...register("project_status")} />
              <div className="error">{err("project_status")}</div>
            </div>
            <div className={cls("realized_work")}>
              <label htmlFor="realized_work">{label("realized_work")}</label>
              <textarea id="realized_work" className="textarea" rows={3} {...register("realized_work")} />
              <div className="error">{err("realized_work")}</div>
            </div>
            <div className={cls("period_plan")}>
              <label htmlFor="period_plan">{label("period_plan")}</label>
              <textarea id="period_plan" className="textarea" rows={3} {...register("period_plan")} />
              <div className="error">{err("period_plan")}</div>
            </div>
          </div>

          <div className="col">
            <div className="row2">
              {!customerScheme && <div className={cls("stage")}>
                <label htmlFor="stage">{label("stage")} (совместимость) {req}</label>
                <select
                  id="stage"
                  className="select"
                  {...register("stage")}
                >
                  {!values.stage && <option value="">— выберите стадию —</option>}
                  {refs?.stages.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
                <div className="error">{err("stage")}</div>
              </div>}
              <div className={cls("probability")}>
                <label htmlFor="probability">{heading("probability")} {req}</label>
                <input
                  id="probability"
                  className="input"
                  inputMode="numeric"
                  readOnly={customerScheme}
                  {...register("probability")}
                />
                <div className={customerScheme ? "hint" : "error"}>
                  {customerScheme ? "Определяется сервером по выбранному этапу проекта" : err("probability")}
                </div>
              </div>
            </div>

            <div className="row2">
              <div className={cls("amount")}>
                <label htmlFor="amount">{heading("amount")} {req}</label>
                <input id="amount" className="input" inputMode="decimal" placeholder="1 500 000" {...register("amount")} />
                <div className="error">{err("amount")}</div>
              </div>
              <div className={cls("cost")}>
                <label htmlFor="cost">{heading("cost")}</label>
                <input id="cost" className="input" inputMode="decimal" placeholder="0" {...register("cost")} />
                <div className="error">{err("cost")}</div>
              </div>
            </div>

            <div className="field">
              <label>{label("margin")} (рассчитывается автоматически)</label>
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

            <div className="field">
              <label htmlFor="created_at">{label("created_at")}</label>
              <input
                id="created_at"
                className="input"
                readOnly
                value={project ? date(project.created_at) : "Будет назначена при создании"}
              />
            </div>

            <div className="row2">
              <div className={cls("start_date")}>
                <label htmlFor="start_date">{label("start_date")} {req}</label>
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
                <label htmlFor="expected_close_date">{label("expected_close_date")} {req}</label>
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
                {label("closed_at")} {date(project.closed_at)}
              </div>
            )}
          </div>
        </div>
      </fieldset>

      <fieldset className="fieldset" disabled={readOnly || isSubmitting}>
        <legend>{label("financial_entries")}</legend>
        <p className="hint">Сумма вводится в тыс. ₽. Выберите, включает ли сумма НДС; налог автоматически не пересчитывается.</p>
        {financialEntries.map((entry, index) => {
          const set = (patch: Partial<FinancialEntry>) => setFinancialEntries((items) => items.map((item, i) => i === index ? { ...item, ...patch } : item));
          return <div className="row2" key={entry.id ?? `entry-${index}`} style={{ marginBottom: 10 }}>
            <select className="select" value={entry.kind} onChange={(e) => set({ kind: e.target.value as FinancialEntry["kind"], status_id: undefined, article_id: undefined, cost_type_id: undefined })}>
              <option value="revenue">{label("financial_entries.revenue")}</option><option value="cost">{label("financial_entries.cost")}</option>
            </select>
            <input className="input" type="number" min="1900" max="2200" value={entry.year} aria-label={label("financial_entries.year")} onChange={(e) => set({ year: Number(e.target.value) })} />
            <select className="select" value={entry.month} aria-label={label("financial_entries.month")} onChange={(e) => set({ month: Number(e.target.value) })}>
              {Array.from({ length: 12 }, (_, i) => <option key={i + 1} value={i + 1}>{new Intl.DateTimeFormat("ru", { month: "long" }).format(new Date(2020, i, 1))}</option>)}
            </select>
            <input className="input" type="number" min="0" step="0.001" value={entry.amount} placeholder="тыс. ₽" aria-label={heading("financial_entries.amount")} onChange={(e) => set({ amount: e.target.value })} />
            <select className="select" value={entry.vat_included ? "yes" : "no"} aria-label={label("financial_entries.vat_included")} onChange={(e) => set({ vat_included: e.target.value === "yes" })}>
              <option value="yes">С НДС</option><option value="no">Без НДС</option>
            </select>
            {entry.kind === "revenue" ? <select className="select" value={entry.status_id ?? ""} aria-label={label("financial_entries.revenue_status")} onChange={(e) => set({ status_id: Number(e.target.value) })}>
              <option value="">{label("financial_entries.revenue_status")}</option>{entry.status && entry.status_id === entry.status.id && !refs?.revenue_statuses.some((x) => x.id === entry.status?.id) && <option value={entry.status.id} disabled>{entry.status.name} (неактивно)</option>}{refs?.revenue_statuses.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select> : <>
              <select className="select" value={entry.article_id ?? ""} aria-label={label("financial_entries.article_id")} onChange={(e) => set({ article_id: Number(e.target.value) })}>
                <option value="">{label("financial_entries.article_id")}</option>{entry.article && entry.article_id === entry.article.id && !refs?.cost_articles.some((x) => x.id === entry.article?.id) && <option value={entry.article.id} disabled>{entry.article.name} (неактивно)</option>}{refs?.cost_articles.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select>
              <select className="select" value={entry.cost_type_id ?? ""} aria-label={label("financial_entries.cost_type_id")} onChange={(e) => set({ cost_type_id: Number(e.target.value) })}>
                <option value="">{label("financial_entries.cost_type_id")}</option>{entry.cost_type && entry.cost_type_id === entry.cost_type.id && !refs?.cost_types.some((x) => x.id === entry.cost_type?.id) && <option value={entry.cost_type.id} disabled>{entry.cost_type.name} (неактивно)</option>}{refs?.cost_types.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select>
              <select className="select" value={entry.status_id ?? ""} aria-label={label("financial_entries.cost_status")} onChange={(e) => set({ status_id: Number(e.target.value) })}>
                <option value="">{label("financial_entries.cost_status")}</option>{entry.status && entry.status_id === entry.status.id && !refs?.cost_statuses.some((x) => x.id === entry.status?.id) && <option value={entry.status.id} disabled>{entry.status.name} (неактивно)</option>}{refs?.cost_statuses.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
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
        {savedAt && !hasUnsavedChanges && !isSubmitting && <span className="ok" style={{ color: "var(--good)" }}>Сохранено в {savedAt}</span>}
        {isNew && isDirty && <span className="muted" style={{ fontSize: 12 }}>Черновик сохраняется автоматически</span>}
        <div className="spacer" />
        <button type="button" className="btn" onClick={() => router.push("/projects")}>
          К списку
        </button>
        {!readOnly && (
          <button type="submit" className="btn primary" disabled={isSubmitting || nameTaken || (!isNew && !hasUnsavedChanges)}>
            {isSubmitting ? "Сохраняем…" : isNew ? pendingProjectId ? "Повторить сохранение" : "Создать проект" : "Сохранить"}
          </button>
        )}
      </div>
    </form>
  );
}
