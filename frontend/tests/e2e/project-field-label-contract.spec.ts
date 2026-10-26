import { expect, test } from "@playwright/test";

import { PROJECT_FIELD_DEFAULTS, resolveProjectFieldLabels } from "../../src/lib/project-field-labels";

test("старые refs и неизвестные ключи оставляют стабильные defaults", () => {
  const original = resolveProjectFieldLabels();
  expect(original.name).toBe("Название проекта");
  expect(original.archived_at).toBe("Архивирование");
  expect(original).toEqual(resolveProjectFieldLabels({ name: " ", amount: 123, arbitrary: "Подмена" }));
  expect(Object.hasOwn(original, "arbitrary")).toBe(false);
  expect(PROJECT_FIELD_DEFAULTS.amount.suffix).toBe(", ₽");
  expect(PROJECT_FIELD_DEFAULTS["financial_entries.amount"].suffix).toBe(", тыс. ₽");
});

test("эффективные подписи — обычные строки с неизменяемыми единицами", () => {
  const label = '<script>alert("test")</script>';
  const resolved = resolveProjectFieldLabels({ name: label, amount: "Договор" });
  expect(resolved.name).toBe(label);
  expect(resolved.amount + PROJECT_FIELD_DEFAULTS.amount.suffix).toBe("Договор, ₽");
  expect(resolveProjectFieldLabels().name).toBe("Название проекта");
});
