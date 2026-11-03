export type GanttScale = "day" | "month" | "quarter" | "year";

const MONTHS = { day: 0, month: 1, quarter: 3, year: 12 };
const DAY = 86_400_000;

function floor(value: number, scale: GanttScale): Date {
  const date = new Date(value);
  if (scale === "day") return new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const step = MONTHS[scale];
  return new Date(date.getFullYear(), Math.floor(date.getMonth() / step) * step, 1);
}

function advance(start: Date, scale: GanttScale, count: number): Date {
  return scale === "day"
    ? new Date(start.getFullYear(), start.getMonth(), start.getDate() + count)
    : new Date(start.getFullYear(), start.getMonth() + MONTHS[scale] * count, 1);
}

function label(date: Date, scale: GanttScale): string {
  const year = date.getFullYear();
  if (scale === "year") return String(year);
  if (scale === "quarter") return `${Math.floor(date.getMonth() / 3) + 1} кв. ${year}`;
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return scale === "day" ? `${String(date.getDate()).padStart(2, "0")}.${month}.${year}` : `${month}.${year}`;
}

/** One time axis for calendar boundaries, grid lines and all bars. End is exclusive. */
export function ganttAxis(first: number, last: number, scale: GanttScale, printed = false) {
  const origin = floor(first, scale);
  const lastBoundary = floor(last, scale);
  const finish = lastBoundary.valueOf() === last && last > origin.valueOf()
    ? lastBoundary : advance(lastBoundary, scale, 1);
  const start = origin.valueOf();
  const end = finish.valueOf();
  const count = scale === "day"
    ? Math.round((Date.UTC(finish.getFullYear(), finish.getMonth(), finish.getDate()) - Date.UTC(origin.getFullYear(), origin.getMonth(), origin.getDate())) / DAY)
    : ((finish.getFullYear() - origin.getFullYear()) * 12 + finish.getMonth() - origin.getMonth()) / MONTHS[scale];
  const limit = printed ? 8 : scale === "day" ? 366 : 80;
  const step = Math.max(1, Math.ceil(count / limit));
  const ticks = Array.from({ length: Math.ceil(count / step) }, (_, index) => {
    const date = advance(origin, scale, index * step);
    const until = advance(origin, scale, Math.min(count, (index + 1) * step));
    const caption = until.valueOf() === advance(date, scale, 1).valueOf()
      ? label(date, scale) : `${label(date, scale)} – ${label(advance(until, scale, -1), scale)}`;
    return { at: date.valueOf(), end: until.valueOf(), label: caption };
  });
  const columnWidth = step > 1 ? 240 : { day: 100, month: 160, quarter: 180, year: 240 }[scale];
  return { start, end, ticks, width: Math.max(660, 220 + ticks.length * columnWidth) };
}
