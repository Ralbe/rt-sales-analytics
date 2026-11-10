import pytest
from conftest import login
from sqlalchemy import select
from test_project_history import _finance
from test_projects import _payload

from app.models import AuditLog, ReferenceValue


@pytest.fixture
def admin(client, db):
    login(client, db, "admin@example.com")
    return client


@pytest.mark.parametrize("email", ["analyst@example.com", "manager1@example.com"])
def test_admin_endpoints_reject_non_admin(client, db, email):
    login(client, db, email)
    assert client.get("/api/reference-admin").status_code == 403
    assert client.get("/api/reference-admin/payment_type").status_code == 403
    assert client.post("/api/reference-admin/payment_type", json={"name": "А"}).status_code == 403
    assert client.put("/api/reference-admin/payment_type/1/name", json={"name": "А"}).status_code == 403
    assert client.put("/api/reference-admin/payment_type/1/active", json={"is_active": False}).status_code == 403


def test_admin_lifecycle_allowlist_audit_and_stage_guard(admin, db):
    assert admin.post("/api/reference-admin/roles", json={"name": "А"}).status_code == 404
    assert admin.post("/api/reference-admin/customer_stage", json={"name": "А"}).status_code == 422
    assert admin.post("/api/reference-admin/payment_type", json={"name": "А", "code": "x"}).status_code == 422
    response = admin.post("/api/reference-admin/payment_type", json={"name": " Новый платёж "})
    assert response.status_code == 201, response.text
    item = response.json()
    item_id = item["id"]
    assert item["name"] == "Новый платёж"
    created = admin.post("/api/projects", json=_payload(db, payment_type_id=item_id))
    assert created.status_code == 201, created.text
    assert created.json()["payment_type"]["id"] == item_id
    assert admin.post("/api/reference-admin/payment_type", json={"name": "новый ПЛАТЁЖ"}).status_code == 409
    assert admin.put(f"/api/reference-admin/cost_type/{item_id}/name", json={"name": "X"}).status_code == 404
    assert admin.put(f"/api/reference-admin/payment_type/{item_id}/name", json={"name": "Изменён"}).status_code == 200
    assert (
        admin.put(f"/api/reference-admin/payment_type/{item_id}/active", json={"is_active": False}).status_code == 200
    )
    assert item_id not in [x["id"] for x in admin.get("/api/refs").json()["payment_types"]]
    assert (
        admin.put(f"/api/reference-admin/payment_type/{item_id}/active", json={"is_active": False}).status_code == 200
    )
    assert admin.put(f"/api/reference-admin/payment_type/{item_id}/active", json={"is_active": True}).status_code == 200
    row = db.get(ReferenceValue, item_id)
    assert (row.id, row.code, row.name, row.is_active) == (item_id, item["code"], "Изменён", True)
    logs = db.scalars(select(AuditLog).where(AuditLog.entity == "reference_value", AuditLog.entity_id == item_id)).all()
    assert len(logs) == 4
    assert logs[1].payload["before"]["name"] == "Новый платёж"
    assert logs[1].payload["after"]["name"] == "Изменён"
    assert admin.delete(f"/api/reference-admin/payment_type/{item_id}").status_code == 404
    success_stage = db.scalar(
        select(ReferenceValue).where(
            ReferenceValue.category == "customer_stage", ReferenceValue.code == "success"
        )
    )
    assert (
        admin.put(
            f"/api/reference-admin/customer_stage/{success_stage.id}/active", json={"is_active": False}
        ).status_code
        == 409
    )
    stage = db.scalar(
        select(ReferenceValue).where(
            ReferenceValue.category == "customer_stage", ReferenceValue.code != "success"
        )
    )
    prior = (stage.code, stage.position, stage.probability, stage.is_active)
    assert (
        admin.put(
            f"/api/reference-admin/customer_stage/{stage.id}/name", json={"name": "Этап переименован"}
        ).status_code
        == 200
    )
    assert (stage.code, stage.position, stage.probability, stage.is_active) == prior


def test_inactive_project_and_finance_retained_but_new_assignments_rejected(admin, db):
    ref = db.scalar(select(ReferenceValue).where(ReferenceValue.category == "payment_type"))
    finance = _finance(db, "cost", amount="12.345")
    payload = _payload(db, payment_type_id=ref.id, financial_entries=[finance])
    created = admin.post("/api/projects", json=payload)
    assert created.status_code == 201, created.text
    project = created.json()
    status_id = finance["status_id"]
    assert admin.put(f"/api/reference-admin/payment_type/{ref.id}/active", json={"is_active": False}).status_code == 200
    assert (
        admin.put(f"/api/reference-admin/cost_status/{status_id}/active", json={"is_active": False}).status_code == 200
    )
    read = admin.get(f"/api/projects/{project['id']}").json()
    assert read["payment_type"]["id"] == ref.id
    assert read["financial_entries"][0]["status"]["id"] == status_id
    unchanged = admin.put(f"/api/projects/{project['id']}", json=payload | {"description": "Изменено"})
    assert unchanged.status_code == 200, unchanged.text
    row_id = unchanged.json()["financial_entries"][0]["id"]
    edited = finance | {"id": row_id, "amount": "55.000"}
    result = admin.put(f"/api/projects/{project['id']}/financial-entries", json=[edited])
    assert result.status_code == 200, result.text
    row_id = result.json()[0]["id"]
    duplicate = edited | {"id": row_id}
    assert admin.put(f"/api/projects/{project['id']}/financial-entries", json=[duplicate, duplicate]).status_code == 422
    assert admin.put(f"/api/projects/{project['id']}/financial-entries", json=[duplicate, finance]).status_code == 422
    assert admin.post("/api/projects", json=payload | {"name": "Другой проект"}).status_code == 422
    assert (
        admin.put(f"/api/projects/{project['id']}/financial-entries", json=[finance | {"id": 999999}]).status_code
        == 422
    )


def test_audit_failure_rolls_back_change(admin, db, monkeypatch):
    from app.api import reference_admin

    row = db.scalar(select(ReferenceValue).where(ReferenceValue.category == "payment_type"))
    name = row.name

    def fail(*args, **kwargs):
        raise RuntimeError("audit failed")

    monkeypatch.setattr(reference_admin.audit, "record", fail)
    with pytest.raises(RuntimeError):
        admin.put(f"/api/reference-admin/payment_type/{row.id}/name", json={"name": "Не сохранять"})
    assert db.get(ReferenceValue, row.id).name == name


def test_rename_preserves_project_identity_and_historical_snapshot(admin, db):
    ref = db.scalar(select(ReferenceValue).where(ReferenceValue.category == "payment_type"))
    original_name = ref.name
    created = admin.post("/api/projects", json=_payload(db, payment_type_id=ref.id))
    assert created.status_code == 201, created.text
    project_id = created.json()["id"]
    assert (
        admin.put(f"/api/reference-admin/payment_type/{ref.id}/name", json={"name": "Другое название"}).status_code
        == 200
    )
    current = admin.get(f"/api/projects/{project_id}").json()
    assert current["payment_type"] == {"id": ref.id, "name": "Другое название"}
    history = admin.get(f"/api/projects/{project_id}/history").json()["items"]
    assert (
        next(change for change in history[0]["changes"] if change["field"] == "payment_type_id")["after"]
        == original_name
    )


@pytest.mark.parametrize(
    ("field", "category"),
    [
        ("payment_type_id", "payment_type"),
        ("indicator_id", "project_indicator"),
        ("assessment_status_id", "assessment_status"),
    ],
)
def test_inactive_project_references_are_only_retained(admin, db, field, category):
    ref = db.scalar(select(ReferenceValue).where(ReferenceValue.category == category))
    payload = _payload(db, **{field: ref.id}, accepted_for_forecast=True)
    created = admin.post("/api/projects", json=payload)
    assert created.status_code == 201, created.text
    assert admin.put(f"/api/reference-admin/{category}/{ref.id}/active", json={"is_active": False}).status_code == 200
    updated = admin.put(f"/api/projects/{created.json()['id']}", json=payload | {"description": "Изменено"})
    assert updated.status_code == 200, updated.text
    assert admin.post("/api/projects", json=payload | {"name": "Новый проект"}).status_code == 422


@pytest.mark.parametrize(
    ("kind", "field", "category"),
    [
        ("revenue", "status_id", "revenue_status"),
        ("cost", "status_id", "cost_status"),
        ("cost", "article_id", "cost_article"),
        ("cost", "cost_type_id", "cost_type"),
    ],
)
def test_inactive_financial_references_are_only_retained(admin, db, kind, field, category):
    row = _finance(db, kind)
    created = admin.post("/api/projects", json=_payload(db, financial_entries=[row]))
    assert created.status_code == 201, created.text
    project_id = created.json()["id"]
    row_id = created.json()["financial_entries"][0]["id"]
    assert (
        admin.put(f"/api/reference-admin/{category}/{row[field]}/active", json={"is_active": False}).status_code == 200
    )
    result = admin.put(f"/api/projects/{project_id}/financial-entries", json=[row | {"id": row_id, "year": 2028}])
    assert result.status_code == 200, result.text
    assert admin.put(f"/api/projects/{project_id}/financial-entries", json=[row]).status_code == 422


def test_customer_stage_create_positions_validation_and_uniqueness(admin, db):
    stages = admin.get("/api/reference-admin/customer_stage").json()
    assert [s["position"] for s in stages] == list(range(1, len(stages) + 1))
    assert stages[-1]["code"] == "success"

    # Негативные проверки probability и position
    for bad_prob in (-1, 101, 12.5, "50", True, None):
        r = admin.post(
            "/api/reference-admin/customer_stage",
            json={"name": "Неверная вероятность", "probability": bad_prob, "position": 1},
        )
        assert r.status_code == 422
    for bad_pos in (0, -1, len(stages) + 1, "1", True, None):
        r = admin.post(
            "/api/reference-admin/customer_stage",
            json={"name": "Неверная позиция", "probability": 25, "position": bad_pos},
        )
        assert r.status_code == 422

    # Граничные значения 0% в начале (position=1) и 100% перед success (position=len(stages))
    r_first = admin.post(
        "/api/reference-admin/customer_stage",
        json={"name": " Нулевой старт ", "probability": 0, "position": 1},
    )
    assert r_first.status_code == 201, r_first.text
    first_item = r_first.json()
    assert (first_item["name"], first_item["probability"], first_item["position"]) == ("Нулевой старт", 0, 1)

    stages_after_first = admin.get("/api/reference-admin/customer_stage").json()
    assert [s["position"] for s in stages_after_first] == list(range(1, len(stages_after_first) + 1))
    assert stages_after_first[-1]["code"] == "success"

    r_mid = admin.post(
        "/api/reference-admin/customer_stage",
        json={"name": "Промежуточный этап", "probability": 45, "position": 4},
    )
    assert r_mid.status_code == 201, r_mid.text
    assert r_mid.json()["position"] == 4

    stages_before_last = admin.get("/api/reference-admin/customer_stage").json()
    r_before_success = admin.post(
        "/api/reference-admin/customer_stage",
        json={"name": "Предфинальный этап", "probability": 100, "position": len(stages_before_last)},
    )
    assert r_before_success.status_code == 201, r_before_success.text

    final_stages = admin.get("/api/reference-admin/customer_stage").json()
    assert [s["position"] for s in final_stages] == list(range(1, len(final_stages) + 1))
    assert final_stages[-1]["code"] == "success"
    assert final_stages[-2]["name"] == "Предфинальный этап"

    # Дубликаты имени (case-insensitive) запрещены среди активных и отключённых этапов
    assert (
        admin.post(
            "/api/reference-admin/customer_stage",
            json={"name": "нулевой СТАРТ", "probability": 15, "position": 1},
        ).status_code
        == 409
    )
    assert (
        admin.put(
            f"/api/reference-admin/customer_stage/{first_item['id']}/active", json={"is_active": False}
        ).status_code
        == 200
    )
    assert (
        admin.post(
            "/api/reference-admin/customer_stage",
            json={"name": "НУЛЕВОЙ старт", "probability": 15, "position": 1},
        ).status_code
        == 409
    )


def test_customer_stage_edit_does_not_recalculate_existing_projects(admin, db):
    stage = db.scalar(
        select(ReferenceValue).where(ReferenceValue.category == "customer_stage", ReferenceValue.code == "lead")
    )
    orig_prob = stage.probability
    created = admin.post("/api/projects", json=_payload(db, customer_stage_id=stage.id))
    assert created.status_code == 201, created.text
    project_id = created.json()["id"]
    assert created.json()["probability"] == orig_prob

    edited = admin.put(
        f"/api/reference-admin/customer_stage/{stage.id}",
        json={"name": "Инициация обновлена", "probability": 35},
    )
    assert edited.status_code == 200, edited.text
    assert edited.json()["name"] == "Инициация обновлена"
    assert edited.json()["probability"] == 35

    # Существующий проект сохраняет прежнюю вероятность, но видит актуальное имя этапа
    existing = admin.get(f"/api/projects/{project_id}").json()
    assert existing["probability"] == orig_prob
    assert existing["customer_stage"]["name"] == "Инициация обновлена"

    # Новый проект на этом этапе получает новую вероятность 35%
    created2 = admin.post("/api/projects", json=_payload(db, name="Второй проект", customer_stage_id=stage.id))
    assert created2.status_code == 201, created2.text
    assert created2.json()["probability"] == 35


def test_customer_stage_deactivate_reactivate_and_reorder(admin, db):
    stages = admin.get("/api/reference-admin/customer_stage").json()
    lead = stages[0]
    qual = stages[1]
    success = stages[-1]

    project = admin.post("/api/projects", json=_payload(db, customer_stage_id=lead["id"])).json()

    # Отключение этапа
    deact = admin.put(f"/api/reference-admin/customer_stage/{lead['id']}/active", json={"is_active": False})
    assert deact.status_code == 200, deact.text
    assert deact.json()["is_active"] is False

    # Отключённый этап пропадает из /api/refs, но остаётся у проекта и не даёт назначать себя заново
    refs_stages = [s["id"] for s in admin.get("/api/refs").json()["customer_stages"]]
    assert lead["id"] not in refs_stages
    assert (
        admin.post("/api/projects", json=_payload(db, name="Запрещённый", customer_stage_id=lead["id"])).status_code
        == 422
    )

    other_proj = admin.post("/api/projects", json=_payload(db, name="Другой", customer_stage_id=qual["id"])).json()
    assert (
        admin.put(
            f"/api/projects/{other_proj['id']}",
            json=_payload(db, name="Другой", customer_stage_id=lead["id"]),
        ).status_code
        == 422
    )
    # Сохранение проекта без смены отключённого этапа разрешено
    keep = admin.put(
        f"/api/projects/{project['id']}",
        json=_payload(db, customer_stage_id=lead["id"], description="Остаёмся на этапе"),
    )
    assert keep.status_code == 200, keep.text

    # Перемещение отключённого этапа разрешено, success остаётся последним
    moved = admin.put(
        f"/api/reference-admin/customer_stage/{lead['id']}/position",
        json={"position": 3, "expected_position": 1},
    )
    assert moved.status_code == 200, moved.text
    assert moved.json()["position"] == 3
    all_stages = admin.get("/api/reference-admin/customer_stage").json()
    assert [s["position"] for s in all_stages] == list(range(1, len(all_stages) + 1))
    assert all_stages[-1]["code"] == "success"

    # Устаревший expected_position возвращает 409 Conflict
    stale = admin.put(
        f"/api/reference-admin/customer_stage/{lead['id']}/position",
        json={"position": 2, "expected_position": 1},
    )
    assert stale.status_code == 409

    # Системный этап success нельзя переместить и нельзя поставить другой этап на его место
    assert (
        admin.put(
            f"/api/reference-admin/customer_stage/{success['id']}/position",
            json={"position": 1},
        ).status_code
        == 409
    )
    assert (
        admin.put(
            f"/api/reference-admin/customer_stage/{qual['id']}/position",
            json={"position": len(all_stages)},
        ).status_code
        == 422
    )

    # Повторное включение с одновременным изменением имени, вероятности и позиции
    react = admin.put(
        f"/api/reference-admin/customer_stage/{lead['id']}/active",
        json={"is_active": True, "name": "Возвращённый этап", "probability": 22, "position": 2},
    )
    assert react.status_code == 200, react.text
    body = react.json()
    assert (body["is_active"], body["name"], body["probability"], body["position"]) == (
        True,
        "Возвращённый этап",
        22,
        2,
    )
    assert lead["id"] in [s["id"] for s in admin.get("/api/refs").json()["customer_stages"]]

