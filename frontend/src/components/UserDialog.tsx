"use client";

import { useEffect, useRef, useState } from "react";

import { ApiError, type FieldErrors } from "@/lib/api";
import { isValidUserEmail } from "@/lib/email";
import { ROLE_LABELS } from "@/lib/hooks";
import type { Role } from "@/lib/types";
import type { ManagedUser, UserSubmission } from "@/lib/user-types";

interface Props {
  user?: ManagedUser;
  currentUserId: number;
  onSave: (data: UserSubmission) => Promise<void>;
  onClose: () => void;
}

export function UserDialog({ user, currentUserId, onSave, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [email, setEmail] = useState(user?.email ?? "");
  const [fullName, setFullName] = useState(user?.full_name ?? "");
  const [role, setRole] = useState<Role>(user?.role ?? "user");
  const [active, setActive] = useState(user?.is_active ?? true);
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [fields, setFields] = useState<FieldErrors>({});
  const self = user?.id === currentUserId;

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);

  const fieldError = (field: string) => fields[field] && (
    <div className="error" id={`user-${field}-error`}>{fields[field]}</div>
  );

  return (
    <dialog
      ref={dialog}
      className="card"
      style={{ padding: 0, width: "calc(100% - 32px)", maxWidth: 460 }}
      aria-labelledby="user-dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) onClose();
      }}
    >
      <form
        className="modal"
        noValidate
        onSubmit={async (event) => {
          event.preventDefault();
          if (pending) return;
          const errors: FieldErrors = {};
          const normalizedEmail = email.trim().toLowerCase();
          const normalizedName = fullName.trim().replace(/\s+/g, " ");
          if (!isValidUserEmail(normalizedEmail)) {
            errors.email = "Введите корректный email (не более 255 символов)";
          }
          if (!normalizedName || normalizedName.length > 200) {
            errors.full_name = "ФИО должно содержать от 1 до 200 символов";
          }
          if (!user && (Array.from(password).length < 8 || new TextEncoder().encode(password).length > 72)) {
            errors.password = "Пароль: от 8 символов, не более 72 байт в UTF-8";
          }
          setFields(errors);
          setError("");
          if (Object.keys(errors).length) return;
          setPending(true);
          try {
            await onSave({
              email: normalizedEmail, full_name: normalizedName, role, is_active: active,
              ...(!user ? { password } : {}),
            });
          } catch (err) {
            setError(err instanceof ApiError ? err.message : "Не удалось сохранить пользователя. Повторите попытку.");
            if (err instanceof ApiError) setFields(err.fields);
          } finally {
            setPending(false);
          }
        }}
      >
        <h2 id="user-dialog-title">{user ? "Редактирование пользователя" : "Новый пользователь"}</h2>
        {error && <div className="alert" role="alert">{error}</div>}
        <fieldset disabled={pending} style={{ border: 0, margin: 0, padding: 0, display: "grid", gap: 10 }}>
          <div className={`field ${fields.email ? "has-error" : ""}`}>
            <label htmlFor="user-email">Email</label>
            <input id="user-email" className="input" type="email" autoComplete="off" required maxLength={255}
              value={email} onChange={(e) => setEmail(e.target.value)} aria-invalid={!!fields.email}
              aria-describedby={fields.email ? "user-email-error" : undefined} />
            {fieldError("email")}
          </div>
          <div className={`field ${fields.full_name ? "has-error" : ""}`}>
            <label htmlFor="user-full_name">ФИО</label>
            <input id="user-full_name" className="input" autoComplete="off" required maxLength={200}
              value={fullName} onChange={(e) => setFullName(e.target.value)} aria-invalid={!!fields.full_name}
              aria-describedby={fields.full_name ? "user-full_name-error" : undefined} />
            {fieldError("full_name")}
          </div>
          <div className={`field ${fields.role ? "has-error" : ""}`}>
            <label htmlFor="user-role">Роль</label>
            <select id="user-role" className="select" value={role} onChange={(e) => setRole(e.target.value as Role)}
              aria-invalid={!!fields.role} aria-describedby={fields.role ? "user-role-error" : undefined}>
              {Object.entries(ROLE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
            {fieldError("role")}
            {self && role !== "admin" && <div className="hint">После сохранения управление пользователями станет недоступно.</div>}
          </div>
          {!user && (
            <div className={`field ${fields.password ? "has-error" : ""}`}>
              <label htmlFor="user-password">Пароль</label>
              <input id="user-password" className="input" type="password" autoComplete="new-password" required
                value={password} onChange={(e) => setPassword(e.target.value)} aria-invalid={!!fields.password}
                aria-describedby="user-password-hint user-password-error" />
              <div id="user-password-hint" className="hint">От 8 символов, не более 72 байт в UTF-8. При первом входе нужна настройка 2FA.</div>
              <div className="error" id="user-password-error">{fields.password}</div>
            </div>
          )}
          {user && (
            <div className="field">
              <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input type="checkbox" checked={active} disabled={self} onChange={(e) => setActive(e.target.checked)}
                  aria-invalid={!!fields.is_active} aria-describedby={fields.is_active ? "user-is_active-error" : undefined} />
                Учётная запись активна
              </label>
              {self && <div className="hint">Собственную учётную запись отключить нельзя.</div>}
              {!self && !active && <div className="hint">После сохранения текущие сессии пользователя потеряют доступ.</div>}
              {fieldError("is_active")}
            </div>
          )}
        </fieldset>
        <div className="actions">
          <button type="button" className="btn" disabled={pending} onClick={onClose}>Отмена</button>
          <button type="submit" className="btn primary" disabled={pending}>
            {pending ? "Сохранение…" : user ? "Сохранить" : "Создать пользователя"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
