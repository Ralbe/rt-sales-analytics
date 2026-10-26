import { expect, test, type Page } from "@playwright/test";

import type { Role } from "../../src/lib/types";

async function mockLabels(page: Page, role: Role = "admin") {
  const state = { label: "Название проекта", refsRequests: 0, writes: [] as unknown[], failSave: false };
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/auth/me") return route.fulfill({ json: { id: 1, full_name: "Тест", email: "test@example.test", role } });
    if (path === "/api/dashboards") return route.fulfill({ json: [] });
    if (path === "/api/refs") {
      state.refsRequests++;
      return route.fulfill({ json: { services: [], segments: [], project_field_labels: { name: state.label } } });
    }
    if (path === "/api/project-fields" && request.method() === "GET") return route.fulfill({ json: [{
      key: "name", label: state.label, default_label: "Название проекта", suffix: "", is_overridden: state.label !== "Название проекта",
    }] });
    if (path === "/api/project-fields/name") {
      state.writes.push(request.method() === "PUT" ? request.postDataJSON() : "reset");
      if (state.failSave) return route.fulfill({ status: 503, json: { detail: "Тестовая ошибка сохранения" } });
      state.label = request.method() === "DELETE" ? "Название проекта" : request.postDataJSON().label.trim();
      return route.fulfill({ json: {
        key: "name", label: state.label, default_label: "Название проекта", suffix: "", is_overridden: state.label !== "Название проекта",
      } });
    }
    return route.fulfill({ status: 404, json: { detail: "Непредусмотренный тестовый запрос" } });
  });
  return state;
}

test("администратор сохраняет текст, видит его без HTML и сбрасывает подпись", async ({ page }) => {
  const state = await mockLabels(page);
  await page.goto("/settings/project-fields");
  const input = page.getByRole("textbox", { name: "Подпись: Название проекта" });
  await expect(input).toHaveValue("Название проекта");
  await expect(page.getByRole("link", { name: "Подписи полей проекта", exact: true })).toBeVisible();
  expect(state.refsRequests).toBe(1);
  const value = '<img src=x onerror="window.labelXss=1">';
  await input.fill(`  ${value}  `);
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(input).toHaveValue(value);
  await expect(page.getByRole("status").filter({ hasText: "Подпись сохранена" })).toBeVisible();
  await expect.poll(() => state.refsRequests).toBeGreaterThan(1);
  expect(state.writes).toEqual([{ label: value }]);
  await expect(page.locator("main img")).toHaveCount(0);
  await page.getByRole("button", { name: "Сбросить", exact: true }).click();
  await expect(input).toHaveValue("Название проекта");
  await expect(page.getByRole("button", { name: "Сбросить", exact: true })).toBeDisabled();
});

test("ошибка сохранения оставляет введённый текст и позволяет повторить", async ({ page }) => {
  const state = await mockLabels(page);
  await page.goto("/settings/project-fields");
  const input = page.getByRole("textbox", { name: "Подпись: Название проекта" });
  await input.fill("Новое название");
  state.failSave = true;
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("Тестовая ошибка сохранения");
  await expect(input).toHaveValue("Новое название");
  state.failSave = false;
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Подпись сохранена" })).toBeVisible();
});

for (const role of ["user", "analyst"] as const) {
  test(`${role}: экран не даёт изменить подписи`, async ({ page }) => {
    const state = await mockLabels(page, role);
    await page.goto("/settings/project-fields");
    await expect(page.getByRole("alert").filter({ hasText: "Недостаточно прав" })).toBeVisible();
    await expect(page.getByRole("textbox")).toHaveCount(0);
    expect(state.writes).toEqual([]);
  });
}
