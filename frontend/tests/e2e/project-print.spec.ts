import { expect, test, type Page } from "@playwright/test";

import type { FinancialEntry, Project, Refs, User } from "../../src/lib/types";

test.use({ timezoneId: "Europe/Volgograd" });

const USER: User = { id: 7, email: "card-print@example.test", full_name: "Мария Продажина", role: "analyst" };
const REFS: Refs = {
  segments: [{ id: 1, name: "Корпоративные клиенты" }],
  managers: [{ id: USER.id, full_name: USER.full_name }],
  services: [{ id: 3, name: "Защищённый интернет", group_name: "Связь" }],
  stages: [{ id: "proposal", name: "Предложение", probability: 50 }],
  payment_types: [{ id: 4, name: "Периодический" }],
  customer_stages: [{ id: 5, name: "Утверждение условий", probability: 63 }],
  assessment_statuses: [{ id: 6, name: "Принят к оценке" }],
  project_indicators: [{ id: 8, name: "Приоритетный" }],
  revenue_statuses: [{ id: 9, name: "Плановое начисление" }],
  cost_statuses: [{ id: 10, name: "Согласованные затраты" }],
  cost_articles: [{ id: 11, name: "Оборудование" }], cost_types: [{ id: 12, name: "Разовые" }], roles: [],
};
const PROJECT: Project = {
  id: 41, name: "Проект — Волгоград", description: "Сохранённая суть проекта\nВторая строка описания",
  client: { id: 2, name: "ООО «Связь и промышленность»" }, segment: REFS.segments[0], manager: REFS.managers[0], service: REFS.services[0],
  stage: "proposal", amount: "999999999999.99", cost: "123456789012.30", margin: "876543210987.69", margin_pct: 87.65432109885665, probability: 63,
  start_date: "2026-01-01", expected_close_date: "2027-12-31", closed_at: "2026-10-25",
  payment_type: REFS.payment_types[0], customer_stage: REFS.customer_stages[0], indicator: REFS.project_indicators[0],
  accepted_for_forecast: true, assessment_status: REFS.assessment_statuses[0], subsidiary_implementation: false,
  management_control: true, is_industry_solution: true, industry_manager: "Иван Отраслевой", industry_project_number: "ОТР-001/А",
  implementation_year: 2027, project_status: "Подключение", realized_work: "Согласован договор", period_plan: "Завершить подключение",
  created_at: "2026-01-01T00:30:15Z", updated_at: "2026-10-25T22:30:45Z",
  financial_entries: [
    { id: 100, kind: "revenue", year: 2026, month: 1, amount: "999999999999.999", vat_included: true, status: { id: 9, name: "Сохранённый статус выручки" }, article: null, cost_type: null },
    { id: 101, kind: "cost", year: 2027, month: 12, amount: "0.010", vat_included: false, status: { id: 10, name: "Сохранённый статус затрат" }, article: { id: 11, name: "Сохранённая статья" }, cost_type: { id: 12, name: "Сохранённый вид" } },
  ],
};

type Source = "project" | "refs" | "me";
const paths: Record<Source, string> = { project: "/projects/41", refs: "/refs", me: "/auth/me" };
const button = (page: Page) => page.getByRole("button", { name: "PDF / Печать карточки", exact: true });
const report = (page: Page) => page.locator("[data-project-print]");
const field = (page: Page, key: string) => report(page).locator(`[data-project-field="${key}"] dd`);

async function openProject(page: Page, options: { project?: Project; gate?: { source: Source; wait: Promise<void> }; error?: Source; role?: User["role"]; printError?: boolean } = {}) {
  const state = {
    project: structuredClone(options.project ?? PROJECT), refs: structuredClone(REFS),
    errors: { project: options.error === "project" ? 503 : 0, refs: options.error === "refs" ? 503 : 0, me: options.error === "me" ? 503 : 0 },
    requests: [] as string[], unexpected: [] as string[],
  };
  await page.clock.install({ time: new Date("2026-10-26T09:30:00Z") });
  await page.addInitScript(({ throwPrint }) => {
    const state = window as typeof window & { printCalls: number; printReady?: string; printText?: string };
    state.printCalls = 0;
    window.print = () => {
      state.printCalls++;
      const surface = document.querySelector<HTMLElement>("[data-project-print]");
      state.printReady = surface?.dataset.ready;
      state.printText = surface?.textContent ?? "";
      if (throwPrint) throw new Error("Тестовая ошибка печати");
    };
  }, { throwPrint: options.printError ?? false });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^\/api/, "");
    state.requests.push(`${request.method()} ${path}`);
    if (request.method() !== "GET") {
      state.unexpected.push(`${request.method()} ${path}`);
      return route.fulfill({ status: 405, json: { detail: "Печать не должна сохранять данные" } });
    }
    const source = (Object.keys(paths) as Source[]).find((key) => paths[key] === path);
    if (source) {
      if (options.gate?.source === source) await options.gate.wait;
      if (state.errors[source]) return route.fulfill({ status: state.errors[source], json: { detail: "Данные недоступны" } });
      return route.fulfill({ json: source === "project" ? state.project : source === "refs" ? state.refs : { ...USER, role: options.role ?? USER.role } });
    }
    if (path === "/dashboards") return route.fulfill({ json: [] });
    if (path === "/clients") return route.fulfill({ json: [{ ...PROJECT.client, inn: "7707083893", segment: REFS.segments[0] }] });
    if (path === "/projects/check-name") return route.fulfill({ json: { available: true } });
    if (path === "/projects/41/history") return route.fulfill({ json: { items: [], limit: 10, offset: 0, has_more: false } });
    state.unexpected.push(`${request.method()} ${path}`);
    return route.fulfill({ status: 500, json: { detail: `Неожиданный запрос: ${path}` } });
  });
  await page.goto("/projects/41");
  return state;
}

async function preparePrint(page: Page, count = 1) {
  await expect(button(page)).toBeEnabled();
  await button(page).click();
  await expect.poll(() => page.evaluate(() => (window as typeof window & { printCalls: number }).printCalls)).toBe(count);
  await expect(report(page)).toHaveAttribute("data-ready", "true");
  expect(await page.evaluate(() => (window as typeof window & { printReady: string }).printReady)).toBe("true");
  return report(page);
}

async function closePrint(page: Page) {
  await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
  await expect(report(page)).toHaveAttribute("data-ready", "false");
  await expect(report(page)).toBeEmpty();
}

async function reconnect(page: Page) {
  await page.clock.fastForward(6 * 60_000);
  await page.evaluate(() => { window.dispatchEvent(new Event("offline")); window.dispatchEvent(new Event("online")); });
}

test("отзыв доступа к проекту после загрузки запрещает печать", async ({ page }) => {
  const state = await openProject(page);
  await expect(button(page)).toBeEnabled();
  state.errors.project = 404;
  await button(page).click();
  await expect(page.locator("#project-print-hint")).toContainText("Печать недоступна");
  expect(await page.evaluate(() => (window as typeof window & { printCalls: number }).printCalls)).toBe(0);
});

test("ошибка справочников во время проверки освобождает подготовку печати", async ({ page }) => {
  const state = await openProject(page);
  await expect(button(page)).toBeEnabled();
  let release = () => {}; let waiting = false;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/projects/41", async (route) => { waiting = true; await gate; return route.fallback(); });
  await button(page).click();
  await expect.poll(() => waiting).toBe(true);
  state.errors.refs = 503;
  await reconnect(page);
  await expect(page.locator("#project-print-hint")).toContainText("Печать недоступна");
  release();
  await expect(page.locator("#project-print-hint")).toContainText("данные или доступ изменились");
  await expect(report(page)).toBeEmpty();
  state.errors.refs = 0;
  await reconnect(page);
  await expect(button(page)).toBeEnabled();
  await preparePrint(page);
});

for (const source of ["project", "refs", "me"] as const) {
  test(`печать ждёт загрузки ${source} и не выводит форму через меню браузера`, async ({ page }) => {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    await openProject(page, { gate: { source, wait } });
    try {
      if (source === "me") {
        await expect(button(page)).toHaveCount(0);
        await expect(page.locator("form")).toHaveCount(0);
      } else {
        await expect(button(page)).toBeDisabled();
        await page.emulateMedia({ media: "print" });
        await expect(page.locator(".app")).toBeHidden();
        await expect(report(page)).toBeEmpty();
        expect(await report(page).evaluate((node) => getComputedStyle(node, "::before").content)).toContain("Печатная карточка не подготовлена");
        await page.emulateMedia({ media: "screen" });
      }
    } finally { release(); }
    await expect(button(page)).toBeEnabled();
  });

  test(`ошибка ${source} с уже закэшированными данными запрещает печать и удаляет снимок`, async ({ page }) => {
    const state = await openProject(page);
    await preparePrint(page);
    state.errors[source] = 503;
    await reconnect(page);
    await expect(button(page)).toBeDisabled();
    await expect(report(page)).toBeEmpty();
    await expect(report(page)).toHaveAttribute("data-ready", "false");
    await page.emulateMedia({ media: "print" });
    await expect(page.locator(".app")).toBeHidden();
    expect(await report(page).evaluate((node) => getComputedStyle(node, "::before").content)).toContain("Печатная карточка не подготовлена");
    expect(state.unexpected).toEqual([]);
  });
}

test("AT-103: снимок содержит сохранённые поля, точные Decimal, даты и отдельные финансы", async ({ page }) => {
  const state = await openProject(page);
  await expect(page.getByLabel(/Название проекта/)).toHaveValue(PROJECT.name);
  await page.getByLabel("Суть проекта").fill("НЕСОХРАНЁННАЯ СУТЬ");
  await page.getByLabel("Планы на период").fill("НЕСОХРАНЁННЫЙ ПЛАН");
  await page.getByLabel(/Сумма контракта/).fill("111.11");
  await page.getByLabel("Сумма, тыс. ₽").first().fill("2.222");
  await expect(page.locator("#project-print-hint")).toContainText("Печатаются только сохранённые данные");
  await expect.poll(() => state.requests.includes("GET /projects/check-name")).toBe(true);
  // Печать повторно проверяет доступ только через локальный API.
  const network: string[] = [];
  page.on("request", (request) => network.push(`${request.method()} ${request.url()}`));
  const printed = await preparePrint(page);
  await expect(printed.locator("h1")).toHaveText(PROJECT.name);
  await expect(printed).toContainText("Дата формирования: 26.10.2026, 12:30:00");
  const expected = {
    id: "41", name: PROJECT.name, client: PROJECT.client.name, segment: PROJECT.segment.name, manager: USER.full_name,
    service: PROJECT.service.name, service_group: "Связь", payment_type: "Периодический", description: PROJECT.description,
    stage: "Предложение", customer_stage: "Утверждение условий", probability: "63", implementation_year: "2027",
    indicator: "Приоритетный", accepted_for_forecast: "Да", assessment_status: "Принят к оценке", subsidiary_implementation: "Нет",
    management_control: "Да", is_industry_solution: "Да", industry_manager: "Иван Отраслевой", industry_project_number: "ОТР-001/А",
    start_date: "01.01.2026", expected_close_date: "31.12.2027", closed_at: "25.10.2026",
    created_at: "01.01.2026, 03:30:15", updated_at: "26.10.2026, 01:30:45",
    amount: PROJECT.amount, cost: PROJECT.cost, margin: PROJECT.margin, margin_pct: String(PROJECT.margin_pct),
    project_status: PROJECT.project_status!, realized_work: PROJECT.realized_work, period_plan: PROJECT.period_plan,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (key.endsWith("_at") && key !== "closed_at") await expect(field(page, key)).toContainText(value);
    else await expect(field(page, key)).toHaveText(value);
  }
  const revenue = printed.locator('[data-project-finance="revenue"]');
  const costs = printed.locator('[data-project-finance="cost"]');
  await expect(revenue.locator("tbody tr")).toHaveCount(1);
  await expect(revenue).toContainText("999999999999.999");
  await expect(revenue).toContainText("С НДС");
  await expect(revenue).toContainText("Сохранённый статус выручки");
  await expect(revenue).toContainText("01.2026");
  await expect(costs).toContainText("0.010");
  await expect(costs).toContainText("Без НДС");
  await expect(costs).toContainText("Сохранённый статус затрат");
  await expect(costs).toContainText("Сохранённая статья");
  await expect(costs).toContainText("Сохранённый вид");
  await expect(costs).toContainText("12.2027");
  await expect(printed).not.toContainText("НЕСОХРАНЁНН");
  await expect(printed.locator("input, textarea, select, button, [contenteditable]")).toHaveCount(0);
  expect(network.map((entry) => new URL(entry.split(" ")[1]).pathname).sort()).toEqual(["/api/auth/me", "/api/projects/41"]);
  expect(state.unexpected).toEqual([]);
  await closePrint(page);
  await expect(page.getByLabel("Суть проекта")).toHaveValue("НЕСОХРАНЁННАЯ СУТЬ");
  await expect(page.getByLabel("Сумма, тыс. ₽").first()).toHaveValue("2.222");
});

test("снимок неизменен при обновлении проекта и справочников; повторная печать берёт новый снимок", async ({ page }) => {
  const state = await openProject(page);
  const printed = await preparePrint(page);
  const captured = await printed.textContent();
  state.project.name = "Обновлённое сохранённое название";
  state.project.financial_entries[0].amount = "123.456";
  state.refs.stages[0].name = "Переименованная стадия";
  await reconnect(page);
  await expect(page.locator(".page-header h1")).toHaveText(state.project.name);
  await expect.poll(() => state.requests.filter((request) => request === "GET /refs").length).toBe(2);
  expect(await printed.textContent()).toBe(captured);
  await closePrint(page);
  await preparePrint(page, 2);
  await expect(printed.locator("h1")).toHaveText(state.project.name);
  await expect(printed).toContainText("123.456");
  await expect(field(page, "stage")).toHaveText("Переименованная стадия");
  expect(state.unexpected).toEqual([]);
});

test("многостраничная A4 карточка сохраняет длинную кириллицу, строки и текст разметки без обрезки", async ({ page, browserName }, testInfo) => {
  const unsafe = '<img src="https://print.invalid/x" onerror="window.printXss=true"><script>window.printXss=true</script>';
  const unbroken = "ДлиннаяКириллическаяСтрокаБезПробелов".repeat(40);
  const project = structuredClone(PROJECT);
  project.name = `Связь — ${"модернизация инфраструктуры ".repeat(8)}`;
  project.description = `${unsafe}\n${unbroken}\n${"Описание проекта: связь и производство.\n".repeat(100)}КОНЕЦ ОПИСАНИЯ`;
  project.realized_work = "Согласовано подключение филиала.\n".repeat(80) + "КОНЕЦ РАБОТ";
  project.period_plan = "Выполнить проверку оборудования.\n".repeat(80) + "КОНЕЦ ПЛАНОВ";
  project.financial_entries = Array.from({ length: 80 }, (_, index) => ({
    ...PROJECT.financial_entries[index % 2], id: index + 1, year: 2026 + Math.floor(index / 12), month: index % 12 + 1,
    status: { id: index + 1, name: `Статус строки ${index + 1}: ${index === 79 ? unbroken : "Подтверждённые начисления филиала"}` },
    created_at: "2026-01-01T00:30:15Z", updated_at: "2026-10-25T22:30:45Z",
  }));
  const state = await openProject(page, { project });
  const printed = await preparePrint(page);
  await page.emulateMedia({ media: "print" });
  await expect(page.locator(".app")).toBeHidden();
  await expect(printed).toBeVisible();
  await expect(printed.locator("tbody tr")).toHaveCount(80);
  await expect(field(page, "description")).toHaveText(project.description);
  await expect(printed).toContainText("КОНЕЦ РАБОТ");
  await expect(printed).toContainText("КОНЕЦ ПЛАНОВ");
  await expect(printed).toContainText("Статус строки 80:");
  await expect(printed).toContainText("Дата создания: 01.01.2026, 03:30:15");
  await expect(printed).toContainText("Дата изменения: 26.10.2026, 01:30:45");
  await expect(printed.locator("img, script, input, select, textarea, button")).toHaveCount(0);
  expect(await page.evaluate(() => (window as typeof window & { printXss?: boolean }).printXss)).toBeUndefined();
  const clipping = await printed.evaluate((root) => {
    const clipped: string[] = [];
    for (const element of [document.documentElement, document.body, root, ...root.querySelectorAll("section, dl, dd, table, th, td")]) {
      const style = getComputedStyle(element);
      if ([style.overflowX, style.overflowY].some((value) => ["hidden", "clip", "scroll", "auto"].includes(value)) || element.scrollWidth > element.clientWidth + 1) clipped.push(element.tagName);
    }
    return clipped;
  });
  expect(clipping).toEqual([]);
  expect(await printed.locator("thead").first().evaluate((node) => getComputedStyle(node).display)).toBe("table-header-group");
  expect(await field(page, "description").evaluate((node) => getComputedStyle(node).whiteSpace)).toBe("pre-wrap");
  if (browserName === "chromium") {
    const path = testInfo.outputPath("project-card-a4.pdf");
    const pdf = await page.pdf({ path, preferCSSPageSize: true, printBackground: true });
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.toString("latin1").match(/\/Type\s*\/Page\b/g)?.length ?? 0).toBeGreaterThan(3);
    const boxes = [...pdf.toString("latin1").matchAll(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/g)];
    expect(boxes.length).toBeGreaterThan(0);
    for (const box of boxes) { expect(Number(box[1])).toBeCloseTo(595, -1); expect(Number(box[2])).toBeCloseTo(842, -1); }
    await testInfo.attach("Карточка проекта A4", { path, contentType: "application/pdf" });
  }
  expect(state.unexpected).toEqual([]);
});

test("пустые финансы и необязательные поля обозначены явно; отсутствующий справочник не подменяется", async ({ page }) => {
  const project = { ...PROJECT, financial_entries: [], closed_at: null, payment_type: null, industry_manager: null, industry_project_number: null, implementation_year: null, stage: "won" as const };
  await openProject(page, { project, role: "user" });
  const printed = await preparePrint(page);
  await expect(field(page, "closed_at")).toHaveText("Не указано");
  await expect(field(page, "payment_type")).toHaveText("Не указано");
  await expect(field(page, "industry_project_number")).toHaveText("Не указано");
  await expect(field(page, "stage")).toHaveText("Недоступное значение (won)");
  await expect(printed.getByText("Нет сохранённых строк.", { exact: true })).toHaveCount(2);
});

test("финансовые ссылки разрешаются по своему справочнику и неизвестный ID остаётся явным", async ({ page }) => {
  const financial_entries: FinancialEntry[] = [
    { ...PROJECT.financial_entries[0], status: undefined, status_id: 9 },
    { ...PROJECT.financial_entries[1], status: undefined, status_id: 10, article: undefined, article_id: 11, cost_type: undefined, cost_type_id: 12 },
    { ...PROJECT.financial_entries[0], id: 102, status: undefined, status_id: 999 },
  ];
  await openProject(page, { project: { ...PROJECT, financial_entries } });
  const printed = await preparePrint(page);
  await expect(printed).toContainText("Плановое начисление");
  await expect(printed).toContainText("Согласованные затраты");
  await expect(printed).toContainText("Оборудование");
  await expect(printed).toContainText("Разовые");
  await expect(printed).toContainText("Недоступное значение (ID 999)");
});

test("admin может напечатать сохранённую архивную карточку без редактирования", async ({ page }) => {
  const archived = { ...PROJECT, archived_at: "2026-10-26T08:00:00Z" };
  const state = await openProject(page, { project: archived, role: "admin" });
  const printed = await preparePrint(page);
  await expect(printed.locator("h1")).toHaveText(PROJECT.name);
  await expect(field(page, "amount")).toHaveText(PROJECT.amount);
  await expect(printed.locator("input, select, textarea, button")).toHaveCount(0);
  expect(state.requests.every((request) => request.startsWith("GET "))).toBe(true);
  expect(state.unexpected).toEqual([]);
});

test("401 защищённого ресурса удаляет подготовленную печать даже со свежим me", async ({ page }) => {
  const state = await openProject(page);
  await preparePrint(page);
  state.errors.project = 401;
  // Кэш проекта уже устарел, а профиль ещё свежий: проверяем именно 401 проекта.
  await page.clock.fastForward(35_000);
  await page.evaluate(() => { window.dispatchEvent(new Event("offline")); window.dispatchEvent(new Event("online")); });
  await expect(report(page)).toHaveCount(0);
  await expect(button(page)).toHaveCount(0);
  await expect(page.locator("form.card")).toHaveCount(0);
  await page.emulateMedia({ media: "print" });
  await expect(page.locator("body")).not.toContainText(PROJECT.name);
  await expect(page.locator("body")).not.toContainText(PROJECT.financial_entries[0].amount);
  expect(state.requests.filter((request) => request === "GET /auth/me")).toHaveLength(2);
});

test("ошибка window.print освобождает снимок и оставляет повтор доступным", async ({ page }) => {
  await openProject(page, { printError: true });
  await expect(button(page)).toBeEnabled();
  await button(page).click();
  await expect(page.locator("#project-print-hint")).toContainText("Браузер не смог открыть печать");
  await expect(report(page)).toBeEmpty();
  await expect(button(page)).toBeEnabled();
});

for (const stageScheme of ["legacy", "customer"] as const) {
  test("nullable stage в печати: «Не применяется» для схемы " + stageScheme + ", без соответствия 6↔10", async ({ page }) => {
    const state = await openProject(page, { project: { ...PROJECT, stage_scheme: stageScheme, stage: null } });
    await preparePrint(page);
    await expect(field(page, "stage")).toHaveText("Не применяется");
    await expect(field(page, "customer_stage")).toHaveText(PROJECT.customer_stage!.name);
    await expect(field(page, "probability")).toHaveText(String(PROJECT.probability));
    if (stageScheme === "customer") {
      await expect(report(page).locator("[data-completion-state]")).toHaveText("Состояние завершения: не определено");
    } else {
      await expect(report(page).locator("[data-completion-state]")).toHaveCount(0);
    }
    expect(state.requests.every((request) => request.startsWith("GET "))).toBe(true);
    expect(state.unexpected).toEqual([]);
  });
}

test("customer с этапом «Успех» и вероятностью 100 сохраняет неопределённое завершение в карточке и PDF", async ({ page }) => {
  const state = await openProject(page, { project: {
    ...PROJECT, stage_scheme: "customer", stage: null, closed_at: null, probability: 100,
    customer_stage: { ...REFS.customer_stages[0], name: "Успех" },
  } });
  await expect(page.locator("form [data-completion-state]")).toHaveText("Состояние завершения: не определено");
  await preparePrint(page);
  await expect(field(page, "customer_stage")).toHaveText("Успех");
  await expect(field(page, "probability")).toHaveText("100");
  await expect(field(page, "closed_at")).toHaveText("Не указано");
  await expect(report(page).locator("[data-completion-state]")).toHaveText("Состояние завершения: не определено");
  expect(state.project.closed_at).toBeNull();
  expect(state.unexpected).toEqual([]);
});
