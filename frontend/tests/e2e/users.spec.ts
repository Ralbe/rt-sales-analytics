import { expect, test, type Page } from "@playwright/test";

import type { Role } from "../../src/lib/types";
import type { ManagedUser } from "../../src/lib/user-types";

async function mockUsers(page: Page, role: Role = "admin") {
  const state = {
    me: { id: 1, email: "admin@example.test", full_name: "Тестовый Администратор", role },
    users: Array.from({ length: 21 }, (_, i): ManagedUser => ({
      id: i + 1, email: i === 0 ? "admin@example.test" : `user${i + 1}@example.test`,
      full_name: i === 0 ? "Тестовый Администратор" : `Тестовый Пользователь ${i + 1}`,
      role: i === 0 ? "admin" : "user", is_active: i !== 1, created_at: "2026-10-24T00:00:00Z",
    })),
    failList: false,
    failSave: false,
    meRequests: 0,
    listRequests: 0,
    writes: [] as Record<string, unknown>[],
  };
  // Все API-запросы перехватываются: реальные пользователи и пароли не нужны.
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    if (url.pathname === "/api/auth/me") {
      state.meRequests++;
      return route.fulfill({ json: state.me });
    }
    if (url.pathname === "/api/dashboards") return route.fulfill({ json: [] });
    if (url.pathname === "/api/users" && method === "GET") {
      state.listRequests++;
      if (state.failList) return route.fulfill({ status: 503, json: { detail: "Тестовая ошибка загрузки" } });
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      const items = state.users.filter((u) =>
        (url.searchParams.get("include_inactive") !== "false" || u.is_active)
        && `${u.email} ${u.full_name}`.toLowerCase().includes(q),
      );
      const currentPage = Number(url.searchParams.get("page") ?? 1);
      const size = Number(url.searchParams.get("size") ?? 20);
      return route.fulfill({ json: {
        items: items.slice((currentPage - 1) * size, currentPage * size),
        total: items.length, page: currentPage, size,
      } });
    }
    if (url.pathname.startsWith("/api/users") && ["POST", "PUT"].includes(method)) {
      const data = request.postDataJSON() as Record<string, unknown>;
      state.writes.push(data);
      if (state.failSave) return route.fulfill({
        status: 409, json: { detail: { field: "email", message: "Пользователь с этим email уже существует" } },
      });
      const id = method === "POST" ? state.users.length + 1 : Number(url.pathname.split("/").pop());
      const saved: ManagedUser = {
        id, email: String(data.email), full_name: String(data.full_name), role: data.role as Role,
        is_active: data.is_active === undefined || Boolean(data.is_active), created_at: "2026-10-24T00:00:00Z",
      };
      state.users = [...state.users.filter((u) => u.id !== id), saved];
      if (id === state.me.id) state.me = { ...state.me, ...saved };
      return route.fulfill({ status: method === "POST" ? 201 : 200, json: saved });
    }
    return route.fulfill({ status: 404, json: { detail: "Тестовый маршрут не найден" } });
  });
  return state;
}

test("администратор ищет пользователей, меняет страницу и включает отключённых", async ({ page }) => {
  await mockUsers(page);
  await page.goto("/users");
  await expect(page.getByRole("link", { name: "Пользователи", exact: true })).toBeVisible();
  await expect(page.getByText("Страница 1 из 2", { exact: false })).toBeVisible();
  await expect(page.getByRole("table")).toContainText("user2@example.test");
  await page.getByRole("button", { name: "Далее", exact: true }).click();
  await expect(page.getByRole("table")).toContainText("user21@example.test");
  await page.getByRole("searchbox", { name: "Поиск по email или ФИО" }).fill("user2@");
  await expect(page.getByText("Всего: 1.", { exact: false })).toBeVisible();
  await expect(page.getByRole("table")).toContainText("Отключён");
  await page.getByLabel("Включать отключённых").uncheck();
  await expect(page.getByRole("table")).toContainText("Пользователи не найдены.");
});

test("создание и редактирование сохраняют только разрешённые поля", async ({ page }) => {
  const state = await mockUsers(page);
  await page.goto("/users");
  await page.getByRole("button", { name: "Новый пользователь", exact: true }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("Email", { exact: true }).fill(" CREATED@Example.Test ");
  await dialog.getByLabel("ФИО", { exact: true }).fill("  Новый   Пользователь  ");
  await dialog.getByLabel("Роль", { exact: true }).selectOption("analyst");
  await dialog.getByLabel("Пароль", { exact: true }).fill("Synthetic-2026!");
  await dialog.getByRole("button", { name: "Создать пользователя", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Пользователь создан" })).toBeVisible();
  expect(state.writes[0]).toEqual({
    email: "created@example.test", full_name: "Новый Пользователь", role: "analyst", password: "Synthetic-2026!",
  });
  await expect.poll(() => state.meRequests).toBeGreaterThan(1);
  await page.getByRole("searchbox").fill("created@example.test");
  await page.getByRole("button", { name: "Редактировать created@example.test", exact: true }).click();
  dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Пароль", { exact: true })).toHaveCount(0);
  await dialog.getByLabel("Email", { exact: true }).fill("edited@example.test");
  await dialog.getByLabel("ФИО", { exact: true }).fill("Изменённое Имя");
  await dialog.getByLabel("Роль", { exact: true }).selectOption("user");
  await dialog.getByLabel("Учётная запись активна").uncheck();
  await dialog.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(state.writes[1]).toEqual({
    email: "edited@example.test", full_name: "Изменённое Имя", role: "user", is_active: false,
  });
  await page.getByRole("searchbox").fill("edited@example.test");
  await expect(page.getByRole("table")).toContainText("Отключён");
});

test("ошибки списка и сохранения допускают повторную попытку", async ({ page }) => {
  const state = await mockUsers(page);
  state.failList = true;
  await page.goto("/users");
  await expect(page.getByRole("main").getByRole("alert")).toContainText("Тестовая ошибка загрузки");
  state.failList = false;
  await page.getByRole("button", { name: "Повторить", exact: true }).click();
  await expect(page.getByRole("table")).toBeVisible();
  await page.getByRole("button", { name: "Редактировать user2@example.test", exact: true }).click();
  const dialog = page.getByRole("dialog");
  state.failSave = true;
  await dialog.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Пользователь с этим email уже существует");
  await expect(dialog.getByLabel("Email", { exact: true })).toHaveAttribute("aria-invalid", "true");
  state.failSave = false;
  await dialog.getByLabel("Email", { exact: true }).fill("retry@example.test");
  await dialog.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Изменения сохранены" })).toBeVisible();
});

test("самоотключение запрещено, смена своей роли обновляет навигацию", async ({ page }) => {
  await mockUsers(page);
  await page.goto("/users");
  await page.getByRole("button", { name: "Редактировать admin@example.test", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Учётная запись активна")).toBeDisabled();
  await dialog.getByLabel("Роль", { exact: true }).selectOption("analyst");
  await dialog.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("Недостаточно прав");
  await expect(page.getByRole("link", { name: "Пользователи", exact: true })).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "Изменения сохранены" })).toBeVisible();
});

test("после отключения последней строки пагинация возвращается на существующую страницу", async ({ page }) => {
  const state = await mockUsers(page);
  state.users[1].is_active = true;
  await page.goto("/users");
  await page.getByLabel("Включать отключённых").uncheck();
  await page.getByRole("button", { name: "Далее", exact: true }).click();
  await page.getByRole("button", { name: "Редактировать user21@example.test", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Учётная запись активна").uncheck();
  await dialog.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByText("Всего: 20. Страница 1 из 1", { exact: true })).toBeVisible();
  await expect(page.getByRole("table")).toContainText("user20@example.test");
  await expect(page.getByRole("table")).not.toContainText("user21@example.test");
});

for (const role of ["user", "analyst"] as const) {
  test(`роль ${role} не видит навигацию и не загружает пользователей`, async ({ page }) => {
    const state = await mockUsers(page, role);
    await page.goto("/users");
    await expect(page.getByRole("main").getByRole("alert")).toContainText("Недостаточно прав");
    await expect(page.getByRole("link", { name: "Пользователи", exact: true })).toHaveCount(0);
    expect(state.listRequests).toBe(0);
    expect(state.writes).toEqual([]);
  });
}
