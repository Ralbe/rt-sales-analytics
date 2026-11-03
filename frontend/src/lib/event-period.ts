export type PeriodPreset = "week" | "month" | "quarter" | "custom";
export const MAX_PERIOD_DAYS = 36600;

export function isPeriodDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000-")) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function periodError(from: string, to: string): string | null {
  if (!from || !to) return null;
  if (!isPeriodDate(from) || !isPeriodDate(to)) return "Укажите корректные даты периода.";
  if (from > to) return "Начало периода не может быть позже конца.";
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000;
  return days > MAX_PERIOD_DAYS ? "Период не может превышать 36600 дней." : null;
}

export function calendarPeriod(preset: Exclude<PeriodPreset, "custom">, now: Date): [string, string] {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const day = now.getUTCDate();
  let start: Date;
  let end: Date;
  if (preset === "week") {
    start = new Date(Date.UTC(year, month, day - (now.getUTCDay() + 6) % 7));
    end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + 6));
  } else if (preset === "month") {
    start = new Date(Date.UTC(year, month, 1));
    end = new Date(Date.UTC(year, month + 1, 0));
  } else {
    const quarterMonth = Math.floor(month / 3) * 3;
    start = new Date(Date.UTC(year, quarterMonth, 1));
    end = new Date(Date.UTC(year, quarterMonth + 3, 0));
  }
  return [start.toISOString().slice(0, 10), end.toISOString().slice(0, 10)];
}
