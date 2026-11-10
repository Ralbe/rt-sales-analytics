import { expect, test, type Page } from "@playwright/test";

async function mockApi(page: Page, role = "admin") {
  const state = {
    items: [
      { id: 12, category: "payment_type", code: "existing", name: "Сервисная", is_active: true, position: 10, probability: null },
    ],
    stages: [
      { id: 101, category: "customer_stage", code: "lead", name: "1. Лид", is_active: true, position: 1, probability: 10 },
      { id: 102, category: "customer_stage", code: "lead_work", name: "2. Проработка лида", is_active: true, position: 2, probability: 20 },
      { id: 110, category: "customer_stage", code: "success", name: "10. Успех", is_active: true, position: 3, probability: 100 },
    ],
    moveRequests: 0,
    fail: false,
  };
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/auth/me") return route.fulfill({ json: { id: 1, full_name: "Тест", email: "test@example.test", role } });
    if (path === "/api/dashboards") return route.fulfill({ json: [] });
    if (path === "/api/reference-admin") return route.fulfill({ json: { payment_type: "Тип платежа", customer_stage: "Этап по ТЗ" } });
    if (path === "/api/reference-admin/payment_type" && request.method() === "GET") return route.fulfill({ json: state.items });
    if (path === "/api/reference-admin/customer_stage" && request.method() === "GET") {
      return route.fulfill({ json: [...state.stages].sort((a, b) => a.position - b.position) });
    }
    if (state.fail) return route.fulfill({ status: 409, json: { detail: "Такое название уже существует" } });
    if (path === "/api/reference-admin/payment_type" && request.method() === "POST") {
      const item = { ...state.items[0], id: 13, name: request.postDataJSON().name };
      state.items.push(item);
      return route.fulfill({ status: 201, json: item });
    }
    if (path === "/api/reference-admin/customer_stage" && request.method() === "POST") {
      const body = request.postDataJSON();
      const nonSuccess = state.stages.filter((s) => s.code !== "success").sort((a, b) => a.position - b.position);
      const success = state.stages.find((s) => s.code === "success")!;
      const created = {
        id: 200,
        category: "customer_stage",
        code: "custom_200",
        name: body.name,
        is_active: true,
        position: body.position,
        probability: body.probability,
      };
      nonSuccess.splice(body.position - 1, 0, created);
      state.stages = [...nonSuccess, success].map((s, idx) => ({ ...s, position: idx + 1 }));
      return route.fulfill({ status: 201, json: state.stages.find((s) => s.id === 200) });
    }
    const stageEdit = path.match(/customer_stage\/(\d+)$/);
    if (stageEdit && request.method() === "PUT") {
      const body = request.postDataJSON();
      const target = state.stages.find((s) => s.id === Number(stageEdit[1]))!;
      target.name = body.name;
      target.probability = body.probability;
      return route.fulfill({ json: target });
    }
    const stagePos = path.match(/customer_stage\/(\d+)\/position$/);
    if (stagePos && request.method() === "PUT") {
      state.moveRequests += 1;
      const body = request.postDataJSON();
      const target = state.stages.find((s) => s.id === Number(stagePos[1]))!;
      const nonSuccess = state.stages.filter((s) => s.code !== "success" && s.id !== target.id).sort((a, b) => a.position - b.position);
      const success = state.stages.find((s) => s.code === "success")!;
      nonSuccess.splice(body.position - 1, 0, target);
      state.stages = [...nonSuccess, success].map((s, idx) => ({ ...s, position: idx + 1 }));
      return route.fulfill({ json: state.stages.find((s) => s.id === target.id) });
    }
    const stageActive = path.match(/customer_stage\/(\d+)\/active$/);
    if (stageActive && request.method() === "PUT") {
      const body = request.postDataJSON();
      const target = state.stages.find((s) => s.id === Number(stageActive[1]))!;
      target.is_active = body.is_active;
      if (body.name !== undefined) target.name = body.name;
      if (body.probability !== undefined) target.probability = body.probability;
      if (body.position !== undefined) {
        const nonSuccess = state.stages.filter((s) => s.code !== "success" && s.id !== target.id).sort((a, b) => a.position - b.position);
        const success = state.stages.find((s) => s.code === "success")!;
        nonSuccess.splice(body.position - 1, 0, target);
        state.stages = [...nonSuccess, success].map((s, idx) => ({ ...s, position: idx + 1 }));
      }
      return route.fulfill({ json: state.stages.find((s) => s.id === target.id) });
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
  await page.getByRole("button", { name: "Добавить", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Такое название уже существует" })).toBeVisible();
  await expect(page.getByLabel("Новое значение")).toHaveValue("Тестовый платёж");
  state.fail = false;
  await page.getByRole("button", { name: "Добавить", exact: true }).click();
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
  await expect(page.getByRole("button", { name: "Добавить", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Добавить этап", exact: true })).toBeVisible();
});

test("управление этапами проектов: создание, редактирование, отключение, включение, перемещение и отмена", async ({ page }) => {
  const state = await mockApi(page);
  await page.goto("/settings/references");
  await page.getByRole("tab", { name: "Этапы проектов" }).click();

  // Системный этап Успех помечен бейджем и не может быть отключён или перемещён
  await expect(page.getByText("Системный / Успех")).toBeVisible();
  await expect(page.getByRole("button", { name: "Отключить: 10. Успех" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Переместить выше: 10. Успех" })).toBeDisabled();

  // Создание нового этапа через модалку
  await page.getByRole("button", { name: "Добавить этап" }).click();
  const createDialog = page.getByRole("dialog", { name: "Добавить этап" });
  await createDialog.getByLabel("Название этапа").fill("3. КП и расчёт");
  await createDialog.getByLabel("Вероятность (%)").fill("35");
  await createDialog.getByLabel("Позиция в списке").selectOption("2");
  await createDialog.getByRole("button", { name: "Создать этап" }).click();
  await expect(page.getByRole("cell", { name: "3. КП и расчёт", exact: true })).toBeVisible();

  // Перемещение кнопкой вниз -> Отмена не отправляет запрос
  await page.getByRole("button", { name: "Переместить ниже: 1. Лид" }).click();
  const moveDialog = page.getByRole("dialog", { name: "Подтверждение изменения порядка этапов" });
  await expect(moveDialog).toContainText("Старая позиция: 1 → Новая позиция: 2");
  await expect(moveDialog).toContainText("Новый порядок применяется только к будущим переходам проектов");
  await moveDialog.getByRole("button", { name: "Отмена" }).click();
  expect(state.moveRequests).toBe(0);

  // Перемещение кнопкой вниз -> Подтверждение
  await page.getByRole("button", { name: "Переместить ниже: 1. Лид" }).click();
  await page.getByRole("dialog", { name: "Подтверждение изменения порядка этапов" })
    .getByRole("button", { name: "Подтвердить перемещение" }).click();
  await expect.poll(() => state.moveRequests).toBe(1);

  // Отключение и повторное включение этапа через модальные окна
  await page.getByRole("button", { name: "Отключить: 1. Лид" }).click();
  await page.getByRole("dialog", { name: "Отключить этап" })
    .getByRole("button", { name: "Подтвердить отключение" }).click();
  await expect(page.getByRole("button", { name: "Включить: 1. Лид" })).toBeVisible();

  await page.getByRole("button", { name: "Включить: 1. Лид" }).click();
  const activateDialog = page.getByRole("dialog", { name: "Включить этап" });
  await activateDialog.getByLabel("Название этапа").fill("1. Лид обновлённый");
  await activateDialog.getByLabel("Вероятность (%)").fill("15");
  await activateDialog.getByRole("button", { name: "Подтвердить включение" }).click();
  await expect(page.getByRole("cell", { name: "1. Лид обновлённый", exact: true })).toBeVisible();
});

test("пользователь не получает административный экран", async ({ page }) => {
  await mockApi(page, "user");
  await page.goto("/settings/references");
  await expect(page.getByRole("alert").filter({ hasText: "только администратору" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Добавить" })).toHaveCount(0);
});
