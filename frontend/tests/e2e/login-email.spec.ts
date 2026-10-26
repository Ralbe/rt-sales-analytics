import { expect, test } from "@playwright/test";

const ASCII_EMAILS = [
  "sales&support@example.test",
  "a!#$%&'*+-/=?^_`{|}~.b@example.test",
];

for (const email of ASCII_EMAILS) {
  test(`вход принимает допустимую ASCII-локальную часть ${email}`, async ({ page }) => {
    const submitted: { email: string }[] = [];
    // Только синтетический ответ первого шага, без пользователей, паролей и MFA реальной системы.
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      if (new URL(request.url()).pathname === "/api/auth/login" && request.method() === "POST") {
        submitted.push(request.postDataJSON() as { email: string });
        return route.fulfill({ json: {
          mfa_token: "синтетический токен", setup_required: false, otpauth_uri: null, secret: null,
        } });
      }
      return route.fulfill({ status: 404, json: { detail: "Тестовый маршрут не найден" } });
    });
    await page.goto("/login");
    await expect(page.getByLabel("Email", { exact: true })).toHaveAttribute("maxlength", "255");
    await page.getByLabel("Email", { exact: true }).fill(email);
    await page.getByLabel("Пароль", { exact: true }).fill("Synthetic-2026!");
    await page.getByRole("button", { name: "Продолжить", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Подтверждение входа", exact: true })).toBeVisible();
    expect(submitted).toHaveLength(1);
    expect(submitted[0].email).toBe(email);
  });
}

for (const email of ["sales..support@example.test", "sales&support@-example.test", `${"a".repeat(65)}@example.test`]) {
  test(`вход отклоняет недопустимый email ${email}`, async ({ page }) => {
    const requests: string[] = [];
    await page.route("**/api/**", async (route) => {
      requests.push(route.request().url());
      return route.fulfill({ status: 400, json: { detail: "Запрос не должен отправляться" } });
    });
    await page.goto("/login");
    await page.getByLabel("Email", { exact: true }).fill(email);
    await page.getByLabel("Пароль", { exact: true }).fill("Synthetic-2026!");
    await page.getByRole("button", { name: "Продолжить", exact: true }).click();
    await expect(page.getByText("Некорректный email", { exact: true })).toBeVisible();
    expect(requests).toEqual([]);
  });
}

test("F4: после второго фактора вход открывает полный /projects", async ({ page }) => {
  const user = { id: 1, email: "start@example.test", full_name: "Пользователь реестра", role: "analyst" };
  const queries: URLSearchParams[] = [];
  const unexpected: string[] = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "POST" && url.pathname === "/api/auth/login") {
      return route.fulfill({ json: { mfa_token: "synthetic-token", setup_required: false, otpauth_uri: null, secret: null } });
    }
    if (request.method() === "POST" && url.pathname === "/api/auth/2fa") {
      expect(request.postDataJSON()).toEqual({ mfa_token: "synthetic-token", code: "123456" });
      return route.fulfill({ json: user });
    }
    if (request.method() === "GET") {
      if (url.pathname === "/api/auth/me") return route.fulfill({ json: user });
      if (url.pathname === "/api/dashboards") return route.fulfill({ json: [] });
      if (url.pathname === "/api/refs") return route.fulfill({ json: {
        segments: [], services: [], managers: [], stages: [], customer_stages: [], payment_types: [],
        assessment_statuses: [], project_indicators: [], cost_articles: [], cost_types: [], revenue_statuses: [], cost_statuses: [], roles: [],
      } });
      if (url.pathname === "/api/projects") {
        queries.push(url.searchParams);
        return route.fulfill({ json: { items: [], total: 0, page: 1, size: 20 } });
      }
    }
    unexpected.push(request.method() + " " + url.pathname);
    return route.fulfill({ status: 500, json: { detail: "Неожиданный запрос" } });
  });
  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill(user.email);
  await page.getByLabel("Пароль", { exact: true }).fill("Synthetic-2026!");
  await page.getByRole("button", { name: "Продолжить", exact: true }).click();
  await page.getByLabel("Код из приложения", { exact: true }).fill("123456");
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page).toHaveURL(/\/projects$/);
  await expect(page.getByRole("heading", { name: "Проекты", exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "Ничего не найдено", exact: true })).toBeVisible();
  expect(queries.at(-1)?.get("size")).toBe("20");
  expect(queries.at(-1)?.has("open_only")).toBe(false);
  expect(unexpected).toEqual([]);
});
