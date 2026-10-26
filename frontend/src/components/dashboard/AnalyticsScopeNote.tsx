import type { ProjectPage } from "@/lib/types";

export function AnalyticsScopeNote({ data }: { data?: Pick<ProjectPage, "stage_scope" | "scope_note"> }) {
  if (data?.stage_scope !== "legacy" || !data.scope_note) return null;
  return <p className="hint" role="note" data-stage-scope="legacy" style={{ flexShrink: 0, margin: "0 0 8px" }}>{data.scope_note}</p>;
}
