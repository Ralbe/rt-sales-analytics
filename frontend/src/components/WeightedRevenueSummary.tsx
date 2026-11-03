"use client";

import { useQuery } from "@tanstack/react-query";

import { QueryState } from "@/components/QueryState";
import { ProjectSummaryCounts } from "@/components/ProjectSummaryCounts";
import { api } from "@/lib/api";
import { revenueRubles } from "@/lib/revenue-format";
import type { DashboardFilters, WeightedRevenueResponse } from "@/lib/types";

const EMPTY: DashboardFilters = { segment_ids: [], service_ids: [], manager_ids: [] };

export function WeightedRevenueSummary({ filters = EMPTY }: { filters?: DashboardFilters }) {
  const query = useQuery({
    queryKey: ["weighted-revenue", filters],
    staleTime: 0,
    refetchOnMount: "always",
    queryFn: () => api<WeightedRevenueResponse>("/analytics/weighted-revenue", { query: {
      segment_id: filters.segment_ids, service_id: filters.service_ids, manager_id: filters.manager_ids,
    } }),
  });
  const data = query.data;
  return <section className="card" aria-label="Выручка с учётом вероятности" style={{ padding: 20, marginBottom: 20 }}>
    <h2 title="Выручка × текущая вероятность. Все годы и статусы; архивные проекты исключены.">Выручка с учётом вероятности</h2>
    <QueryState query={query} title="Не удалось рассчитать выручку" loadingText="Рассчитываем выручку…" />
    {!query.error && data && <>
      <ProjectSummaryCounts total={data.project_count} detailLabel="Без данных о выручке" detailCount={data.missing_revenue_count} />
      <div style={{ overflowX: "auto" }}>
        <table className="table">
          <thead><tr><th scope="col" title="Разные группы финансовых записей. НДС автоматически не пересчитывается.">Финансовые записи</th><th scope="col">Выручка, ₽</th><th scope="col">Выручка с учётом вероятности, ₽</th></tr></thead>
          <tbody>{data.buckets.filter((bucket) => bucket.basis !== "unspecified" || Number(bucket.revenue_rub) !== 0 || Number(bucket.weighted_revenue_rub) !== 0).map((bucket) => <tr key={bucket.basis}>
            <th scope="row">{bucket.basis === "with_vat" ? "Суммы с НДС" : bucket.basis === "without_vat" ? "Суммы без НДС" : bucket.label}</th>
            <td className="num">{revenueRubles(bucket.revenue_rub)}</td>
            <td className="num">{revenueRubles(bucket.weighted_revenue_rub)}</td>
          </tr>)}</tbody>
        </table>
      </div>
    </>}
  </section>;
}
