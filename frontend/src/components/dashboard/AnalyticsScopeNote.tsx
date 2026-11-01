import type { ProjectPage } from "@/lib/types";

export function AnalyticsScopeNote({ data }: { data?: Pick<ProjectPage, "stage_scope" | "scope_note"> }) {
  // Пояснение «все этапы» выводится только в динамике проектов, чтобы не занимать место в каждом виджете.
  if (data?.stage_scope !== "legacy" || !data.scope_note) return null;
  return <p className="hint" role="note" data-stage-scope={data.stage_scope} style={{ flexShrink: 0, margin: "0 0 8px" }}>{data.scope_note}</p>;
}
