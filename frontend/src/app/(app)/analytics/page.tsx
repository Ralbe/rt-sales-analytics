"use client";

import { StageDurationSummary } from "@/components/StageDurationSummary";
import { WeightedRevenueSummary } from "@/components/WeightedRevenueSummary";

export default function ProjectAnalyticsPage() {
  return <>
    <div className="page-header"><h1>Выручка и сроки этапов</h1></div>
    <div className="page-body">
      <WeightedRevenueSummary />
      <StageDurationSummary />
    </div>
  </>;
}
