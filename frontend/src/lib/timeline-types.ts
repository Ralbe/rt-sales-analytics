export interface StageInterval {
  stage_key: string;
  stage_label: string;
  started_at: string;
  ended_at: string;
  duration_days: number;
  is_current: boolean;
  start_known: boolean;
  end_reason: "stage_change" | "archive" | "current" | "unknown";
}

export interface StageStatistic {
  stage_key: string;
  stage_label: string;
  completed_visits: number;
  average_days: number | null;
}

export interface ProjectTimeline {
  project_id: number;
  generated_at: string;
  history_complete: boolean;
  notes: string[];
  intervals: StageInterval[];
  finances: {
    id: number;
    kind: "revenue" | "cost";
    year: number;
    month: number;
    amount: string;
    vat_included: boolean;
    status: string;
  }[];
  stage_statistics: StageStatistic[];
  archived_periods: { started_at: string; ended_at: string }[];
}
