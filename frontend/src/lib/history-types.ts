export interface ProjectHistoryChange {
  field: string;
  label: string;
  before: string | null;
  after: string | null;
}

export interface ProjectHistoryItem {
  id: number;
  created_at: string;
  action: string;
  title: string;
  author_name: string;
  changes: ProjectHistoryChange[];
  note: string | null;
}

export interface ProjectHistoryPage {
  items: ProjectHistoryItem[];
  limit: number;
  offset: number;
  has_more: boolean;
}

export const projectHistoryKey = (projectId: number | string) => ["project-history", String(projectId)] as const;
