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
