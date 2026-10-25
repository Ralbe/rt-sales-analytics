from datetime import datetime

import pytest
from conftest import login
from sqlalchemy import select
from test_projects import _payload

from app.models import AuditLog, Project, ReferenceValue, User


def _create(client, db, **overrides):
    response = client.post("/api/projects", json=_payload(db, **overrides))
    assert response.status_code == 201, response.text
    return response.json()["id"]


def _history(client, project_id, **params):
    response = client.get(f"/api/projects/{project_id}/history", params=params)
    assert response.status_code == 200, response.text
    return response.json()


def _log(db, project_id, action="update", **payload):
    log = AuditLog(entity="project", entity_id=project_id, action=action, payload=payload)
    db.add(log)
    db.flush()
    return log


def _finance(db, kind="revenue", **overrides):
    data = {
        "kind": kind,
        "year": 2026,
        "month": 10,
        "amount": "123456789012.123",
        "vat_included": True,
        "status_id": db.scalar(select(ReferenceValue.id).where(ReferenceValue.category == f"{kind}_status")),
    }
    if kind == "cost":
        for field, category in (("article_id", "cost_article"), ("cost_type_id", "cost_type")):
            data[field] = db.scalar(select(ReferenceValue.id).where(ReferenceValue.category == category))
    return data | overrides


def test_history_requires_authentication(client, db):
    project_id = db.scalar(select(Project.id))
    assert client.get(f"/api/projects/{project_id}/history").status_code == 401


def test_history_hides_other_users_projects(as_user, db):
    me = db.scalar(select(User).where(User.email == "manager1@example.com"))
    project_id = db.scalar(select(Project.id).where(Project.manager_id != me.id))
    for hidden_id in (project_id, 9999999):
        response = as_user.get(f"/api/projects/{hidden_id}/history")
        assert response.status_code == 404
        assert response.json()["detail"] == "Проект не найден"


@pytest.mark.parametrize("email", ["analyst@example.com", "admin@example.com"])
def test_history_allows_analyst_and_admin(client, db, email):
    user = login(client, db, email)
    project_id = db.scalar(select(Project.id).where(Project.manager_id != user.id))
    assert _history(client, project_id)["items"] == []


def test_history_empty_state(as_user, db):
    me = db.scalar(select(User.id).where(User.email == "manager1@example.com"))
    project_id = db.scalar(select(Project.id).where(Project.manager_id == me))
    assert _history(as_user, project_id) == {"items": [], "limit": 10, "offset": 0, "has_more": False}


def test_history_order_limit_and_pagination(as_user, db):
    project_id = _create(as_user, db)
    db.scalar(select(AuditLog).where(AuditLog.entity_id == project_id)).created_at = datetime(2026, 10, 24, 12)
    logs = [_log(db, project_id, before={"name": "До"}, after={"name": f"После {i}"}) for i in range(105)]
    for log in logs:
        log.created_at = datetime(2026, 10, 25, 12)
    logs[0].created_at = datetime(2026, 10, 26, 12)
    unrelated = _log(db, project_id, after={"name": "Чужая сущность"})
    unrelated.entity = "dashboard"
    _log(db, project_id + 10000, after={"name": "Другой проект"})
    db.flush()
    ordered = [logs[0].id, *[log.id for log in reversed(logs[1:])]]
    page = _history(as_user, project_id)
    assert page["limit"] == 10 and page["has_more"] is True
    assert [row["id"] for row in page["items"]] == ordered[:10]
    assert page["items"][0]["created_at"].endswith("Z")
    maximum = _history(as_user, project_id, limit=100)
    assert len(maximum["items"]) == 100 and maximum["has_more"] is True
    second = _history(as_user, project_id, limit=100, offset=10)
    assert [row["id"] for row in second["items"][:95]] == ordered[10:]
    assert second["has_more"] is False
    assert _history(as_user, project_id, offset=1000)["items"] == []


@pytest.mark.parametrize("params", [{"limit": 0}, {"limit": 101}, {"limit": -1}, {"offset": -1}, {"limit": "нет"}])
def test_history_validates_limits(as_user, db, params):
    project_id = _create(as_user, db)
    assert as_user.get(f"/api/projects/{project_id}/history", params=params).status_code == 422


def test_create_history_has_readable_snapshot_and_safe_author(as_user, db):
    refs = as_user.get("/api/refs").json()
    payment = refs["payment_types"][0]
    project_id = _create(as_user, db, payment_type_id=payment["id"], amount="999999999999.99")
    item = _history(as_user, project_id)["items"][0]
    me = db.scalar(select(User).where(User.email == "manager1@example.com"))
    assert item["title"] == "Создание проекта"
    assert item["author_name"] == me.full_name
    changes = {row["field"]: row for row in item["changes"]}
    assert changes["payment_type_id"]["after"] == payment["name"]
    assert changes["amount"]["after"] == "999 999 999 999,99 ₽"
    assert changes["stage"]["after"] == "КП отправлено"
    assert changes["start_date"]["after"] == "01.10.2026"
    assert changes["manager_id"]["after"] == me.full_name
    assert all(row["before"] is None for row in changes.values())
    assert "email" not in str(item) and me.email not in str(item)
    assert "password" not in str(item) and "totp" not in str(item)


def test_project_updates_and_closing_are_audited_without_noops(as_user, db):
    project_id = _create(as_user, db)
    payload = _payload(db, description="Новое описание", stage="won")
    for _ in range(2):
        response = as_user.put(f"/api/projects/{project_id}", json=payload)
        assert response.status_code == 200, response.text
    items = _history(as_user, project_id)["items"]
    assert [item["action"] for item in items] == ["update", "create"]
    changes = {row["field"]: row for row in items[0]["changes"]}
    assert set(changes) == {"description", "stage", "closed_at"}
    assert changes["description"]["before"] == "Не задано"
    assert changes["description"]["after"] == "Новое описание"
    assert changes["closed_at"]["before"] == "Не задано"
    assert changes["closed_at"]["after"] != "Не задано"
    response = as_user.put(f"/api/projects/{project_id}", json=_payload(db))
    assert response.status_code == 200
    changes = {row["field"]: row for row in _history(as_user, project_id)["items"][0]["changes"]}
    assert changes["closed_at"]["after"] == "Не задано"


def test_financial_history_is_exact_readable_and_ignores_noops(as_user, db):
    project_id = _create(as_user, db)
    url = f"/api/projects/{project_id}/financial-entries"
    rows = [_finance(db), _finance(db, "cost", amount="0.001", vat_included=False)]
    first = as_user.put(url, json=rows)
    assert first.status_code == 200, first.text
    ids = [row["id"] for row in first.json()]
    second = as_user.put(url, json=list(reversed(rows)))
    assert second.status_code == 200, second.text
    assert [row["id"] for row in second.json()] == ids
    items = _history(as_user, project_id)["items"]
    assert [item["action"] for item in items] == ["replace_financial_entries", "create"]
    changes = items[0]["changes"]
    assert len(changes) == 2
    assert all(row["before"] == "Строка отсутствовала" for row in changes)
    assert "123 456 789 012,123 тыс. ₽" in changes[0]["after"]
    assert "10.2026" in changes[0]["after"] and "с НДС" in changes[0]["after"]
    assert "0,001 тыс. ₽" in changes[1]["after"] and "без НДС" in changes[1]["after"]
    for row in rows:
        for field in ("status_id", "article_id", "cost_type_id"):
            if field in row:
                assert db.get(ReferenceValue, row[field]).name in str(changes)
    updated = [rows[0] | {"amount": "2.345"}, rows[1]]
    assert as_user.put(url, json=updated).status_code == 200
    changes = _history(as_user, project_id)["items"][0]["changes"]
    assert len(changes) == 2
    assert changes[0]["label"] == "Финансовая строка удалена"
    assert "123 456 789 012,123" in changes[0]["before"]
    assert "2,345" in changes[1]["after"]
    assert as_user.put(url, json=[]).status_code == 200
    assert all(row["after"] == "Строка отсутствует" for row in _history(as_user, project_id)["items"][0]["changes"])


def test_snapshots_preserve_reference_and_author_names(as_user, db):
    payment = db.scalar(select(ReferenceValue).where(ReferenceValue.category == "payment_type"))
    original_name = payment.name
    project_id = _create(as_user, db, payment_type_id=payment.id)
    me = db.scalar(select(User).where(User.email == "manager1@example.com"))
    original_author = me.full_name
    payment.name = "Новое название справочника"
    me.full_name = "Новое имя автора"
    db.flush()
    item = _history(as_user, project_id)["items"][0]
    assert item["author_name"] == original_author
    assert next(row for row in item["changes"] if row["field"] == "payment_type_id")["after"] == original_name


def test_legacy_history_is_readable_without_invented_before_or_secret_fields(as_user, db):
    project_id = _create(as_user, db)
    _log(db, project_id, "create", name="Старое создание")
    payment = db.scalar(select(ReferenceValue).where(ReferenceValue.category == "payment_type"))
    _log(
        db,
        project_id,
        after={"payment_type_id": payment.id, "amount": "100.01", "password_hash": "СЕКРЕТ"},
        email="СКРЫТЫЙ EMAIL",
        totp_secret="СКРЫТЫЙ TOTP",
    )
    _log(db, project_id, "replace_financial_entries", after=[_finance(db, amount="0.001")])
    _log(db, project_id, "update")
    items = _history(as_user, project_id)["items"]
    assert items[0]["changes"] == [] and items[0]["note"]
    assert items[1]["changes"][0]["before"] is None
    assert "0,001 тыс. ₽" in items[1]["changes"][0]["after"]
    changes = {row["field"]: row for row in items[2]["changes"]}
    assert set(changes) == {"payment_type_id", "amount"}
    assert changes["payment_type_id"]["after"] == payment.name
    assert changes["amount"]["before"] is None
    assert "текущие значения" in items[2]["note"]
    assert items[3]["changes"] == [
        {"field": "name", "label": "Название проекта", "before": None, "after": "Старое создание"},
    ]
    assert items[3]["author_name"] == "Автор не указан"
    assert "СЕКРЕТ" not in str(items) and "СКРЫТЫЙ" not in str(items)


def test_legacy_financial_diff_keeps_duplicate_counts(as_user, db):
    project_id = _create(as_user, db)
    row = _finance(db, amount="1.23")
    _log(db, project_id, "replace_financial_entries", before=[row, row], after=[row | {"amount": "1.230"}])
    changes = _history(as_user, project_id)["items"][0]["changes"]
    assert len(changes) == 1
    assert changes[0]["label"] == "Финансовая строка удалена"
    assert "1,230 тыс. ₽" in changes[0]["before"]


def test_legacy_missing_references_and_incomplete_finances(as_user, db):
    project_id = _create(as_user, db)
    _log(db, project_id, before={"payment_type_id": 9999998}, after={"payment_type_id": 9999999})
    _log(db, project_id, "replace_financial_entries", after=[{"kind": "revenue", "amount": None}])
    items = _history(as_user, project_id)["items"]
    change = items[0]["changes"][0]
    assert change["before"] is None
    assert change["label"] == "Финансовая строка после сохранения"
    assert "Период не записан" in change["after"]
    assert "Признак НДС не записан" in change["after"]
    assert items[1]["changes"] == [
        {
            "field": "payment_type_id",
            "label": "Тип платежа",
            "before": "Значение справочника недоступно",
            "after": "Значение справочника недоступно",
        }
    ]


def test_legacy_empty_finances_preserve_the_known_side(as_user, db):
    project_id = _create(as_user, db)
    _log(db, project_id, "replace_financial_entries", after=[])
    change = _history(as_user, project_id)["items"][0]["changes"][0]
    assert change["before"] is None
    assert change["after"] == "Нет финансовых строк"
    _log(db, project_id, "replace_financial_entries", before=[], after=[])
    item = _history(as_user, project_id)["items"][0]
    assert item["changes"] == []
    assert item["note"] == "Изменения значений в этой записи не обнаружены."


def test_financial_snapshots_preserve_names_and_empty_save_is_noop(as_user, db):
    project_id = _create(as_user, db)
    url = f"/api/projects/{project_id}/financial-entries"
    assert as_user.put(url, json=[]).status_code == 200
    assert len(_history(as_user, project_id)["items"]) == 1
    row = _finance(db, amount="0.010")
    assert as_user.put(url, json=[row]).status_code == 200
    reference = db.get(ReferenceValue, row["status_id"])
    original_name = reference.name
    reference.name = "Переименованный статус"
    db.flush()
    item = _history(as_user, project_id)["items"][0]
    assert original_name in item["changes"][0]["after"]
    assert "Переименованный статус" not in item["changes"][0]["after"]
    assert item["note"] is None


def test_update_shows_reference_names_in_both_snapshots(as_user, db):
    references = db.scalars(select(ReferenceValue).where(ReferenceValue.category == "payment_type")).all()
    project_id = _create(as_user, db, payment_type_id=references[0].id)
    response = as_user.put(f"/api/projects/{project_id}", json=_payload(db, payment_type_id=references[1].id))
    assert response.status_code == 200, response.text
    item = _history(as_user, project_id)["items"][0]
    assert item["changes"] == [
        {
            "field": "payment_type_id",
            "label": "Тип платежа",
            "before": references[0].name,
            "after": references[1].name,
        }
    ]
