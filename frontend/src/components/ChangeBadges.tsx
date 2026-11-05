import type { ChangeIndicator } from "@/lib/types";

export const CHANGE_LABELS: Record<ChangeIndicator, string> = {
  new: "Новый",
  removed: "Снят с реализации",
  stage_up: "Этап ↑",
  stage_down: "Этап ↓",
  revenue_up: "Выручка ↑",
  revenue_down: "Выручка ↓",
  industry: "Передан отраслевому менеджеру",
  implemented: "Реализован",
};

/** Цветные метки изменений проекта за выбранный период. */
export function ChangeBadges({ indicators }: { indicators?: ChangeIndicator[] }) {
  if (!indicators?.length) return null;
  return (
    <div className="change-badges">
      {indicators.map((key) => (
        <span key={key} className={`badge change-${key}`}>{CHANGE_LABELS[key]}</span>
      ))}
    </div>
  );
}
