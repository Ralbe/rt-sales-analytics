"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { QRCodeSVG } from "qrcode.react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { ApiError, post } from "@/lib/api";
import { isValidUserEmail } from "@/lib/email";
import type { User } from "@/lib/types";

const credentialsSchema = z.object({
  email: z.string().trim().min(1, "Введите email")
    .max(255, "Email должен содержать не более 255 символов").refine(isValidUserEmail, "Некорректный email"),
  password: z.string().min(1, "Введите пароль"),
});
const codeSchema = z.object({ code: z.string().regex(/^\d{6}$/, "Код — 6 цифр из приложения") });

type Credentials = z.infer<typeof credentialsSchema>;
type LoginResponse = { mfa_token: string; setup_required: boolean; otpauth_uri: string | null; secret: string | null };

export default function LoginPage() {
  const [mfa, setMfa] = useState<LoginResponse | null>(null);
  return (
    <div className="auth-wrap">
      <div className="card auth-card">
        <div className="steps">
          <span className="on" />
          <span className={mfa ? "on" : ""} />
        </div>
        {mfa ? <CodeStep mfa={mfa} onRestart={() => setMfa(null)} /> : <CredentialsStep onDone={setMfa} />}
      </div>
    </div>
  );
}

function CredentialsStep({ onDone }: { onDone: (r: LoginResponse) => void }) {
  const [error, setError] = useState<string | null>(null);
  const { register, handleSubmit, formState } = useForm<Credentials>({
    resolver: zodResolver(credentialsSchema),
    mode: "onTouched",
  });
  const { errors, isSubmitting } = formState;

  const submit = handleSubmit(async (data) => {
    setError(null);
    try {
      onDone(await post<LoginResponse>("/auth/login", data));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Сервер недоступен");
    }
  });

  return (
    <form onSubmit={submit} noValidate style={{ display: "contents" }}>
      <div>
        <h1>Вход в систему</h1>
        <div className="muted">Шаг 1 из 2 — учётные данные</div>
      </div>
      {error && <div className="alert">{error}</div>}
      <div className={`field ${errors.email ? "has-error" : ""}`}>
        <label htmlFor="email">Email</label>
        <input id="email" className="input" type="email" maxLength={255} autoComplete="username" autoFocus {...register("email")} />
        <div className="error">{errors.email?.message}</div>
      </div>
      <div className={`field ${errors.password ? "has-error" : ""}`}>
        <label htmlFor="password">Пароль</label>
        <input id="password" className="input" type="password" autoComplete="current-password" {...register("password")} />
        <div className="error">{errors.password?.message}</div>
      </div>
      <button className="btn primary" type="submit" disabled={isSubmitting}>
        {isSubmitting ? "Проверяем…" : "Продолжить"}
      </button>
    </form>
  );
}

function CodeStep({ mfa, onRestart }: { mfa: LoginResponse; onRestart: () => void }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const { register, handleSubmit, formState, setError: setFieldError } = useForm<{ code: string }>({
    resolver: zodResolver(codeSchema),
    mode: "onTouched",
  });
  const { errors, isSubmitting } = formState;

  const submit = handleSubmit(async ({ code }) => {
    setError(null);
    try {
      const user = await post<User>("/auth/2fa", { mfa_token: mfa.mfa_token, code });
      queryClient.setQueryData(["me"], user);
      router.replace("/dashboards");
    } catch (e) {
      if (e instanceof ApiError && e.fields.code) setFieldError("code", { message: e.fields.code });
      else if (e instanceof ApiError && e.status === 401) onRestart();
      else setError(e instanceof ApiError ? e.message : "Сервер недоступен");
    }
  });

  return (
    <form onSubmit={submit} noValidate style={{ display: "contents" }}>
      <div>
        <h1>Подтверждение входа</h1>
        <div className="muted">Шаг 2 из 2 — двухфакторная аутентификация</div>
      </div>
      {mfa.setup_required && mfa.otpauth_uri && (
        <>
          <div className="alert info">
            Первый вход: отсканируйте QR-код в приложении-аутентификаторе (Яндекс Ключ, Google Authenticator и т.п.)
          </div>
          <div className="qr">
            <QRCodeSVG value={mfa.otpauth_uri} size={168} />
            <code className="muted" style={{ fontSize: 11, marginTop: 6, wordBreak: "break-all" }}>{mfa.secret}</code>
          </div>
        </>
      )}
      {error && <div className="alert">{error}</div>}
      <div className={`field ${errors.code ? "has-error" : ""}`}>
        <label htmlFor="code">Код из приложения</label>
        <input
          id="code"
          className="input code-input"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          autoFocus
          {...register("code")}
        />
        <div className="error">{errors.code?.message}</div>
      </div>
      <button className="btn primary" type="submit" disabled={isSubmitting}>
        {isSubmitting ? "Проверяем…" : "Войти"}
      </button>
      <button className="btn" type="button" onClick={onRestart}>
        Назад
      </button>
    </form>
  );
}
