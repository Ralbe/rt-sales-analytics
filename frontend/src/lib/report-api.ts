import { ApiError, SESSION_EXPIRED_EVENT, api, del, post, put } from "@/lib/api";

export type Grain = "project" | "financial_entry";
export type ReportField = { id: string; label: string; type: string; grains: Grain[]; operators: string[]; sortable: boolean; choices?: { value: string; label: string }[] };
export type ReportDefinition = { grain: Grain; columns: string[]; filters: { field: string; operator: string; value: unknown }[]; sort: { field: string; direction: "asc" | "desc" }[] };
export type Report = { id: number; title: string; owner_id: number; definition: ReportDefinition; published: boolean; version: number; created_at: string; updated_at: string };
export type Snapshot = { snapshot_id: string; title: string; total: number; expires_at: string };
export type SnapshotMetadata = { filters: { field: string; label: string; operator: string; value: string | number | boolean; value_label: string | number | boolean }[]; scope: "own" | "all_available"; grain: Grain; max_rows: number; max_bytes: number };
export type SnapshotPage = Snapshot & { columns: { id: string; label: string; type: string }[]; rows: Record<string, unknown>[]; offset: number; limit: number; metadata?: SnapshotMetadata | null };
export const emptyDefinition = (): ReportDefinition => ({ grain: "project", columns: [], filters: [], sort: [] });
export const reports = {
  fields: () => api<{ fields: ReportField[] }>("/report-fields"),
  get: (id: string) => api<Report>(`/reports/${encodeURIComponent(id)}`, { cache: "no-store" }),
  create: (title: string, definition: ReportDefinition) => post<Report>("/reports", { title, definition }),
  update: (id: string, title: string, definition: ReportDefinition, version: number) => put<Report>(`/reports/${encodeURIComponent(id)}`, { title, definition, version }),
  publish: (id: string, published: boolean, version: number) => post<Report>(`/reports/${encodeURIComponent(id)}/publish`, { version, published }),
  duplicate: (id: string, title: string) => post<Report>(`/reports/${encodeURIComponent(id)}/duplicate`, { title }),
  release: (id: string) => del(`/report-snapshots/${encodeURIComponent(id)}`),
  releaseAll: () => del("/report-snapshots"),
  preview: (definition: ReportDefinition) => post<Snapshot>("/reports/preview", { definition }),
  run: (id: string, version: number) => post<Snapshot>(`/reports/${encodeURIComponent(id)}/run`, { version }),
  page: (id: string, offset: number, limit = 100) => api<SnapshotPage>(`/report-snapshots/${encodeURIComponent(id)}`, { query: { offset, limit }, cache: "no-store" }),
};
export function reportError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 404) return "Отчёт или снимок недоступен, срок снимка истёк либо доступ отозван. Запустите отчёт снова.";
    if (error.status === 429) return "Достигнут лимит снимков отчётов: личный или общий. Можно освободить свои снимки или повторить попытку позже.";
    if (error.status === 409) return "Отчёт изменён другим пользователем. Ваши изменения сохранены в форме. Откройте актуальную версию в другой вкладке и перенесите правки перед повторным сохранением.";
    if (error.status === 403) return "У вас нет прав на это действие.";
    if (error.status === 413) return "Настройки отчёта слишком велики. Уменьшите число полей или длину фильтров и повторите попытку.";
    if (error.status === 422) return `${error.message}. Проверьте настройки; если результат превышает 10 000 строк или 10 МБ, сузьте фильтры. Данные не усечены.`;
    return error.message;
  }
  return "Не удалось выполнить запрос. Проверьте подключение и повторите попытку.";
}
export async function downloadSnapshot(id: string) {
  let response: Response;
  try { response = await fetch(`/api/report-snapshots/${encodeURIComponent(id)}/export`, { credentials: "include" }); }
  catch { throw new ApiError(0, "Не удалось связаться с сервером. Проверьте подключение."); }
  if (response.status === 401) window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT));
  if (!response.ok) throw new ApiError(response.status, `Ошибка экспорта (${response.status})`);
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url; link.download = "report.xlsx"; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
