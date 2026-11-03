"use client";

import { useQuery } from "@tanstack/react-query";

import { QueryState } from "@/components/QueryState";
import { ProjectSummaryCounts } from "@/components/ProjectSummaryCounts";
import { duration, localTimestamp } from "@/lib/project-time";
import { api } from "@/lib/api";

type StageStatistics = {
  generated_at: string;
  project_count: number;
  projects_with_history: number;
  stage_statistics: { stage_key: string; stage_label: string; completed_visits: number; average_days: number | null }[];
  notes: string[];
};

export function StageDurationSummary() {
  const query = useQuery({
    queryKey: ["stage-duration-summary"],
    queryFn: () => api<StageStatistics>("/project-timeline/stage-statistics"),
    retry: false,
  });
  const data = query.data;
  return (
    <section className="card" style={{ padding: 20, marginTop: 20 }} aria-labelledby="stage-duration-heading">
      <h2 id="stage-duration-heading" title="По завершённым прохождениям этапа с известным началом">Среднее время на этапах</h2>
      <QueryState query={query} title="Не удалось загрузить длительность этапов" />
      {!query.error && data && <>
        <ProjectSummaryCounts total={data.project_count} detailLabel="С историей" detailCount={data.projects_with_history} />
        {data.stage_statistics.length === 0 ? <p>Недостаточно данных.</p> : (
          <div className="report-table-scroll">
            <table className="table">
              <thead><tr><th scope="col">Этап</th><th scope="col">Завершённых периодов</th><th scope="col">Средняя длительность</th></tr></thead>
              <tbody>{data.stage_statistics.map((row) => <tr key={row.stage_key}>
                <th scope="row">{row.stage_label}</th>
                <td>{row.completed_visits}</td>
                <td>{row.average_days == null ? "Нет завершённых периодов" : duration(Number(row.average_days))}</td>
              </tr>)}</tbody>
            </table>
          </div>
        )}
        <p className="muted">Данные на {localTimestamp(data.generated_at)}</p>
      </>}
    </section>
  );
}
