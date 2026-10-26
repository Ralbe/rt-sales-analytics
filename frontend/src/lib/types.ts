export type Role = "analyst" | "user" | "admin";
export type Stage = "lead" | "qualification" | "proposal" | "negotiation" | "won" | "lost";

export interface User {
  id: number;
  email: string;
  full_name: string;
  role: Role;
}

export interface RefItem {
  id: number;
  name: string;
}

export interface ManagerItem {
  id: number;
  full_name: string;
}

export interface ServiceItem extends RefItem {
  group_name: string | null;
}

export interface Refs {
  segments: RefItem[];
  services: ServiceItem[];
  managers: ManagerItem[];
  stages: { id: Stage; name: string; probability: number }[];
  payment_types: RefItem[];
  assessment_statuses: RefItem[];
  project_indicators: RefItem[];
  customer_stages: { id: number; name: string; probability: number }[];
  cost_articles: RefItem[];
  cost_types: RefItem[];
  revenue_statuses: RefItem[];
  cost_statuses: RefItem[];
  roles: { id: Role; name: string }[];
  project_field_labels?: Record<string, string>;
}

export interface ClientItem {
  id: number;
  name: string;
  inn: string;
  segment: RefItem;
}

export interface Project {
  id: number;
  name: string;
  description: string;
  client: RefItem;
  client_inn?: string;
  segment: RefItem;
  manager: ManagerItem;
  service: ServiceItem;
  stage: Stage | null;
  readonly stage_scheme?: "legacy" | "customer";
  amount: string;
  cost: string;
  margin: string;
  margin_pct: number | null;
  probability: number;
  start_date: string;
  expected_close_date: string;
  closed_at: string | null;
  payment_type: RefItem | null;
  customer_stage: RefItem | null;
  indicator: RefItem | null;
  accepted_for_forecast: boolean;
  assessment_status: RefItem | null;
  subsidiary_implementation: boolean;
  management_control: boolean;
  is_industry_solution: boolean;
  industry_manager: string | null;
  industry_project_number: string | null;
  implementation_year: number | null;
  project_status: string | null;
  realized_work: string;
  period_plan: string;
  created_at: string;
  updated_at: string;
  financial_entries: FinancialEntry[];
  archived_at?: string | null;
}

export interface FinancialEntry {
  id?: number;
  kind: "revenue" | "cost";
  year: number;
  month: number;
  amount: string;
  vat_included: boolean;
  reference_id?: number;
  status_id?: number;
  article_id?: number;
  cost_type_id?: number;
  status?: RefItem;
  article?: RefItem | null;
  cost_type?: RefItem | null;
}

export interface ProjectPage extends AnalyticsScope {
  items: Project[];
  total: number;
  page: number;
  size: number;
}

export type KpiKey = "funnel" | "projects" | "won_ytd";
export type GroupBy = "segment" | "service" | "manager" | "stage";

export interface KpiItem {
  key: KpiKey;
  title: string;
  unit: "rub" | "count";
  value: number;
  previous: number;
  delta_pct: number | null;
}

export interface AnalyticsScope {
  stage_scope?: "legacy" | "all";
  scope_note?: string | null;
}

export interface KpiResponse extends AnalyticsScope {
  as_of: string;
  previous_as_of: string;
  items: KpiItem[];
}

export interface TrendResponse extends AnalyticsScope {
  metric: "funnel" | "projects";
  history: { date: string; value: number }[];
  forecast: { date: string; value: number; lower: number; upper: number }[];
  method: string;
}

export interface BreakdownResponse extends AnalyticsScope {
  metric: KpiKey;
  group_by: GroupBy;
  items: { key: string; label: string; value: number }[];
}

export type WidgetType = "kpi" | "trend" | "breakdown" | "projects";
export type ChartKind = "bar" | "hbar" | "donut" | "pie" | "line" | "table";

export interface WidgetConfig {
  metric?: KpiKey;
  group_by?: GroupBy;
  chart?: ChartKind;
  weeks?: number;
  horizon?: number;
  limit?: number;
}

export interface Widget {
  id: string;
  type: WidgetType;
  title: string;
  x: number;
  y: number;
  w: number;
  h: number;
  config: WidgetConfig;
}

export interface DashboardFilters {
  segment_ids: number[];
  service_ids: number[];
  manager_ids: number[];
}

export interface Dashboard {
  id: number;
  name: string;
  owner: ManagerItem;
  widgets: Widget[];
  filters: DashboardFilters;
  is_shared: boolean;
  editable: boolean;
  updated_at: string;
}
