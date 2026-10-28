import { expect, test, type Page } from "@playwright/test";

type Role = "analyst" | "admin" | "user";
const fields = [
  { id: "project.name", label: "Проект", type: "string", grains: ["project", "financial_entry"], operators: ["eq", "ne", "contains"], sortable: true },
  { id: "client.name", label: "Клиент", type: "string", grains: ["project", "financial_entry"], operators: ["eq"], sortable: true },
  { id: "project.year", label: "Год", type: "integer", grains: ["project", "financial_entry"], operators: ["eq", "is_null"], sortable: true },
  { id: "project.amount", label: "Сумма", type: "decimal", grains: ["project", "financial_entry"], operators: ["eq"], sortable: true },
  { id: "project.date", label: "Дата", type: "date", grains: ["project", "financial_entry"], operators: ["eq"], sortable: true },
  { id: "project.created", label: "Время", type: "datetime", grains: ["project", "financial_entry"], operators: ["eq"], sortable: true },
  { id: "project.flag", label: "Признак", type: "boolean", grains: ["project", "financial_entry"], operators: ["eq"], sortable: true },
  { id: "project.stage", label: "Стадия", type: "string", grains: ["project", "financial_entry"], operators: ["eq", "is_null"], sortable: true, choices: [{ value: "lead", label: "Лид" }] },
  { id: "financial.amount", label: "Сумма записи", type: "decimal", grains: ["financial_entry"], operators: ["eq"], sortable: true },
];
const definition = { grain: "project", columns: ["project.name", "client.name"], filters: [], sort: [] };
const report = { id: 1, title: "Мой отчёт", owner_id: 1, definition, published: false, version: 1, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z" };
const expires = "2027-10-01T00:00:00Z";
async function setup(page: Page, options: { role?: Role; total?: number; saveStatus?: number; previewStatus?: number; failPrint?: boolean; releaseStatus?: number; publishStatus?: number; runStatus?: number } = {}) {
  const requests: { path: string; method: string; body: unknown; query: URLSearchParams }[] = [];
  let current = { ...report, published: options.role === "user" };
  await page.route("**/api/**", async (route) => {
    const req = route.request(); const url = new URL(req.url()); const path = url.pathname.slice(4); const method = req.method();
    requests.push({ path, method, body: req.postDataJSON(), query: url.searchParams });
    if (path === "/auth/me") return route.fulfill({ json: { id: 1, email: "test@example.test", full_name: "Тест", role: options.role ?? "analyst" } });
    if (path === "/dashboards") return route.fulfill({ json: [] });
    if (path === "/report-snapshots" && method === "DELETE") return route.fulfill({ status: 204 });
    if (path === "/report-snapshots/snap-1" && method === "DELETE") return route.fulfill({ status: options.releaseStatus ?? 204 });
    if (path === "/report-fields") return route.fulfill({ json: { fields } });
    if (path === "/reports" && method === "GET") { const offset = Number(url.searchParams.get("offset") ?? 0); return route.fulfill({ json: { items: offset ? [{ ...report, id: 101, title: "Поздний отчёт" }] : [report], total: 201, offset, limit: 200 } }); }
    if (path === "/reports" && method === "POST") return route.fulfill({ status: 201, json: { ...report, ...(req.postDataJSON() as object) } });
    if (path === "/reports/1" && method === "GET") return route.fulfill({ json: current });
    if (path === "/reports/1" && method === "PUT") return options.saveStatus ? route.fulfill({ status: options.saveStatus, json: { detail: "Конфликт" } }) : route.fulfill({ json: { ...report, ...(req.postDataJSON() as object) } });
    if (path === "/reports/1/publish") { if (options.publishStatus) return route.fulfill({ status: options.publishStatus, json: { detail: "Ошибка" } }); current = { ...current, published: req.postDataJSON().published, version: current.version + 1 }; return route.fulfill({ json: current }); }
    if (path === "/reports/1/duplicate") return route.fulfill({ status: 201, json: { ...report, id: 2 } });
    if (path === "/reports/2") return route.fulfill({ json: { ...report, id: 2 } });
    if (path === "/reports/preview" || path === "/reports/1/run") return (path.endsWith("/run") ? options.runStatus : options.previewStatus) ? route.fulfill({ status: (path.endsWith("/run") ? options.runStatus : options.previewStatus), json: { detail: "Ошибка" } }) : route.fulfill({ json: { snapshot_id: "snap-1", title: "Отчёт на момент запуска", total: options.total ?? 250, expires_at: expires } });
    if (path === "/report-snapshots/snap-1/export") return route.fulfill({ contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", body: "xlsx" });
    if (path === "/report-snapshots/snap-1") {
      const offset = Number(url.searchParams.get("offset")); const limit = Number(url.searchParams.get("limit")); const total = options.total ?? 250;
      if (options.failPrint && offset === 200) return route.fulfill({ status: 404, json: { detail: "Истёк" } });
      return route.fulfill({ json: { snapshot_id: "snap-1", title: "Отчёт на момент запуска", columns: [{ id: "project.name", label: "Проект", type: "string" }], rows: Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, i) => ({ "project.name": `Строка ${offset + i + 1}` })), total, offset, limit, expires_at: expires } });
    }
    return route.fulfill({ status: 500, json: { detail: `Не задан ответ: ${path}` } });
  });
  return requests;
}

for (const role of ["user", "analyst", "admin"] as const) {
  test(`${role}: просмотр и печать снимка доступны, скачивание XLSX только редакторам`, async ({ page }) => {
    await setup(page, { role });
    await page.goto("/reports/snapshots/snap-1");
    await expect(page.getByText("Строка 1", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "PDF / Печать всех строк" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Скачать XLSX" })).toHaveCount(role === "user" ? 0 : 1);
  });
}

test("аналитик создаёт отчёт, меняет порядок, фильтр, сортировку и сохраняет", async ({ page }) => {
  const requests = await setup(page); await page.goto("/reports/new");
  await page.getByLabel("Название отчёта").fill("Проверка");
  await page.getByLabel("Проект", { exact: true }).check(); await page.getByLabel("Клиент", { exact: true }).check();
  await page.getByRole("button", { name: "Переместить Клиент выше" }).click();
  await page.getByRole("button", { name: "Добавить фильтр" }).click(); await page.getByLabel("Оператор 1").selectOption("contains"); await page.getByLabel("Значение 1").fill("связь");
  await page.getByRole("button", { name: "Добавить сортировку" }).click(); await page.getByLabel("Направление 1").selectOption("desc");
  await page.getByRole("button", { name: "Предпросмотр", exact: true }).click(); await expect(page.getByText("Строка 1", { exact: true })).toBeVisible();
  const preview = requests.find((r) => r.path === "/reports/preview")!;
  expect(preview.body).toEqual({ definition: { grain: "project", columns: ["client.name", "project.name"], filters: [{ field: "project.name", operator: "contains", value: "связь" }], sort: [{ field: "project.name", direction: "desc" }] } });
  await page.getByRole("button", { name: "Сохранить отчёт" }).click(); await expect(page).toHaveURL(/\/reports\/1$/);
  expect(requests.find((r) => r.path === "/reports" && r.method === "POST")?.body).toEqual({ title: "Проверка", ...(preview.body as object) });
});

test("список страниц, повторное открытие, редактирование и дублирование", async ({ page }) => {
  const requests = await setup(page); await page.goto("/reports");
  await expect(page.getByRole("link", { name: "Мой отчёт" })).toBeVisible(); await page.getByRole("button", { name: "Следующая страница" }).click(); await expect(page.getByRole("link", { name: "Поздний отчёт" })).toBeVisible();
  expect(requests.find((r) => r.path === "/reports" && r.query.get("offset") === "200")?.query.get("limit")).toBe("200");
  await page.goto("/reports/1"); await page.getByRole("link", { name: "Редактировать" }).click(); await expect(page.getByLabel("Название отчёта")).toHaveValue("Мой отчёт");
  await page.getByLabel("Название отчёта").fill("Изменённый"); await page.getByRole("button", { name: "Сохранить отчёт" }).click(); await expect(page).toHaveURL(/\/reports\/1$/);
  expect(requests.find((r) => r.method === "PUT")?.body).toEqual({ title: "Изменённый", definition, version: 1 });
  await page.getByLabel("Название копии").fill("Копия"); await page.getByRole("button", { name: "Дублировать" }).click(); await expect(page).toHaveURL(/\/reports\/2\/edit$/);
  expect(requests.find((r) => r.path.endsWith("/duplicate"))?.body).toEqual({ title: "Копия" });
});

test("пользователь запускает опубликованный отчёт без доступа к редактору", async ({ page }) => {
  const requests = await setup(page, { role: "user" }); await page.goto("/reports/1"); await expect(page.getByRole("link", { name: "Редактировать" })).toHaveCount(0); await expect(page.getByRole("button", { name: "Дублировать" })).toHaveCount(0);
  await page.getByRole("button", { name: "Выполнить отчёт" }).click(); await expect(page).toHaveURL(/\/reports\/snapshots\/snap-1$/); await expect(page.getByText("Строка 1", { exact: true })).toBeVisible();
  expect(requests.find((r) => r.path === "/reports/1/run")?.body).toEqual({ version: 1 });
  await page.goto("/reports/new"); await expect(page.getByRole("alert").filter({ hasText: "Конструктор доступен" })).toBeVisible(); expect(requests.filter((r) => r.path === "/report-fields")).toHaveLength(0);
});

test("все страницы снимка печатаются вместе, XLSX использует тот же снимок", async ({ page }) => {
  const requests = await setup(page); await page.addInitScript(() => { window.print = () => { document.body.dataset.printRows = String(document.querySelectorAll(".report-print-surface tbody tr").length); document.body.dataset.printText = document.querySelector(".report-print-surface")?.textContent ?? ""; }; });
  await page.goto("/reports/snapshots/snap-1"); await expect(page.getByText("Строка 1", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Следующая страница" }).click(); await expect(page.getByText("Строка 101", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "PDF / Печать всех строк" }).click(); await expect(page.locator("body")).toHaveAttribute("data-print-rows", "250"); await expect(page.locator("body")).toHaveAttribute("data-print-text", /Строка 250/);
  expect(requests.filter((r) => r.path === "/report-snapshots/snap-1" && r.query.get("limit") === "200").map((r) => r.query.get("offset"))).toEqual(["0", "200"]);
  const download = page.waitForEvent("download"); await page.getByRole("button", { name: "Скачать XLSX" }).click(); expect((await download).suggestedFilename()).toBe("report.xlsx"); expect(requests.some((r) => r.path === "/report-snapshots/snap-1/export")).toBeTruthy();
});

test("неполный снимок не печатается", async ({ page }) => {
  await setup(page, { failPrint: true }); await page.addInitScript(() => { window.print = () => { document.body.dataset.printed = "yes"; }; }); await page.goto("/reports/snapshots/snap-1"); await page.getByRole("button", { name: "PDF / Печать всех строк" }).click(); await expect(page.getByRole("alert").filter({ hasText: /недоступен|истёк/ })).toBeVisible(); await expect(page.locator("body")).not.toHaveAttribute("data-printed", "yes");
});

test("конфликт сохраняет введённые данные", async ({ page }) => {
  await setup(page, { saveStatus: 409 }); await page.goto("/reports/1/edit"); await page.getByLabel("Название отчёта").fill("Мои несохранённые правки"); await page.getByRole("button", { name: "Сохранить отчёт" }).click(); await expect(page.getByRole("main").getByRole("alert")).toContainText("изменён другим пользователем"); await expect(page.getByLabel("Название отчёта")).toHaveValue("Мои несохранённые правки");
});

for (const status of [422, 429]) test(`ошибка предпросмотра ${status} сохраняет настройки`, async ({ page }) => {
  await setup(page, { previewStatus: status }); await page.goto("/reports/new"); await page.getByLabel("Название отчёта").fill("Черновик"); await page.getByLabel("Проект", { exact: true }).check(); await page.getByRole("button", { name: "Предпросмотр", exact: true }).click(); await expect(page.getByRole("main").getByRole("alert")).toContainText(status === 422 ? "сузьте фильтры" : "лимит снимков"); await expect(page.getByLabel("Название отчёта")).toHaveValue("Черновик");
});

test("режим финансовых записей и мобильный экран", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 }); await setup(page); await page.goto("/reports/new"); await expect(page.getByLabel("Сумма записи")).toHaveCount(0); await page.getByLabel("Строки отчёта").selectOption("financial_entry"); await page.getByLabel("Сумма записи").check(); await page.getByLabel("Строки отчёта").selectOption("project"); await expect(page.getByRole("status").filter({ hasText: "Несовместимые поля" })).toBeVisible(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});


test("квоту можно освободить, явно удалив свои снимки", async ({ page }) => {
  const requests = await setup(page, { previewStatus: 429 }); await page.goto("/reports/new"); await page.getByLabel("Проект", { exact: true }).check(); await page.getByRole("button", { name: "Предпросмотр", exact: true }).click();
  page.once("dialog", (dialog) => dialog.accept()); await page.getByRole("button", { name: "Освободить квоту снимков" }).click();
  await expect.poll(() => requests.some((r) => r.path === "/report-snapshots" && r.method === "DELETE")).toBe(true); await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0); await expect(page.getByLabel("Проект", { exact: true })).toBeChecked();
});

test("повторное открытие отчёта скрывает кэш при отзыве доступа", async ({ page }) => {
  await setup(page); let calls = 0; let revoked = false; let release: () => void = () => {}; const pending = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/reports/1", async (route) => { if (route.request().method() !== "GET") return route.fallback(); calls++; if (!revoked) return route.fulfill({ json: { ...report, published: true } }); await pending; return route.fulfill({ status: 404, json: { detail: "Недоступно" } }); });
  await page.goto("/reports/1"); await expect(page.getByRole("button", { name: "Выполнить отчёт" })).toBeVisible(); const before = calls; revoked = true; await page.getByRole("main").getByRole("link", { name: "Доступные отчёты" }).click(); await page.getByRole("link", { name: "Мой отчёт" }).click();
  await expect.poll(() => calls).toBeGreaterThan(before); await expect(page.getByRole("button", { name: "Выполнить отчёт" })).toHaveCount(0); await expect(page.getByRole("status").filter({ hasText: "Проверяем доступ" })).toBeVisible(); release(); await expect(page.getByRole("alert").filter({ hasText: "Не удалось открыть отчёт" })).toBeVisible(); await expect(page.getByRole("button", { name: "Выполнить отчёт" })).toHaveCount(0);
});

test("при повторном открытии снимка после отзыва старые строки скрыты", async ({ page }) => {
  await setup(page); let calls = 0; let release: () => void = () => {}; const pending = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/report-snapshots/snap-1?*", async (route) => { calls++; if (calls === 1) return route.fulfill({ json: { snapshot_id: "snap-1", title: "Отчёт на момент запуска", columns: [{ id: "project.name", label: "Проект", type: "string" }], rows: [{ "project.name": "Закрытая строка" }], total: 1, offset: 0, limit: 100, expires_at: expires } }); await pending; return route.fulfill({ status: 404, json: { detail: "Доступ отозван" } }); });
  await page.goto("/reports/1"); await page.getByRole("button", { name: "Выполнить отчёт" }).click(); await expect(page.getByText("Закрытая строка")).toBeVisible(); await page.goBack(); await page.goForward(); await expect.poll(() => calls).toBe(2); await expect(page.getByText("Закрытая строка")).toHaveCount(0); await expect(page.getByRole("button", { name: "Скачать XLSX" })).toHaveCount(0); release(); await expect(page.getByRole("alert").filter({ hasText: "Не удалось загрузить снимок" })).toBeVisible(); await expect(page.getByText("Закрытая строка")).toHaveCount(0);
});


test("типизированные фильтры передаются в JSON без потери точности", async ({ page }) => {
  const requests = await setup(page); await page.goto("/reports/new"); await page.getByLabel("Проект", { exact: true }).check();
  const add = async (index: number, field: string) => { await page.getByRole("button", { name: "Добавить фильтр" }).click(); await page.getByLabel(`Поле фильтра ${index}`).selectOption(field); };
  await add(1, "project.year"); await page.getByLabel("Значение 1").fill("2026");
  await add(2, "project.amount"); await page.getByLabel("Значение 2").fill("123456789012345.123456");
  await add(3, "project.date"); await page.getByLabel("Значение 3").fill("2026-10-28");
  await add(4, "project.created"); await page.getByLabel("Значение 4").fill("2026-10-28T12:30:00+03:00");
  await add(5, "project.flag"); await page.getByLabel("Значение 5").selectOption("false");
  await add(6, "project.year"); await page.getByLabel("Оператор 6").selectOption("is_null"); await page.getByLabel("Значение 6").selectOption("true");
  await add(7, "project.stage"); await page.getByLabel("Значение 7").selectOption({ label: "Лид" });
  await page.getByRole("button", { name: "Предпросмотр", exact: true }).click(); await expect(page.getByText("Строка 1", { exact: true })).toBeVisible();
  const body = requests.find((r) => r.path === "/reports/preview")!.body as { definition: { filters: { value: unknown }[] } };
  expect(body.definition.filters.map((f) => f.value)).toEqual([2026, "123456789012345.123456", "2026-10-28", "2026-10-28T12:30:00+03:00", false, true, "lead"]);
  await page.getByLabel("Оператор 6").selectOption("eq"); await expect(page.getByLabel("Значение 6")).toHaveValue("");
  await page.getByLabel("Поле фильтра 7").selectOption("project.year"); await expect(page.getByLabel("Значение 7")).toHaveValue("");
});

test("неверные integer и datetime не отправляются, 422 сохраняет ввод", async ({ page }) => {
  const requests = await setup(page, { previewStatus: 422 }); await page.goto("/reports/new"); await page.getByLabel("Проект", { exact: true }).check(); await page.getByRole("button", { name: "Добавить фильтр" }).click(); await page.getByLabel("Поле фильтра 1").selectOption("project.year"); await page.getByLabel("Значение 1").fill("1.5"); await page.getByRole("button", { name: "Предпросмотр", exact: true }).click(); await expect(page.getByRole("main").getByRole("alert")).toContainText("целое число"); expect(requests.filter((r) => r.path === "/reports/preview")).toHaveLength(0);
  await page.getByLabel("Поле фильтра 1").selectOption("project.created"); await page.getByLabel("Значение 1").fill("2026-10-28T12:30"); await page.getByRole("button", { name: "Предпросмотр", exact: true }).click(); await expect(page.getByRole("main").getByRole("alert")).toContainText("часовым поясом"); expect(requests.filter((r) => r.path === "/reports/preview")).toHaveLength(0);
  await page.getByLabel("Значение 1").fill("2026-10-28T12:30:00Z"); await page.getByRole("button", { name: "Предпросмотр", exact: true }).click(); await expect(page.getByRole("main").getByRole("alert")).toContainText("сузьте фильтры"); await expect(page.getByLabel("Значение 1")).toHaveValue("2026-10-28T12:30:00Z");
});

test("истёкший старый предпросмотр не мешает создать новый", async ({ page }) => {
  const requests = await setup(page, { releaseStatus: 404 }); await page.goto("/reports/new"); await page.getByLabel("Проект", { exact: true }).check(); await page.getByRole("button", { name: "Предпросмотр", exact: true }).click(); await expect(page.getByText("Строка 1", { exact: true })).toBeVisible(); await page.getByRole("button", { name: "Предпросмотр", exact: true }).click(); await expect.poll(() => requests.filter((r) => r.path === "/reports/preview").length).toBe(2); await expect(page.getByText("Строка 1", { exact: true })).toBeVisible();
});

test("публикация и отзыв используют актуальную версию", async ({ page }) => {
  const requests = await setup(page); await page.goto("/reports/1"); await page.getByRole("button", { name: "Опубликовать" }).click(); await expect(page.getByRole("button", { name: "Отозвать публикацию" })).toBeVisible(); await page.getByRole("button", { name: "Отозвать публикацию" }).click(); await expect(page.getByRole("button", { name: "Опубликовать" })).toBeVisible(); expect(requests.filter((r) => r.path.endsWith("/publish")).map((r) => r.body)).toEqual([{ version: 1, published: true }, { version: 2, published: false }]);
});

for (const status of [403, 409]) test(`ошибка публикации ${status} понятна пользователю`, async ({ page }) => {
  await setup(page, { publishStatus: status }); await page.goto("/reports/1"); await page.getByRole("button", { name: "Опубликовать" }).click(); await expect(page.getByRole("main").getByRole("alert")).toContainText(status === 403 ? "нет прав" : "изменился"); if (status === 409) await expect(page.getByRole("button", { name: "Обновить отчёт" })).toBeVisible();
});

test("ошибка версии при запуске предлагает обновить отчёт", async ({ page }) => {
  const requests = await setup(page, { runStatus: 409 }); await page.goto("/reports/1"); await page.getByRole("button", { name: "Выполнить отчёт" }).click(); await expect(page.getByRole("main").getByRole("alert")).toContainText("Обновите"); expect(requests.find((r) => r.path.endsWith("/run"))?.body).toEqual({ version: 1 }); await page.getByRole("button", { name: "Обновить отчёт" }).click(); await expect(page.getByRole("button", { name: "Выполнить отчёт" })).toBeVisible();
});


test("печать снимка на 10 000 строк не обрезает последнюю страницу", async ({ page }) => {
  test.setTimeout(60000); const requests = await setup(page, { total: 10000 }); await page.addInitScript(() => { window.print = () => { document.body.dataset.printRows = String(document.querySelectorAll(".report-print-surface tbody tr").length); document.body.dataset.printText = document.querySelector(".report-print-surface")?.textContent ?? ""; }; });
  await page.goto("/reports/snapshots/snap-1"); await page.getByRole("button", { name: "PDF / Печать всех строк" }).click(); await expect(page.locator("body")).toHaveAttribute("data-print-rows", "10000", { timeout: 45000 }); await expect(page.locator("body")).toHaveAttribute("data-print-text", /Строка 10000/); expect(requests.filter((r) => r.path === "/report-snapshots/snap-1" && r.query.get("limit") === "200")).toHaveLength(50);
});

test("ошибка удаления предпросмотра, кроме 404, не скрывается", async ({ page }) => {
  const requests = await setup(page, { releaseStatus: 503 }); await page.goto("/reports/new"); await page.getByLabel("Проект", { exact: true }).check(); await page.getByRole("button", { name: "Предпросмотр", exact: true }).click(); await expect(page.getByText("Строка 1", { exact: true })).toBeVisible(); await page.getByRole("button", { name: "Предпросмотр", exact: true }).click(); await expect(page.getByRole("main").getByRole("alert")).toContainText("503"); expect(requests.filter((r) => r.path === "/reports/preview")).toHaveLength(1); await expect(page.getByText("Строка 1", { exact: true })).toBeVisible();
});


test("широкий отчёт в печати переносит все колонки и длинные значения", async ({ page }) => {
  await setup(page); const value = "ОченьДлинноеЗначение".repeat(100); const columns = Array.from({ length: 8 }, (_, i) => ({ id: `c${i}`, label: `Колонка ${i + 1}`, type: "string" })); const row = Object.fromEntries(columns.map((c) => [c.id, value]));
  await page.route("**/api/report-snapshots/snap-1?*", async (route) => { const url = new URL(route.request().url()); return route.fulfill({ json: { snapshot_id: "snap-1", title: "Отчёт на момент запуска", columns, rows: [row], total: 1, offset: Number(url.searchParams.get("offset")), limit: Number(url.searchParams.get("limit")), expires_at: expires } }); });
  await page.addInitScript(() => { window.print = () => { document.body.dataset.printReady = "yes"; }; }); await page.goto("/reports/snapshots/snap-1"); await page.getByRole("button", { name: "PDF / Печать всех строк" }).click(); await expect(page.locator("body")).toHaveAttribute("data-print-ready", "yes"); await page.emulateMedia({ media: "print" }); const surface = page.locator(".report-print-surface"); await expect(surface.locator("dt")).toHaveCount(8); await expect(surface.locator("dd").last()).toHaveText(value); const dimensions = await surface.evaluate((el) => ({ width: el.clientWidth, scroll: el.scrollWidth, wrap: getComputedStyle(el.querySelector("dd")!).overflowWrap })); expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width + 1); expect(dimensions.wrap).toBe("anywhere");
});


test("заголовок снимка сохраняется на экране и в печати", async ({ page }) => {
  await setup(page); await page.addInitScript(() => { window.print = () => { document.body.dataset.printTitle = document.querySelector(".report-print-surface h1")?.textContent ?? ""; }; });
  await page.goto("/reports/1"); await expect(page.getByRole("heading", { name: "Мой отчёт" })).toBeVisible(); await page.getByRole("button", { name: "Выполнить отчёт" }).click();
  await expect(page.getByRole("heading", { name: "Отчёт на момент запуска" })).toBeVisible(); await page.getByRole("button", { name: "PDF / Печать всех строк" }).click(); await expect(page.locator("body")).toHaveAttribute("data-print-title", "Отчёт на момент запуска");
});

test("печать показывает фильтры, ограничения и область доступа из снимка", async ({ page }) => {
  await setup(page);
  await page.route("**/api/report-snapshots/snap-1?*", async (route) => {
    const url = new URL(route.request().url());
    await route.fulfill({ json: { snapshot_id: "snap-1", title: "Прежний отчёт", columns: [{ id: "project.name", label: "Старая подпись", type: "string" }], rows: [{ "project.name": "Мой проект" }], total: 1, offset: Number(url.searchParams.get("offset")), limit: Number(url.searchParams.get("limit")), expires_at: expires, metadata: { filters: [{ field: "project.name", label: "Прежний фильтр", operator: "eq", value: "Мой проект", value_label: "Мой проект" }], scope: "own", grain: "project", max_rows: 10000, max_bytes: 10485760 } } });
  });
  await page.addInitScript(() => { window.print = () => { document.body.dataset.printText = document.querySelector(".report-print-surface")?.textContent ?? ""; }; });
  await page.goto("/reports/snapshots/snap-1");
  await page.getByRole("button", { name: "PDF / Печать всех строк" }).click();
  await expect(page.locator("body")).toHaveAttribute("data-print-text", /Прежний фильтр.*Мой проект/);
  await expect(page.locator("body")).toHaveAttribute("data-print-text", /Только свои проекты/);
  await expect(page.locator("body")).toHaveAttribute("data-print-text", /10\s?000/);
  await expect(page.locator("body")).toHaveAttribute("data-print-text", /Дата печати/);
});

test("истечение сессии во время загрузки страниц отменяет печать", async ({ page }) => {
  await setup(page, { total: 250 });
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let waiting = false;
  await page.route("**/api/report-snapshots/snap-1?*", async (route) => {
    const url = new URL(route.request().url());
    const offset = Number(url.searchParams.get("offset"));
    const limit = Number(url.searchParams.get("limit"));
    if (offset === 200) { waiting = true; await gate; }
    await route.fulfill({ json: { snapshot_id: "snap-1", title: "Отчёт", columns: [{ id: "project.name", label: "Проект", type: "string" }], rows: Array.from({ length: Math.min(limit, 250 - offset) }, (_, i) => ({ "project.name": `Строка ${offset + i}` })), total: 250, offset, limit, expires_at: expires } });
  });
  await page.addInitScript(() => { window.print = () => { document.body.dataset.printed = "yes"; }; });
  await page.goto("/reports/snapshots/snap-1");
  await page.getByRole("button", { name: "PDF / Печать всех строк" }).click();
  await expect.poll(() => waiting).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new Event("session-expired")));
  release();
  await expect(page.locator(".report-print-surface")).toHaveCount(0);
  await expect(page.locator("body")).not.toHaveAttribute("data-printed", "yes");
});

for (const total of [0, 250]) for (const status of [401, 403, 404]) test(`отзыв ${status} после последней страницы отменяет печать: ${total} строк`, async ({ page }) => {
  await setup(page, { total });
  await page.route("**/api/report-snapshots/snap-1?*", (route) => {
    const url = new URL(route.request().url());
    return url.searchParams.get("limit") === "1"
      ? route.fulfill({ status, json: { detail: "Доступ отозван" } })
      : route.fallback();
  });
  await page.addInitScript(() => { window.print = () => { document.body.dataset.printed = "yes"; }; });
  await page.goto("/reports/snapshots/snap-1");
  await page.getByRole("button", { name: "PDF / Печать всех строк" }).click();
  if (status !== 401) await expect(page.getByRole("alert").filter({ hasText: status === 403 ? "нет прав" : "недоступен" })).toBeVisible();
  else await expect(page).toHaveURL(/\/login/);
  await expect(page.locator(".report-print-surface")).toHaveCount(0);
  await expect(page.locator("body")).not.toHaveAttribute("data-printed", "yes");
});

test("повторный beforeprint без новой проверки закрывает поверхность снимка", async ({ page }) => {
  await setup(page, { total: 1 });
  await page.addInitScript(() => { window.print = () => { document.body.dataset.printed = "yes"; }; });
  await page.goto("/reports/snapshots/snap-1");
  await page.getByRole("button", { name: "PDF / Печать всех строк" }).click();
  await expect(page.locator("body")).toHaveAttribute("data-printed", "yes");
  await page.evaluate(() => window.dispatchEvent(new Event("beforeprint")));
  await expect(page.locator(".report-print-surface")).toHaveAttribute("data-ready", "false");
});

test("пока финальная проверка ожидает ответ, Ctrl+P не раскрывает строки", async ({ page }) => {
  await setup(page, { total: 1 });
  let release = () => {}; let waiting = false;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/report-snapshots/snap-1?*", async (route) => {
    if (new URL(route.request().url()).searchParams.get("limit") !== "1") return route.fallback();
    waiting = true; await gate;
    return route.fulfill({ status: 404, json: { detail: "Доступ отозван" } });
  });
  await page.goto("/reports/snapshots/snap-1");
  await page.getByRole("button", { name: "PDF / Печать всех строк" }).click();
  await expect.poll(() => waiting).toBe(true);
  const surface = page.locator(".report-print-surface");
  await expect(surface).toHaveAttribute("data-ready", "false");
  await page.evaluate(() => window.dispatchEvent(new Event("beforeprint")));
  await page.emulateMedia({ media: "print" });
  await expect(surface.locator("tbody")).toBeHidden();
  release();
  await expect(surface).toHaveCount(0);
});

test("ошибка обновления снимка освобождает кнопку и старый ответ не отменяет новую печать", async ({ page }) => {
  await setup(page, { total: 1 });
  let release = () => {}; let waiting = false; let finished = false; let checks = 0; let failPage = false;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/report-snapshots/snap-1?*", async (route) => {
    const limit = new URL(route.request().url()).searchParams.get("limit");
    if (limit === "100" && failPage) return route.fulfill({ status: 503, json: { detail: "Ошибка обновления" } });
    if (limit !== "1" || ++checks !== 1) return route.fallback();
    waiting = true; await gate;
    await route.fulfill({ status: 404, json: { detail: "Старый доступ отозван" } });
    finished = true;
  });
  await page.addInitScript(() => { window.print = () => { document.body.dataset.printed = "yes"; }; });
  await page.goto("/reports/snapshots/snap-1");
  await page.getByRole("button", { name: "PDF / Печать всех строк" }).click();
  await expect.poll(() => waiting).toBe(true);
  failPage = true;
  await page.evaluate(() => { window.dispatchEvent(new Event("offline")); window.dispatchEvent(new Event("online")); });
  await expect(page.getByRole("alert").filter({ hasText: "Не удалось загрузить снимок" })).toBeVisible();
  failPage = false;
  await page.getByRole("button", { name: "Повторить" }).click();
  const printButton = page.getByRole("button", { name: "PDF / Печать всех строк" });
  await expect(printButton).toBeEnabled();
  await printButton.click();
  await expect(page.locator("body")).toHaveAttribute("data-printed", "yes");
  release();
  await expect.poll(() => finished).toBe(true);
  await expect(page.locator(".report-print-surface")).toHaveAttribute("data-ready", "true");
  await expect(page.getByRole("alert").filter({ hasText: "недоступен" })).toHaveCount(0);
});

test("ошибка диалога печати освобождает снимок и позволяет повторить", async ({ page }) => {
  await setup(page, { total: 1 });
  await page.addInitScript(() => { window.print = () => { throw new Error("Ошибка печати"); }; });
  await page.goto("/reports/snapshots/snap-1");
  await page.getByRole("button", { name: "PDF / Печать всех строк" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Браузер не смог открыть печать" })).toBeVisible();
  await expect(page.locator(".report-print-surface")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "PDF / Печать всех строк" })).toBeEnabled();
});

test("пустое название предпросмотра имеет нейтральный заголовок", async ({ page }) => {
  await setup(page); await page.route("**/api/report-snapshots/snap-1?*", async (route) => { const url = new URL(route.request().url()); return route.fulfill({ json: { snapshot_id: "snap-1", title: "", columns: [{ id: "project.name", label: "Проект", type: "string" }], rows: [], total: 0, offset: Number(url.searchParams.get("offset")), limit: Number(url.searchParams.get("limit")), expires_at: expires } }); });
  await page.addInitScript(() => { window.print = () => { document.body.dataset.printTitle = document.querySelector(".report-print-surface h1")?.textContent ?? ""; }; }); await page.goto("/reports/snapshots/snap-1"); await expect(page.getByRole("heading", { name: "Предпросмотр отчёта" })).toBeVisible(); await page.getByRole("button", { name: "PDF / Печать всех строк" }).click(); await expect(page.locator("body")).toHaveAttribute("data-print-title", "Предпросмотр отчёта");
});

for (const denied of [false, true]) test(`редактор сохраняет черновик при восстановлении сети${denied ? " и 404" : ""}`, async ({ page }) => {
  const requests = await setup(page); let mode: "initial" | "pending" | "ready" = "initial"; let calls = 0; let release: () => void = () => {}; const pending = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/reports/1", async (route) => {
    if (route.request().method() !== "GET") return route.fallback(); calls++;
    if (mode === "initial") return route.fulfill({ json: report });
    if (mode === "pending") { await pending; if (denied) return route.fulfill({ status: 404, json: { detail: "Доступ отозван" } }); }
    return route.fulfill({ json: { ...report, version: 2, title: "Новое серверное название" } });
  });
  await page.goto("/reports/1/edit"); await page.getByLabel("Название отчёта").fill("Несохранённый секрет"); await page.getByRole("button", { name: "Добавить фильтр" }).click(); await page.getByLabel("Значение 1").fill("Черновик фильтра");
  const before = calls; mode = "pending"; await page.evaluate(() => { window.dispatchEvent(new Event("offline")); window.dispatchEvent(new Event("online")); }); await expect.poll(() => calls).toBeGreaterThan(before);
  await expect(page.getByLabel("Название отчёта")).toHaveCount(0); await expect(page.getByText("Несохранённый секрет")).toHaveCount(0); await expect(page.getByText("Черновик фильтра")).toHaveCount(0);
  release();
  if (denied) { await expect(page.getByRole("main").getByRole("alert")).toContainText("Не удалось загрузить отчёт"); await expect(page.getByLabel("Название отчёта")).toHaveCount(0); mode = "ready"; await page.getByRole("main").getByRole("button", { name: "Повторить" }).click(); }
  await expect(page.getByLabel("Название отчёта")).toHaveValue("Несохранённый секрет"); await expect(page.getByLabel("Значение 1")).toHaveValue("Черновик фильтра"); await page.getByRole("button", { name: "Сохранить отчёт" }).click(); await expect.poll(() => requests.find((r) => r.path === "/reports/1" && r.method === "PUT")?.body).toMatchObject({ version: 1, title: "Несохранённый секрет" });
});

test("пустая строка задаётся явно для eq, ne и contains и остаётся строкой", async ({ page }) => {
  const requests = await setup(page); await page.goto("/reports/new"); await page.getByLabel("Проект", { exact: true }).check();
  await page.getByRole("button", { name: "Добавить фильтр" }).click(); await page.getByRole("button", { name: "Предпросмотр", exact: true }).click(); await expect(page.getByRole("main").getByRole("alert")).toContainText("укажите значение"); expect(requests.filter((r) => r.path === "/reports/preview")).toHaveLength(0);
  await page.getByLabel("Искать пустую строку 1").check();
  for (const [i, op] of [[2, "ne"], [3, "contains"]] as const) { await page.getByRole("button", { name: "Добавить фильтр" }).click(); await page.getByLabel(`Оператор ${i}`).selectOption(op); await page.getByLabel(`Искать пустую строку ${i}`).check(); }
  await page.getByRole("button", { name: "Предпросмотр", exact: true }).click(); await expect(page.getByText("Строка 1", { exact: true })).toBeVisible();
  const body = requests.find((r) => r.path === "/reports/preview")!.body as { definition: { filters: { operator: string; value: unknown }[] } };
  expect(body.definition.filters.map(({ operator, value }) => ({ operator, value }))).toEqual([{ operator: "eq", value: "" }, { operator: "ne", value: "" }, { operator: "contains", value: "" }]);
});

test("сохранённый фильтр с пустой строкой открывается и сохраняется без изменений", async ({ page }) => {
  const requests = await setup(page); const saved = { ...report, definition: { ...definition, filters: [{ field: "project.name", operator: "eq", value: "" }] } };
  await page.route("**/api/reports/1", async (route) => route.request().method() === "GET" ? route.fulfill({ json: saved }) : route.fallback()); await page.goto("/reports/1/edit"); await expect(page.getByLabel("Искать пустую строку 1")).toBeChecked(); await expect(page.getByLabel("Значение 1")).toBeDisabled(); await page.getByRole("button", { name: "Сохранить отчёт" }).click(); await expect.poll(() => requests.find((r) => r.path === "/reports/1" && r.method === "PUT")?.body).toEqual({ title: "Мой отчёт", definition: saved.definition, version: 1 });
});


test("пустые числовые, датовые и логические фильтры требуют значение", async ({ page }) => {
  const requests = await setup(page); await page.goto("/reports/new"); await page.getByLabel("Проект", { exact: true }).check(); await page.getByRole("button", { name: "Добавить фильтр" }).click();
  for (const field of ["project.year", "project.amount", "project.date", "project.created", "project.flag", "project.stage"]) { await page.getByLabel("Поле фильтра 1").selectOption(field); await page.getByRole("button", { name: "Предпросмотр", exact: true }).click(); await expect(page.getByRole("main").getByRole("alert")).toContainText("укажите значение"); }
  await page.getByLabel("Поле фильтра 1").selectOption("project.year"); await page.getByLabel("Оператор 1").selectOption("is_null"); await page.getByRole("button", { name: "Предпросмотр", exact: true }).click(); await expect(page.getByRole("main").getByRole("alert")).toContainText("укажите значение"); expect(requests.filter((r) => r.path === "/reports/preview")).toHaveLength(0);
});
