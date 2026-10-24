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

export interface Refs {
  segments: RefItem[];
  services: RefItem[];
  managers: ManagerItem[];
  stages: { id: Stage; name: string; probability: number }[];
  roles: { id: Role; name: string }[];
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
  segment: RefItem;
  manager: ManagerItem;
  service: RefItem;
  stage: Stage;
  amount: string;
  cost: string;
  margin: string;
  margin_pct: number | null;
  probability: number;
  start_date: string;
  expected_close_date: string;
  closed_at: string | null;
  updated_at: string;
}

export interface ProjectPage {
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

export interface KpiResponse {
  as_of: string;
  previous_as_of: string;
  items: KpiItem[];
}

export interface TrendResponse {
  metric: "funnel" | "projects";
  history: { date: string; value: number }[];
  forecast: { date: string; value: number; lower: number; upper: number }[];
  method: string;
}

export interface BreakdownResponse {
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
