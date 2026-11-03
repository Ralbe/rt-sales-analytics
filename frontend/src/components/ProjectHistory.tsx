"use client";

import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { projectHistoryKey, type ProjectHistoryPage } from "@/lib/history-types";

export function ProjectHistory({ projectId }: { projectId: number }) {
  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: projectHistoryKey(projectId),
    queryFn: () => api<ProjectHistoryPage>(`/projects/${projectId}/history`, { query: { limit: 10 } }),
    retry: false,
  });

  return (
    <section className="card" aria-labelledby="project-history-title" style={{ marginTop: 20, padding: 20 }}>
      <h2 id="project-history-title" style={{ marginTop: 0 }}>История изменений</h2>
      {isLoading && <p role="status" className="muted">Загрузка истории…</p>}
      {error && (
        <div role="alert" className="alert">
          <p>Не удалось загрузить историю изменений.</p>
          <button type="button" className="btn small" disabled={isFetching} onClick={() => void refetch()}>
            {isFetching ? "Загрузка…" : "Повторить загрузку"}
          </button>
        </div>
      )}
      {!isLoading && !error && data?.items.length === 0 && <p className="muted">История изменений пока пуста.</p>}
      {!error && data && data.items.length > 0 && (
        <>
          <p className="muted">Последние 10 изменений карточки и финансовых строк.</p>
          <ol style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {data.items.map((item) => (
              <li key={item.id} style={{ borderTop: "1px solid var(--border)", padding: "16px 0" }}>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 16px", alignItems: "baseline" }}>
                  <h3 style={{ margin: 0, fontSize: 15 }}>{item.title}</h3>
                  <span>{item.author_name}</span>
                  <time dateTime={item.created_at} className="muted">
                    {new Date(item.created_at).toLocaleString("ru-RU")}
                  </time>
                </div>
                {item.note && <p className="muted">{item.note}</p>}
                {item.changes.length > 0 && (
                  <div style={{ overflowX: "auto", marginTop: 8 }}>
                    <table className="table" style={{ tableLayout: "fixed", minWidth: 480 }}>
                      <caption style={{ textAlign: "left" }} className="muted">Изменённые параметры</caption>
                      <thead><tr><th scope="col">Параметр</th><th scope="col">До</th><th scope="col">После</th></tr></thead>
                      <tbody>
                        {item.changes.map((change, index) => (
                          <tr key={`${change.field}-${index}`} style={{ verticalAlign: "top" }}>
                            <th scope="row" style={{ whiteSpace: "normal", overflowWrap: "anywhere" }}>{change.label}</th>
                            <td style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{change.before ?? "Не записано"}</td>
                            <td style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{change.after ?? "Не записано"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </li>
            ))}
          </ol>
          {data.has_more && <p className="muted">Более ранние изменения сохранены в журнале.</p>}
        </>
      )}
    </section>
  );
}
