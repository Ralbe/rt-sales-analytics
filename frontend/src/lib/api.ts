export type FieldErrors = Record<string, string>;

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public fields: FieldErrors = {},
  ) {
    super(message);
  }
}

type Query = Record<string, string | number | boolean | undefined | null | (string | number)[]>;

export function toQuery(params: Query = {}): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) value.forEach((v) => qs.append(key, String(v)));
    else qs.append(key, String(value));
  }
  const s = qs.toString();
  return s ? `?${s}` : "";
}

/** Превращает ответ FastAPI об ошибке в сообщение и ошибки по полям. */
function parseError(status: number, body: unknown): ApiError {
  const detail = (body as { detail?: unknown })?.detail;
  if (typeof detail === "string") return new ApiError(status, detail);
  if (detail && typeof detail === "object" && !Array.isArray(detail) && "message" in detail) {
    const d = detail as { field?: string; message: string };
    return new ApiError(status, d.message, d.field ? { [d.field]: d.message } : {});
  }
  if (Array.isArray(detail)) {
    const fields: FieldErrors = {};
    for (const e of detail as { loc: (string | number)[]; msg: string }[]) {
      const field = e.loc.filter((p) => p !== "body").join(".") || "_form";
      fields[field] = e.msg.replace(/^Value error, /, "");
    }
    return new ApiError(status, "Проверьте заполнение полей", fields);
  }
  return new ApiError(status, `Ошибка сервера (${status})`);
}

export async function api<T>(path: string, init: RequestInit & { query?: Query } = {}): Promise<T> {
  const { query, ...rest } = init;
  const res = await fetch(`/api${path}${toQuery(query)}`, {
    credentials: "include",
    ...rest,
    headers: { "Content-Type": "application/json", ...(rest.headers || {}) },
  });
  if (res.status === 401 && !path.startsWith("/auth/") && typeof window !== "undefined") {
    window.location.href = "/login";
  }
  if (!res.ok) {
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      /* пустое тело */
    }
    throw parseError(res.status, body);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const post = <T>(path: string, body?: unknown) =>
  api<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

export const put = <T>(path: string, body: unknown) => api<T>(path, { method: "PUT", body: JSON.stringify(body) });

export const del = (path: string) => api<void>(path, { method: "DELETE" });
