import { expect, test, type Page } from "@playwright/test";

async function mockApi(page: Page, role = "admin") {
  const state = { items: [{ id: 12, category: "payment_type", code: "existing", name: "Сервисная", is_active: true, position: 10, probability: null }], fail: false };
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/auth/me") return route.fulfill({ json: { id: 1, full_name: "Тест", email: "test@example.test", role } });
    if (path === "/api/dashboards") return route.fulfill({ json: [] });
    if (path === "/api/reference-admin") return route.fulfill({ json: { payment_type: "Тип платежа", customer_stage: "Этап по ТЗ" } });
    if (path === "/api/reference-admin/payment_type" && request.method() === "GET") return route.fulfill({ json: state.items });
    if (path === "/api/reference-admin/customer_stage") return route.fulfill({ json: [] });
    if (state.fail) return route.fulfill({ status: 409, json: { detail: "Такое название уже существует" } });
    if (path === "/api/reference-admin/payment_type" && request.method() === "POST") {
      const item = { ...state.items[0], id: 13, name: request.postDataJSON().name };
      state.items.push(item);
      return route.fulfill({ status: 201, json: item });
    }
    const match = path.match(/payment_type\/(\d+)\/(name|active)$/);
    if (match) {
      const item = state.items.find((row) => row.id === Number(match[1]))!;
      if (match[2] === "name") item.name = request.postDataJSON().name;
      else item.is_active = request.postDataJSON().is_active;
      return route.fulfill({ json: item });
    }
    return route.fulfill({ status: 404 });
  });
  return state;
}

test("администратор добавляет, переименовывает и восстанавливает значение", async ({ page }) => {
  const state = await mockApi(page);
  await page.goto("/settings/references");
  await page.getByLabel("Новое значение").fill("Тестовый платёж");
  state.fail = true;
  await page.getByRole("button", { name: "Добавить" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Такое название уже существует" })).toBeVisible();
  await expect(page.getByLabel("Новое значение")).toHaveValue("Тестовый платёж");
  state.fail = false;
  await page.getByRole("button", { name: "Добавить" }).click();
  const row = page.getByRole("row").filter({ has: page.getByLabel("Название: Тестовый платёж") });
  await expect(row).toBeVisible();
  await row.getByLabel("Название: Тестовый платёж").fill("Переименован");
  await row.getByRole("button", { name: "Переименовать" }).click();
  const renamed = page.getByRole("row").filter({ has: page.getByLabel("Название: Переименован") });
  await renamed.getByRole("button", { name: "Деактивировать" }).click();
  await expect(renamed).toContainText("Неактивно");
  await renamed.getByRole("button", { name: "Восстановить" }).click();
  await expect(renamed).toContainText("Активно");
  await page.getByLabel("Справочник", { exact: true }).selectOption("customer_stage");
  await expect(page.getByRole("button", { name: "Добавить" })).toHaveCount(0);
});

test("пользователь не получает административный экран", async ({ page }) => {
  await mockApi(page, "user");
  await page.goto("/settings/references");
  await expect(page.getByRole("alert").filter({ hasText: "только администратору" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Добавить" })).toHaveCount(0);
});
