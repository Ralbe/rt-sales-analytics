"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { z } from "zod";

import { ClientCombobox } from "@/components/ClientCombobox";
import { ApiError, api, post, put } from "@/lib/api";
import { date, moneyFull, today } from "@/lib/format";
import { canEditProjects, useMe, useRefs } from "@/lib/hooks";
import type { Project, Stage } from "@/lib/types";

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
    probability: String(p?.probability ?? 10),
    amount: p ? String(Number(p.amount)) : "",
    cost: p ? String(Number(p.cost)) : "",
    start_date: p?.start_date ?? today(),
    expected_close_date: p?.expected_close_date ?? "",
    description: p?.description ?? "",
  };
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
  const { data: refs } = useRefs();
  // Ждём справочники: иначе выпадающие списки не смогут показать восстановленные значения
  if (!refs) return <div className="muted">Загрузка…</div>;
  return <ProjectFormInner project={project} />;
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

  const { register, control, handleSubmit, reset, setValue, setError, trigger, getValues, watch, formState } =
    useForm<FormValues>({
      resolver: zodResolver(schema),
      mode: "onTouched", // ошибка появляется, как только пользователь ушёл с поля
      defaultValues: fromProject(project, me?.id),
    });
  const { errors, isSubmitting, isDirty, dirtyFields, touchedFields } = formState;

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
    const def = refs?.stages.find((s) => s.id === stage)?.probability;
    if (def !== undefined && !dirtyFields.probability) setValue("probability", String(def), { shouldValidate: true });
  };

  const submit = handleSubmit(async (v) => {
    setFormError(null);
    if (nameTaken) return;
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
    };
    try {
      const saved = project
        ? await put<Project>(`/projects/${project.id}`, body)
        : await post<Project>("/projects", body);
      await queryClient.invalidateQueries();
      if (isNew) {
        submittedRef.current = true;
        saveDraft(null);
        router.replace(`/projects/${saved.id}`);
      } else {
        queryClient.setQueryData(["project", String(saved.id)], saved);
        reset(fromProject(saved));
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
                      {s.name}
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
          </div>

          <div className="col">
            <div className="row2">
              <div className={cls("stage")}>
                <label htmlFor="stage">Стадия {req}</label>
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
                <input id="probability" className="input" inputMode="numeric" {...register("probability")} />
                <div className="error">{err("probability")}</div>
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
          <button type="submit" className="btn primary" disabled={isSubmitting || nameTaken || (!isNew && !isDirty)}>
            {isSubmitting ? "Сохраняем…" : isNew ? "Создать проект" : "Сохранить"}
          </button>
        )}
      </div>
    </form>
  );
}
