import { expect, test } from "@playwright/test";

import { ganttAxis } from "../../src/lib/gantt-axis";

const at = (year: number, month: number, day = 1, hour = 0) => new Date(year, month - 1, day, hour).valueOf();

test("кварталы и годы начинаются с календарной границы, а не с первого события", () => {
  const quarter = ganttAxis(at(2026, 5, 14), at(2026, 11, 30), "quarter");
  expect(quarter.start).toBe(at(2026, 4));
  expect(quarter.end).toBe(at(2027, 1));
  expect(quarter.ticks.map((tick) => tick.label)).toEqual(["2 кв. 2026", "3 кв. 2026", "4 кв. 2026"]);
  const year = ganttAxis(at(2026, 5), at(2027, 2), "year");
  expect(year.start).toBe(at(2026, 1));
  expect(year.end).toBe(at(2028, 1));
  expect(year.ticks.map((tick) => tick.label)).toEqual(["2026", "2027"]);
});

test("финансовый месяц не добавляет пустой следующий период", () => {
  for (const scale of ["day", "month", "quarter", "year"] as const) {
    const axis = ganttAxis(at(2026, 10), at(2027, 1), scale);
    expect(axis.end).toBe(at(2027, 1));
    expect(axis.ticks.at(-1)?.end).toBe(axis.end);
  }
  expect(ganttAxis(at(2026, 10), at(2026, 11), "month").ticks.map((tick) => tick.label)).toEqual(["10.2026"]);
});

test("шкала дней сохраняет местную полночь, включая переход на летнее время", () => {
  const previousTimezone = process.env.TZ;
  process.env.TZ = "America/New_York";
  try {
    const axis = ganttAxis(at(2026, 3, 7, 12), at(2026, 3, 10), "day");
    expect(axis.ticks.map((tick) => tick.label)).toEqual(["07.03.2026", "08.03.2026", "09.03.2026"]);
    expect(axis.ticks.every((tick) => new Date(tick.at).getHours() === 0)).toBe(true);
    expect(axis.ticks[1].end - axis.ticks[1].at).toBe(23 * 3_600_000);
  } finally {
    if (previousTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimezone;
  }
});

test("високосный февраль и нулевой интервал имеют корректную шкалу", () => {
  const february = ganttAxis(at(2024, 2), at(2024, 3), "day");
  expect(february.ticks).toHaveLength(29);
  expect(february.ticks.at(-1)?.label).toBe("29.02.2024");
  for (const scale of ["day", "month", "quarter", "year"] as const) {
    const axis = ganttAxis(at(2026, 1), at(2026, 1), scale);
    expect(axis.end).toBeGreaterThan(axis.start);
    expect(axis.ticks).toHaveLength(1);
  }
});

test("длинные диапазоны группируются без пропусков и наложения периодов", () => {
  for (const printed of [false, true]) {
    const axis = ganttAxis(at(2026, 1), at(2036, 1), "day", printed);
    expect(axis.ticks.length).toBeLessThanOrEqual(printed ? 8 : 366);
    expect(axis.ticks[0].at).toBe(axis.start);
    expect(axis.ticks.at(-1)?.end).toBe(axis.end);
    for (let index = 1; index < axis.ticks.length; index++) {
      expect(axis.ticks[index].at).toBe(axis.ticks[index - 1].end);
    }
    expect(axis.width).toBeLessThanOrEqual(220 + 366 * 240);
  }
});
