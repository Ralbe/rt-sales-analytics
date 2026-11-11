"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { QueryState } from "@/components/QueryState";
import { api, post, put, ApiError } from "@/lib/api";
import { useMe } from "@/lib/hooks";

interface ReferenceValue {
  id: number;
  category: string;
  code: string;
  name: string;
  is_active: boolean;
  position: number;
  probability: number | null;
}

export default function ReferenceSettings() {
  const me = useMe();
  if (!me.data) {
    return (
      <div className="page-body reference-page">
        <QueryState query={me} title="Не удалось проверить права доступа" />
      </div>
    );
  }
  if (me.data.role !== "admin") {
    return (
      <div className="page-body reference-page">
        <h1>Справочники</h1>
        <p className="alert" role="alert">Раздел доступен только администратору.</p>
      </div>
    );
  }
  return <AdminReferences />;
}

function AdminReferences() {
  const client = useQueryClient();
  const [category, setCategory] = useState("payment_type");
  const [name, setName] = useState("");
  const [success, setSuccess] = useState("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Модальные состояния для customer_stage
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createProb, setCreateProb] = useState("10");
  const [createPos, setCreatePos] = useState("1");

  const [editTarget, setEditTarget] = useState<ReferenceValue | null>(null);
  const [editName, setEditName] = useState("");
  const [editProb, setEditProb] = useState("0");

  const [deactivateTarget, setDeactivateTarget] = useState<ReferenceValue | null>(null);

  const [activateTarget, setActivateTarget] = useState<ReferenceValue | null>(null);
  const [activateName, setActivateName] = useState("");
  const [activateProb, setActivateProb] = useState("0");
  const [activatePos, setActivatePos] = useState("1");

  const [pendingMove, setPendingMove] = useState<{ stage: ReferenceValue; toPosition: number } | null>(null);
  const [draggedId, setDraggedId] = useState<number | null>(null);

  const categories = useQuery({
    queryKey: ["reference-categories"],
    queryFn: () => api<Record<string, string>>("/reference-admin"),
  });
  const values = useQuery({
    queryKey: ["reference-admin", category],
    queryFn: () => api<ReferenceValue[]>(`/reference-admin/${category}`),
  });

  const invalidateAll = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: ["reference-admin"] }),
      client.invalidateQueries({ queryKey: ["refs"] }),
    ]);
  };

  const mutation = useMutation({
    mutationFn: async (action: { id?: number; name?: string; active?: boolean }) => {
      setSuccess("");
      setErrorMsg(null);
      if (action.id === undefined) return post<ReferenceValue>(`/reference-admin/${category}`, { name: action.name });
      if (action.name !== undefined) {
        return put<ReferenceValue>(`/reference-admin/${category}/${action.id}/name`, { name: action.name });
      }
      return put<ReferenceValue>(`/reference-admin/${category}/${action.id}/active`, { is_active: action.active });
    },
    onSuccess: async () => {
      setName("");
      setSuccess("Изменения сохранены.");
      await invalidateAll();
    },
  });

  const stageMutation = useMutation({
    mutationFn: async (
      action:
        | { kind: "create"; name: string; probability: number; position: number }
        | { kind: "edit"; id: number; name: string; probability: number }
        | { kind: "deactivate"; id: number }
        | { kind: "activate"; id: number; name: string; probability: number; position: number }
        | { kind: "move"; id: number; position: number; expected_position: number },
    ) => {
      setSuccess("");
      setErrorMsg(null);
      if (action.kind === "create") {
        return post<ReferenceValue>("/reference-admin/customer_stage", {
          name: action.name,
          probability: action.probability,
          position: action.position,
        });
      }
      if (action.kind === "edit") {
        return put<ReferenceValue>(`/reference-admin/customer_stage/${action.id}`, {
          name: action.name,
          probability: action.probability,
        });
      }
      if (action.kind === "deactivate") {
        return put<ReferenceValue>(`/reference-admin/customer_stage/${action.id}/active`, {
          is_active: false,
        });
      }
      if (action.kind === "activate") {
        return put<ReferenceValue>(`/reference-admin/customer_stage/${action.id}/active`, {
          is_active: true,
          name: action.name,
          probability: action.probability,
          position: action.position,
        });
      }
      return put<ReferenceValue>(`/reference-admin/customer_stage/${action.id}/position`, {
        position: action.position,
        expected_position: action.expected_position,
      });
    },
    onSuccess: async () => {
      setCreateOpen(false);
      setEditTarget(null);
      setDeactivateTarget(null);
      setActivateTarget(null);
      setPendingMove(null);
      setSuccess("Изменения этапов сохранены.");
      await invalidateAll();
    },
    onError: (err) => {
      setErrorMsg(err instanceof ApiError ? err.message : "Не удалось сохранить изменения этапа.");
    },
  });

  const isStageTab = category === "customer_stage";
  const stageList = isStageTab ? (values.data ?? []) : [];
  const maxMovablePos = Math.max(1, stageList.length - 1);
  const busy = mutation.isPending || stageMutation.isPending;

  const switchCategory = (nextCategory: string) => {
    setCategory(nextCategory);
    setSuccess("");
    setErrorMsg(null);
    mutation.reset();
    stageMutation.reset();
  };

  const openCreateModal = () => {
    setErrorMsg(null);
    setCreateName("");
    setCreateProb("10");
    setCreatePos(String(Math.max(1, stageList.length)));
    setCreateOpen(true);
  };

  const submitCreateStage = () => {
    const trimmed = createName.trim();
    const prob = Number(createProb);
    const pos = Number(createPos);
    if (trimmed.length < 2) {
      setErrorMsg("Название этапа должно содержать минимум 2 символа.");
      return;
    }
    if (!Number.isInteger(prob) || prob < 0 || prob > 100 || createProb.trim() === "") {
      setErrorMsg("Вероятность должна быть целым числом от 0 до 100.");
      return;
    }
    if (!Number.isInteger(pos) || pos < 1 || pos > Math.max(1, stageList.length)) {
      setErrorMsg("Выберите допустимую позицию перед системным этапом «Успех».");
      return;
    }
    stageMutation.mutate({ kind: "create", name: trimmed, probability: prob, position: pos });
  };

  const submitEditStage = () => {
    if (!editTarget) return;
    const trimmed = editName.trim();
    const prob = Number(editProb);
    if (trimmed.length < 2) {
      setErrorMsg("Название этапа должно содержать минимум 2 символа.");
      return;
    }
    if (!Number.isInteger(prob) || prob < 0 || prob > 100 || editProb.trim() === "") {
      setErrorMsg("Вероятность должна быть целым числом от 0 до 100.");
      return;
    }
    stageMutation.mutate({ kind: "edit", id: editTarget.id, name: trimmed, probability: prob });
  };

  const submitActivateStage = () => {
    if (!activateTarget) return;
    const trimmed = activateName.trim();
    const prob = Number(activateProb);
    const pos = Number(activatePos);
    if (trimmed.length < 2) {
      setErrorMsg("Название этапа должно содержать минимум 2 символа.");
      return;
    }
    if (!Number.isInteger(prob) || prob < 0 || prob > 100 || activateProb.trim() === "") {
      setErrorMsg("Вероятность должна быть целым числом от 0 до 100.");
      return;
    }
    if (!Number.isInteger(pos) || pos < 1 || pos > maxMovablePos) {
      setErrorMsg("Выберите допустимую позицию перед системным этапом «Успех».");
      return;
    }
    stageMutation.mutate({
      kind: "activate",
      id: activateTarget.id,
      name: trimmed,
      probability: prob,
      position: pos,
    });
  };

  const activeError =
    errorMsg ??
    (mutation.error
      ? mutation.error instanceof ApiError
        ? mutation.error.message
        : "Не удалось сохранить значение."
      : null);

  return (
    <>
      <div className="page-header">
        <h1>Справочники</h1>
      </div>
      <div className="page-body reference-page">
        <div role="tablist" aria-label="Разделы справочников" style={{ display: "flex", gap: 8, marginBottom: 16 }}>
          <button
            type="button"
            role="tab"
            aria-selected={!isStageTab}
            className={`btn ${!isStageTab ? "primary" : ""}`}
            disabled={busy}
            onClick={() => switchCategory(isStageTab ? "payment_type" : category)}
          >
            Значения справочников
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={isStageTab}
            className={`btn ${isStageTab ? "primary" : ""}`}
            disabled={busy}
            onClick={() => switchCategory("customer_stage")}
          >
            Этапы проектов
          </button>
        </div>

        <p>Неактивные значения сохраняются в существующих карточках и недоступны для новых назначений.</p>
        <QueryState query={categories} title="Не удалось загрузить справочники" />
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 16 }}>
          <label htmlFor="reference-category">Справочник</label>
          <select
            id="reference-category"
            className="select"
            value={category}
            disabled={busy}
            onChange={(e) => switchCategory(e.target.value)}
          >
            {Object.entries(categories.data ?? {}).map(([key, label]) => (
              <option key={key} value={key}>{label}</option>
            ))}
          </select>
          {isStageTab && (
            <button
              type="button"
              className="btn primary"
              disabled={busy}
              onClick={openCreateModal}
            >
              Добавить этап
            </button>
          )}
        </div>

        {!isStageTab && (
          <div className="reference-create" style={{ margin: "16px 0" }}>
            <label htmlFor="reference-new">Новое значение</label>{" "}
            <input
              id="reference-new"
              className="input"
              value={name}
              maxLength={100}
              onChange={(e) => setName(e.target.value)}
            />{" "}
            <button
              className="btn primary"
              disabled={busy || !name.trim()}
              onClick={() => mutation.mutate({ name })}
            >
              Добавить
            </button>
          </div>
        )}

        {success && <p className="alert info" role="status">{success}</p>}
        {activeError && <p className="alert" role="alert">{activeError}</p>}
        <QueryState query={values} title="Не удалось загрузить значения" />

        {values.data && !isStageTab && (
          <div className="card" style={{ overflowX: "auto" }}>
            <table className="table" aria-label="Значения справочника">
              <thead>
                <tr>
                  <th>Название</th>
                  <th>Состояние</th>
                  <th>Действия</th>
                </tr>
              </thead>
              <tbody>
                {values.data.map((item) => (
                  <ReferenceRow
                    key={`${item.id}:${item.name}`}
                    item={item}
                    disabled={busy}
                    save={(action) => mutation.mutate({ id: item.id, ...action })}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}

        {values.data && isStageTab && (
          <div className="card" style={{ overflowX: "auto" }}>
            <table className="table" aria-label="Этапы проектов">
              <thead>
                <tr>
                  <th>Позиция</th>
                  <th>Название</th>
                  <th>Вероятность, %</th>
                  <th>Состояние</th>
                  <th>Действия</th>
                </tr>
              </thead>
              <tbody>
                {stageList.map((item) => {
                  const isSuccessStage = item.code === "success";
                  const canMoveUp = !isSuccessStage && item.position > 1 && !busy;
                  const canMoveDown = !isSuccessStage && item.position < maxMovablePos && !busy;
                  return (
                    <tr
                      key={item.id}
                      data-stage-id={item.id}
                      draggable={!isSuccessStage && !busy}
                      onDragStart={() => {
                        if (!isSuccessStage && !busy) setDraggedId(item.id);
                      }}
                      onDragOver={(e) => {
                        if (!isSuccessStage && draggedId !== null && draggedId !== item.id) {
                          e.preventDefault();
                        }
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        if (isSuccessStage || draggedId === null || draggedId === item.id) return;
                        const dragged = stageList.find((s) => s.id === draggedId);
                        setDraggedId(null);
                        if (dragged && dragged.code !== "success" && dragged.position !== item.position) {
                          setErrorMsg(null);
                          setPendingMove({ stage: dragged, toPosition: item.position });
                        }
                      }}
                      onDragEnd={() => setDraggedId(null)}
                    >
                      <td>{item.position}</td>
                      <td>
                        <span>{item.name}</span>
                        {isSuccessStage && (
                          <span
                            className="badge"
                            style={{
                              marginLeft: 8,
                              padding: "2px 8px",
                              borderRadius: 4,
                              fontSize: 12,
                              background: "var(--surface-2, #eef2ff)",
                            }}
                          >
                            Системный / Успех
                          </span>
                        )}
                      </td>
                      <td>{item.probability ?? 0}%</td>
                      <td>{item.is_active ? "Активен" : "Отключён"}</td>
                      <td style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                        <button
                          type="button"
                          className="btn small"
                          aria-label={`Переместить выше: ${item.name}`}
                          disabled={!canMoveUp}
                          onClick={() => {
                            setErrorMsg(null);
                            setPendingMove({ stage: item, toPosition: item.position - 1 });
                          }}
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          className="btn small"
                          aria-label={`Переместить ниже: ${item.name}`}
                          disabled={!canMoveDown}
                          onClick={() => {
                            setErrorMsg(null);
                            setPendingMove({ stage: item, toPosition: item.position + 1 });
                          }}
                        >
                          ↓
                        </button>
                        <button
                          type="button"
                          className="btn small"
                          aria-label={`Редактировать: ${item.name}`}
                          disabled={busy}
                          onClick={() => {
                            setErrorMsg(null);
                            setEditTarget(item);
                            setEditName(item.name);
                            setEditProb(String(item.probability ?? 0));
                          }}
                        >
                          Редактировать
                        </button>
                        {item.is_active ? (
                          <button
                            type="button"
                            className="btn small"
                            aria-label={`Отключить: ${item.name}`}
                            disabled={busy || isSuccessStage}
                            onClick={() => {
                              setErrorMsg(null);
                              setDeactivateTarget(item);
                            }}
                          >
                            Отключить
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="btn small"
                            aria-label={`Включить: ${item.name}`}
                            disabled={busy}
                            onClick={() => {
                              setErrorMsg(null);
                              setActivateTarget(item);
                              setActivateName(item.name);
                              setActivateProb(String(item.probability ?? 0));
                              setActivatePos(String(Math.min(item.position, maxMovablePos)));
                            }}
                          >
                            Включить
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Модальное окно создания этапа */}
        {createOpen && (
          <div className="modal-backdrop" style={backdropStyle}>
            <div className="card" role="dialog" aria-modal="true" aria-label="Добавить этап" style={modalStyle}>
              <h2 style={{ marginTop: 0 }}>Добавить этап</h2>
              <div className="field" style={{ marginBottom: 12 }}>
                <label htmlFor="stage-create-name">Название этапа</label>
                <input
                  id="stage-create-name"
                  className="input"
                  value={createName}
                  maxLength={100}
                  onChange={(e) => setCreateName(e.target.value)}
                />
              </div>
              <div className="field" style={{ marginBottom: 12 }}>
                <label htmlFor="stage-create-probability">Вероятность (%)</label>
                <input
                  id="stage-create-probability"
                  className="input"
                  type="number"
                  min={0}
                  max={100}
                  value={createProb}
                  onChange={(e) => setCreateProb(e.target.value)}
                />
              </div>
              <div className="field" style={{ marginBottom: 16 }}>
                <label htmlFor="stage-create-position">Позиция в списке</label>
                <select
                  id="stage-create-position"
                  className="select"
                  value={createPos}
                  onChange={(e) => setCreatePos(e.target.value)}
                >
                  {Array.from({ length: Math.max(1, stageList.length) }, (_, idx) => idx + 1).map((pos) => (
                    <option key={pos} value={pos}>
                      Позиция {pos} (перед «{stageList[pos - 1]?.name ?? "Успех"}»)
                    </option>
                  ))}
                </select>
              </div>
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <button type="button" className="btn" disabled={busy} onClick={() => setCreateOpen(false)}>
                  Отмена
                </button>
                <button type="button" className="btn primary" disabled={busy} onClick={submitCreateStage}>
                  Создать этап
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Модальное окно редактирования этапа */}
        {editTarget && (
          <div className="modal-backdrop" style={backdropStyle}>
            <div className="card" role="dialog" aria-modal="true" aria-label="Редактировать этап" style={modalStyle}>
              <h2 style={{ marginTop: 0 }}>Редактировать этап</h2>
              <p className="hint">
                Изменение вероятности в справочнике не пересчитывает вероятность уже сохранённых проектов.
              </p>
              <div className="field" style={{ marginBottom: 12 }}>
                <label htmlFor="stage-edit-name">Название этапа</label>
                <input
                  id="stage-edit-name"
                  className="input"
                  value={editName}
                  maxLength={100}
                  onChange={(e) => setEditName(e.target.value)}
                />
              </div>
              <div className="field" style={{ marginBottom: 16 }}>
                <label htmlFor="stage-edit-probability">Вероятность (%)</label>
                <input
                  id="stage-edit-probability"
                  className="input"
                  type="number"
                  min={0}
                  max={100}
                  value={editProb}
                  onChange={(e) => setEditProb(e.target.value)}
                />
              </div>
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <button type="button" className="btn" disabled={busy} onClick={() => setEditTarget(null)}>
                  Отмена
                </button>
                <button type="button" className="btn primary" disabled={busy} onClick={submitEditStage}>
                  Сохранить
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Модальное окно подтверждения отключения этапа */}
        {deactivateTarget && (
          <div className="modal-backdrop" style={backdropStyle}>
            <div className="card" role="dialog" aria-modal="true" aria-label="Отключить этап" style={modalStyle}>
              <h2 style={{ marginTop: 0 }}>Отключить этап «{deactivateTarget.name}»?</h2>
              <p>
                Отключённый этап сохранится в текущих проектах, истории изменений, графике Ганта и аналитике, но не
                сможет быть назначен новым или переводимым проектам.
              </p>
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
                <button type="button" className="btn" disabled={busy} onClick={() => setDeactivateTarget(null)}>
                  Отмена
                </button>
                <button
                  type="button"
                  className="btn primary"
                  disabled={busy}
                  onClick={() => stageMutation.mutate({ kind: "deactivate", id: deactivateTarget.id })}
                >
                  Подтвердить отключение
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Модальное окно повторного включения этапа */}
        {activateTarget && (
          <div className="modal-backdrop" style={backdropStyle}>
            <div className="card" role="dialog" aria-modal="true" aria-label="Включить этап" style={modalStyle}>
              <h2 style={{ marginTop: 0 }}>Включить этап «{activateTarget.name}»</h2>
              <div className="field" style={{ marginBottom: 12 }}>
                <label htmlFor="stage-activate-name">Название этапа</label>
                <input
                  id="stage-activate-name"
                  className="input"
                  value={activateName}
                  maxLength={100}
                  onChange={(e) => setActivateName(e.target.value)}
                />
              </div>
              <div className="field" style={{ marginBottom: 12 }}>
                <label htmlFor="stage-activate-probability">Вероятность (%)</label>
                <input
                  id="stage-activate-probability"
                  className="input"
                  type="number"
                  min={0}
                  max={100}
                  value={activateProb}
                  onChange={(e) => setActivateProb(e.target.value)}
                />
              </div>
              <div className="field" style={{ marginBottom: 16 }}>
                <label htmlFor="stage-activate-position">Позиция в списке</label>
                <select
                  id="stage-activate-position"
                  className="select"
                  value={activatePos}
                  onChange={(e) => setActivatePos(e.target.value)}
                >
                  {Array.from({ length: maxMovablePos }, (_, idx) => idx + 1).map((pos) => (
                    <option key={pos} value={pos}>
                      Позиция {pos}
                    </option>
                  ))}
                </select>
              </div>
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <button type="button" className="btn" disabled={busy} onClick={() => setActivateTarget(null)}>
                  Отмена
                </button>
                <button type="button" className="btn primary" disabled={busy} onClick={submitActivateStage}>
                  Подтвердить включение
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Модальное окно подтверждения перемещения этапа */}
        {pendingMove && (
          <div
            className="modal-backdrop"
            style={backdropStyle}
          >
            <div
              className="card"
              role="dialog"
              aria-modal="true"
              aria-label="Подтверждение изменения порядка этапов"
              style={modalStyle}
            >
              <h2 style={{ marginTop: 0 }}>Изменить позицию этапа?</h2>
              <p>
                Этап: <strong>{pendingMove.stage.name}</strong>
              </p>
              <p>
                Старая позиция: <strong>{pendingMove.stage.position}</strong> → Новая позиция:{" "}
                <strong>{pendingMove.toPosition}</strong>
              </p>
              <p className="hint">
                Новый порядок применяется только к будущим переходам проектов. Прошлые переходы и история сохраняют
                прежнее направление.
              </p>
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
                <button type="button" className="btn" disabled={busy} onClick={() => setPendingMove(null)}>
                  Отмена
                </button>
                <button
                  type="button"
                  className="btn primary"
                  disabled={busy}
                  onClick={() =>
                    stageMutation.mutate({
                      kind: "move",
                      id: pendingMove.stage.id,
                      position: pendingMove.toPosition,
                      expected_position: pendingMove.stage.position,
                    })
                  }
                >
                  Подтвердить перемещение
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

const backdropStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(15, 23, 42, 0.45)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
  padding: 16,
};

const modalStyle: React.CSSProperties = {
  width: "100%",
  maxWidth: 480,
  maxHeight: "calc(var(--viewport-height) - 32px)",
  overflowY: "auto",
  padding: 24,
};

function ReferenceRow({
  item,
  disabled,
  save,
}: {
  item: ReferenceValue;
  disabled: boolean;
  save: (action: { name?: string; active?: boolean }) => void;
}) {
  const [name, setName] = useState(item.name);
  return (
    <tr>
      <td>
        <input
          className="input"
          aria-label={`Название: ${item.name}`}
          value={name}
          maxLength={100}
          disabled={disabled}
          onChange={(e) => setName(e.target.value)}
        />
      </td>
      <td>{item.is_active ? "Активно" : "Неактивно"}</td>
      <td>
        <button
          className="btn small"
          disabled={disabled || !name.trim() || name.trim() === item.name}
          onClick={() => save({ name })}
        >
          Переименовать
        </button>{" "}
        <button className="btn small" disabled={disabled} onClick={() => save({ active: !item.is_active })}>
          {item.is_active ? "Деактивировать" : "Восстановить"}
        </button>
      </td>
    </tr>
  );
}
