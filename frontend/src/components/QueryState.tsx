"use client";

import { ApiError } from "@/lib/api";

interface QueryStatus {
  data: unknown;
  error: unknown;
  isFetching: boolean;
  isPaused?: boolean;
  refetch: () => unknown;
}

/** Показывает состояние запроса, сохраняя уже загруженные данные и открытые формы. */
export function QueryState({
  query,
  title,
  loadingText = "Загрузка…",
  empty = false,
  emptyText = "Нет данных",
}: {
  query: QueryStatus;
  title: string;
  loadingText?: string;
  empty?: boolean;
  emptyText?: string;
}) {
  if (query.error || query.isPaused) {
    return (
      <div className="alert query-state" role="alert">
        <div>
          <div>{title}</div>
          <div>{query.isPaused
            ? "Нет подключения к сети. Восстановите соединение и повторите попытку."
            : query.error instanceof ApiError ? query.error.message : "Попробуйте повторить запрос."}</div>
          {query.data !== undefined && <div>Показаны ранее загруженные данные.</div>}
        </div>
        <button type="button" className="btn small" disabled={query.isFetching} onClick={() => query.refetch()}>
          {query.isFetching ? "Повторяем…" : "Повторить"}
        </button>
      </div>
    );
  }
  if (query.data === undefined) return <div className="muted" role="status">{loadingText}</div>;
  if (empty) return <div className="muted">{emptyText}</div>;
  return null;
}
