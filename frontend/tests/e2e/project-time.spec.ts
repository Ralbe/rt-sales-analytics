import { expect, test } from "@playwright/test";

import { duration, projectInstant } from "../../src/lib/project-time";

test("длительность: короткие этапы, перенос минут и полные сутки", () => {
  for (const [seconds, label] of [
    [0, "0 мин"], [1, "Менее 1 мин"], [45, "Менее 1 мин"], [60, "1 мин"],
    [645, "11 мин"], [3599, "1 ч"], [8100, "2 ч 15 мин"],
    [86399, "1 д"], [93600, "1 д 2 ч"], [876300, "10 д 3 ч 25 мин"],
  ] as const) {
    // Match the six-decimal precision of the API, including a one-minute stage.
    expect(duration(Number((seconds / 86400).toFixed(6)))).toBe(label);
  }
  expect(duration(Number.NaN)).toBe("—");
  expect(duration(-1)).toBe("—");
});

test("временные метки со смещением и без него обозначают один момент", () => {
  const expected = Date.parse("2026-10-31T21:30:00Z");
  expect(projectInstant("2026-11-01T00:30:00+03:00").valueOf()).toBe(expected);
  expect(projectInstant("2026-10-31T21:30:00").valueOf()).toBe(expected);
});
