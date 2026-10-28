import { expect, test, type Page, type Route } from "@playwright/test";

type Role = "user" | "analyst" | "admin";

// Фикстуры основаны на уточнении контракта и не являются фактическими ответами API.
const report = (id: number, title: string, published: boolean) => ({
  id, title, published, owner_id: 1,
  definition: { grain: "project", columns: ["project.name"], filters: [], sort: [] },
  created_at: "2026-10-26T10:00:00Z", updated_at: "2026-10-26T10:00:00Z",
});
const list = (items: ReturnType<typeof report>[], total = items.length, offset = 0) => ({ items, total, offset, limit: 20 });

async function mockApi(page: Page, role: Role, reports: (route: Route) => Promise<void>) {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/me") return route.fulfill({ json: { id: 1, full_name: "Пользователь", email: "test@example.test", role } });
    if (path === "/api/dashboards") return route.fulfill({ json: [] });
    if (path === "/api/reports" && route.request().method() === "GET") {
      const query = new URL(route.request().url()).searchParams;
      expect(query.get("published")).toBe("true");
      expect(query.get("limit")).toBe("20");
      expect(query.has("offset")).toBe(true);
      return reports(route);
    }
    return route.fulfill({ status: 404, json: { detail: "Не найдено" } });
  });
}

for (const role of ["user", "analyst", "admin"] as const) {
  test(`${role}: только опубликованные отчёты и навигация по роли`, async ({ page }) => {
    await mockApi(page, role, (route) => route.fulfill({ json: list([report(1, "Общий отчёт", true)]) }));
    await page.goto("/reports/gallery");
    const main = page.getByRole("main");
    await expect(main.getByRole("heading", { name: "Общий отчёт" })).toBeVisible();
    await expect(page.getByText("Приватный отчёт")).toHaveCount(0);
    await expect(main.getByRole("link", { name: "Открыть отчёт «Общий отчёт»" })).toHaveAttribute("href", "/reports/1");
    await expect(page.getByRole("navigation").getByRole("link", { name: "Готовые отчёты" })).toHaveAttribute("href", "/reports/gallery");
    await expect(page.getByRole("link", { name: "+ Конструктор отчётов" })).toHaveCount(role === "user" ? 0 : 1);
    if (role !== "user") await expect(page.getByRole("link", { name: "+ Конструктор отчётов" })).toHaveAttribute("href", "/reports/new");
  });
}

test("загрузка и пустое состояние не подменяют друг друга", async ({ page }) => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await mockApi(page, "user", async (route) => { await pending; await route.fulfill({ json: list([]) }); });
  await page.goto("/reports/gallery");
  const main = page.getByRole("main");
  await expect(main.getByRole("status")).toHaveText("Загружаем отчёты…");
  await expect(main.getByText("Пока нет опубликованных отчётов.")).toHaveCount(0);
  release();
  await expect(main.getByText("Пока нет опубликованных отчётов.")).toBeVisible();
  await expect(main.getByRole("status")).toHaveCount(0);
});

test("ошибка и некорректный ответ предлагают повтор и не выглядят пустой витриной", async ({ page }) => {
  let attempt = 0;
  await mockApi(page, "analyst", async (route) => {
    attempt++;
    if (attempt === 1) return route.fulfill({ status: 503 });
    if (attempt === 2) return route.fulfill({ json: { items: "не список" } });
    return route.fulfill({ json: list([report(3, "Восстановленный отчёт", true)]) });
  });
  await page.goto("/reports/gallery");
  const main = page.getByRole("main");
  const error = main.getByRole("alert");
  await expect(error).toContainText("Не удалось загрузить отчёты");
  await expect(main.getByText("Пока нет опубликованных отчётов.")).toHaveCount(0);
  await error.getByRole("button", { name: "Повторить" }).click();
  await expect.poll(() => attempt).toBe(2);
  await expect(error).toBeVisible();
  await error.getByRole("button", { name: "Повторить" }).click();
  await expect(main.getByRole("heading", { name: "Восстановленный отчёт" })).toBeVisible();
  await expect(error).toHaveCount(0);
});

test("повторный вход в витрину учитывает публикацию и её отзыв", async ({ page }) => {
  let published = false;
  await mockApi(page, "analyst", (route) => route.fulfill({ json: list(published ? [report(4, "Изменяемый отчёт", true)] : []) }));
  await page.goto("/reports/gallery");
  const main = page.getByRole("main");
  await expect(main.getByText("Пока нет опубликованных отчётов.")).toBeVisible();
  published = true;
  await page.reload();
  await expect(main.getByRole("heading", { name: "Изменяемый отчёт" })).toBeVisible();
  published = false;
  await page.reload();
  await expect(main.getByText("Пока нет опубликованных отчётов.")).toBeVisible();
  await expect(main.getByText("Изменяемый отчёт")).toHaveCount(0);
});

test("постраничная выдача открывает опубликованные отчёты за пределами первых ста", async ({ page }) => {
  const items = Array.from({ length: 105 }, (_, i) => report(i + 1, `Отчёт ${i + 1}`, true));
  const offsets: number[] = [];
  await mockApi(page, "user", (route) => {
    const offset = Number(new URL(route.request().url()).searchParams.get("offset"));
    offsets.push(offset);
    return route.fulfill({ json: list(items.slice(offset, offset + 20), items.length, offset) });
  });
  await page.goto("/reports/gallery");
  await expect(page.getByRole("heading", { name: "Отчёт 1", exact: true })).toBeVisible();
  for (let i = 2; i <= 6; i++) {
    await page.getByRole("button", { name: "Вперёд" }).click();
    await expect(page.getByText(`Страница ${i}`, { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: `Отчёт ${(i - 1) * 20 + 1}`, exact: true })).toBeVisible();
  }
  await expect(page.getByRole("link", { name: "Открыть отчёт «Отчёт 105»" })).toHaveAttribute("href", "/reports/105");
  await expect(page.getByRole("button", { name: "Вперёд" })).toBeDisabled();
  await page.getByRole("button", { name: "Назад" }).click();
  await expect(page.getByRole("heading", { name: "Отчёт 81", exact: true })).toBeVisible();
  expect(offsets).toEqual([0, 20, 40, 60, 80, 100, 80]);
});

test("приватная запись ошибочного ответа не попадает в витрину", async ({ page }) => {
  // Защитный сценарий: сервер нарушил фильтр, возвращая приватный шаблон.
  await mockApi(page, "admin", (route) => route.fulfill({ json: list([
    report(1, "Общий отчёт", true), report(2, "Приватный отчёт", false),
  ]) }));
  await page.goto("/reports/gallery");
  await expect(page.getByRole("heading", { name: "Общий отчёт" })).toBeVisible();
  await expect(page.getByText("Приватный отчёт")).toHaveCount(0);
});

test("возврат без перезагрузки не показывает отозванную публикацию во время запроса и ошибки", async ({ page }) => {
  let requestCount = 0;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await mockApi(page, "user", async (route) => {
    requestCount++;
    if (requestCount === 1) return route.fulfill({ json: list([report(5, "Отозванный отчёт", true)]) });
    await pending;
    return route.fulfill({ status: 503 });
  });
  await page.goto("/reports/gallery");
  await expect(page.getByRole("heading", { name: "Отозванный отчёт" })).toBeVisible();
  await page.getByRole("navigation").getByRole("link", { name: "Список проектов" }).click();
  await expect(page).toHaveURL(/\/projects$/);
  await page.getByRole("navigation").getByRole("link", { name: "Готовые отчёты" }).click();
  await expect(page).toHaveURL(/\/reports\/gallery$/);
  await expect(page.getByRole("main").getByRole("status")).toHaveText("Загружаем отчёты…");
  await expect(page.getByText("Отозванный отчёт")).toHaveCount(0);
  release();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("Не удалось загрузить отчёты");
  await expect(page.getByText("Отозванный отчёт")).toHaveCount(0);
});

test("мобильная витрина доступна с клавиатуры и открывает отчёт", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  const title = "Очень длинное название отчёта ".repeat(12);
  await mockApi(page, "user", (route) => route.fulfill({ json: list([report(42, title, true)]) }));
  await page.goto("/reports/gallery");
  const link = page.getByRole("link", { name: `Открыть отчёт «${title}»` });
  await expect(link).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await link.focus();
  await expect(link).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/reports\/42$/);
});
