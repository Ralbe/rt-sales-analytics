import { expect, test } from "@playwright/test";

test("импорт требует повторной проверки после смены НДС и подтверждения", async ({ page }) => {
  let previews = 0, commits = 0;
  const vats: string[] = [];
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/auth/me") return route.fulfill({ json: { id: 1, email: "test@example.test", full_name: "Тест", role: "admin" } });
    if (url.pathname === "/api/dashboards") return route.fulfill({ json: [] });
    if (url.pathname === "/api/project-imports") return route.fulfill({ json: { items: [] } });
    if (url.pathname === "/api/project-imports/preview") {
      previews++; vats.push(url.searchParams.get("vat_included")!);
      return route.fulfill({ json: { id: "batch-1", status: "preview", rows: 1, errors: [], headers: ["Клиент"], fields: ["Клиент"],
        preview: [{ row: 4, client: "Клиент", name: "Новый проект", stage: "КП" }] } });
    }
    if (url.pathname === "/api/project-imports/batch-1/commit") { commits++; return route.fulfill({ json: { created: 1, skipped: 0 } }); }
    return route.fulfill({ status: 500, json: { detail: "Неожиданный запрос" } });
  });
  await page.goto("/projects/import");
  await page.getByLabel("Файл", { exact: true }).setInputFiles({ name: "projects.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from("mock xlsx") });
  await page.getByRole("button", { name: "Проверить файл" }).click();
  await expect(page.getByRole("cell", { name: "Новый проект" })).toBeVisible();
  expect(commits).toBe(0);
  await page.getByLabel("Суммы в файле").selectOption("true");
  await expect(page.getByRole("button", { name: "Импортировать проекты" })).toBeDisabled();
  await page.getByRole("button", { name: "Проверить файл" }).click();
  await expect(page.getByRole("button", { name: "Импортировать проекты" })).toBeEnabled();
  expect(previews).toBe(2); expect(vats).toEqual(["false", "true"]);
  await page.screenshot({ path: "test-results/project-import.png", fullPage: true });
  await page.getByRole("button", { name: "Импортировать проекты" }).click();
  await expect(page.getByText("Создано: 1. Пропущено: 0.")).toBeVisible();
  expect(commits).toBe(1);
});

test("сохранение версии открывает постоянный отчёт без срока действия", async ({ page }) => {
  let saved = false;
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/auth/me") return route.fulfill({ json: { id: 1, email: "test@example.test", full_name: "Тест", role: "analyst" } });
    if (url.pathname === "/api/dashboards") return route.fulfill({ json: [] });
    if (url.pathname === "/api/report-archives") {
      expect(route.request().postDataJSON()).toEqual({ snapshot_id: "snapshot-1" });
      saved = true; return route.fulfill({ status: 201, json: { id: "archive-1" } });
    }
    if (["/api/report-snapshots/snapshot-1", "/api/report-archives/archive-1"].includes(url.pathname)) {
      return route.fulfill({ json: { snapshot_id: saved ? "archive-1" : "snapshot-1", title: "Итоги месяца", total: 1, offset: 0, limit: 100,
        columns: [{ id: "project.profit", label: "Прибыль, ₽", type: "decimal" }], rows: [{ "project.profit": "110000" }],
        expires_at: saved ? null : "2027-01-01T00:00:00Z" } });
    }
    return route.fulfill({ status: 500, json: { detail: "Неожиданный запрос" } });
  });
  await page.goto("/reports/snapshots/snapshot-1");
  await page.getByRole("button", { name: "Сохранить версию" }).click();
  await expect(page).toHaveURL(/\/reports\/archive\/archive-1$/);
  await expect(page.getByRole("cell", { name: "110000" })).toBeVisible();
  await expect(page.getByText(/Сохранённая версия\./)).toBeVisible();
  await expect(page.getByRole("button", { name: "Сохранить версию" })).toHaveCount(0);
  await page.screenshot({ path: "test-results/report-archive.png", fullPage: true });
});
