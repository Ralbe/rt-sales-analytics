from datetime import datetime
from decimal import Decimal
from unittest.mock import Mock

import pytest
from conftest import login
from project_factories import create_legacy_project, legacy_payload
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from test_project_history import _finance
from test_projects import _payload

from app.api import projects
from app.models import AuditLog, Project, ProjectFinancialEntry, ReferenceValue, User


def _counts(db):
    models = (Project, ProjectFinancialEntry, AuditLog)
    return tuple(db.scalar(select(func.count()).select_from(model)) for model in models)


def _logs(db, project_id):
    return db.scalars(
        select(AuditLog)
        .where(AuditLog.entity == "project", AuditLog.entity_id == project_id)
        .order_by(AuditLog.id)
    ).all()


def _create(client, db, **overrides):
    response = client.post("/api/projects", json=_payload(db, **overrides))
    assert response.status_code == 201, response.text
    return response.json()


def test_atomic_create_preserves_decimals_vat_and_audits_both(as_user, db, monkeypatch):
    rows = [
        _finance(db, amount="123456789.123"),
        _finance(db, "cost", amount="0.001", vat_included=False),
        _finance(db, amount="0.010", vat_included=False, month=11),
        _finance(db, "cost", amount="42.987", month=12),
    ]
    events = []
    commit = db.commit

    def commit_once():
        commit()
        events.append("commit")

    def invalidate(namespace):
        assert namespace == "analytics"
        assert events == ["commit"]
        events.append("cache")

    monkeypatch.setattr(db, "commit", commit_once)
    monkeypatch.setattr(projects.cache, "bump", invalidate)
    saved = _create(as_user, db, financial_entries=rows)
    assert events == ["commit", "cache"]
    assert saved["amount"] == "1500000.00" and saved["cost"] == "900000.00"
    reopened = as_user.get(f"/api/projects/{saved['id']}").json()
    assert reopened == saved
    for expected, actual in zip(rows, saved["financial_entries"], strict=True):
        assert actual["kind"] == expected["kind"]
        assert actual["amount"] == expected["amount"]
        assert actual["vat_included"] is expected["vat_included"]
        assert actual["status"]["id"] == expected["status_id"]
        assert actual["created_at"] and actual["updated_at"]
        assert actual["article"] == (
            {"id": expected["article_id"], "name": db.get(ReferenceValue, expected["article_id"]).name}
            if expected.get("article_id") else None
        )
        assert (actual["cost_type"]["id"] if actual["cost_type"] else None) == expected.get("cost_type_id")
        assert db.get(ProjectFinancialEntry, actual["id"]).amount == Decimal(expected["amount"])
    logs = _logs(db, saved["id"])
    assert [log.action for log in logs] == ["create", "replace_financial_entries"]
    assert logs[0].payload["after"]["amount"] == "1500000.00"
    assert logs[1].payload["before"] == []
    assert [row["amount"] for row in logs[1].payload["after"]] == [row["amount"] for row in rows]
    assert [row["vat_included"] for row in logs[1].payload["after"]] == [row["vat_included"] for row in rows]
    me = db.scalar(select(User).where(User.email == "manager1@example.com"))
    assert all(log.user_id == me.id and log.payload["author_name"] == me.full_name for log in logs)
    history = as_user.get(f"/api/projects/{saved['id']}/history").json()["items"]
    assert [item["action"] for item in history] == ["replace_financial_entries", "create"]


INVALID_REFERENCES = [
    (kind, field, invalid)
    for kind, fields in (("revenue", ("status_id",)), ("cost", ("status_id", "article_id", "cost_type_id")))
    for field in fields
    for invalid in ("missing", "inactive", "wrong_category", "null")
] + [("revenue", field, "forbidden") for field in ("article_id", "cost_type_id")]


@pytest.mark.parametrize("operation", ["create", "update"])
@pytest.mark.parametrize(("kind", "field", "invalid"), INVALID_REFERENCES)
def test_invalid_finances_do_not_mutate_card_rows_or_audit(as_user, db, monkeypatch, operation, kind, field, invalid):
    saved = _create(as_user, db, financial_entries=[_finance(db, amount="1.234")]) if operation == "update" else None
    good = _finance(db, amount="2.345")
    bad = _finance(db, kind, amount="9.876")
    if invalid == "missing":
        bad[field] = -1
    elif invalid == "null":
        bad[field] = None
    elif invalid == "inactive":
        db.get(ReferenceValue, bad[field]).is_active = False
        db.commit()
    else:
        category = "cost_article" if invalid == "forbidden" else "payment_type"
        bad[field] = db.scalar(select(ReferenceValue.id).where(ReferenceValue.category == category))
    before = _counts(db)
    bump = Mock()
    monkeypatch.setattr(projects.cache, "bump", bump)
    payload = _payload(
        db, name="Не должно сохраниться", description="Не должно измениться", financial_entries=[good, bad],
    )
    response = (
        as_user.post("/api/projects", json=payload)
        if saved is None else as_user.put(f"/api/projects/{saved['id']}", json=payload)
    )
    assert response.status_code == 422, response.text
    # Запрос и повторное чтение выявляют даже незакоммиченные частичные мутации сессии.
    assert _counts(db) == before
    db.expire_all()
    if saved is not None:
        assert as_user.get(f"/api/projects/{saved['id']}").json() == saved
    else:
        assert db.scalar(select(Project.id).where(Project.name == payload["name"])) is None
    bump.assert_not_called()


@pytest.mark.parametrize(
    ("operation", "scheme"), [("create", "customer"), ("update", "customer"), ("update", "legacy")],
)
@pytest.mark.parametrize("failure", ["audit", "commit", "database"])
def test_failure_after_flush_rolls_back_everything(as_user, db, monkeypatch, operation, scheme, failure):
    if scheme == "legacy":
        legacy = create_legacy_project(db)
        response = as_user.put(f"/api/projects/{legacy.id}/financial-entries", json=[_finance(db, amount="1.234")])
        assert response.status_code == 200
        saved = as_user.get(f"/api/projects/{legacy.id}").json()
    else:
        saved = (
            _create(as_user, db, financial_entries=[_finance(db, amount="1.234")]) if operation == "update" else None
        )
    before = _counts(db)
    rows = [_finance(db, "cost", amount="5.678")]
    if saved is not None:
        rows[0]["id"] = saved["financial_entries"][0]["id"]
    payload = (
        legacy_payload(db, name="Откат атомарного сохранения", stage="won", financial_entries=rows)
        if scheme == "legacy" else _payload(db, name="Откат атомарного сохранения", financial_entries=rows)
    )
    bump = Mock()
    monkeypatch.setattr(projects.cache, "bump", bump)
    record = projects.audit.record

    def fail_commit():
        db.flush()
        assert _counts(db)[2] == before[2] + 2
        raise RuntimeError("Сбой фиксации")

    def fail_audit(*args, **kwargs):
        record(*args, **kwargs)
        if args[2] == "replace_financial_entries":
            if failure == "database":
                # Настоящая ошибка ограничения БД переводит сессию в состояние pending rollback.
                db.get(ProjectFinancialEntry, kwargs["after"][0]["_row_id"]).amount = Decimal("-0.001")
                return
            db.flush()
            assert _counts(db)[2] == before[2] + 2
            raise RuntimeError("Сбой аудита")

    with monkeypatch.context() as patch:
        if failure == "commit":
            patch.setattr(db, "commit", fail_commit)
        else:
            patch.setattr(projects.audit, "record", fail_audit)
        error, message = (
            (IntegrityError, "ck_project_financial_amount") if failure == "database" else (RuntimeError, "Сбой")
        )
        with pytest.raises(error, match=message):
            if saved is None:
                as_user.post("/api/projects", json=payload)
            else:
                as_user.put(f"/api/projects/{saved['id']}", json=payload)
    assert _counts(db) == before
    db.expire_all()
    if saved is not None:
        assert as_user.get(f"/api/projects/{saved['id']}").json() == saved
    else:
        assert db.scalar(select(Project.id).where(Project.name == payload["name"])) is None
    bump.assert_not_called()
    # После отката запрос можно безопасно повторить.
    response = (
        as_user.post("/api/projects", json=payload)
        if saved is None else as_user.put(f"/api/projects/{saved['id']}", json=payload)
    )
    assert response.status_code == (201 if saved is None else 200), response.text
    assert len(response.json()["financial_entries"]) == 1


@pytest.mark.parametrize("financial_fields", [{}, {"financial_entries": None}, {"financial_entries": []}])
def test_old_create_clients_and_optional_finances(as_user, db, financial_fields):
    saved = _create(as_user, db, **financial_fields)
    assert saved["financial_entries"] == []
    assert [log.action for log in _logs(db, saved["id"])] == ["create"]


@pytest.mark.parametrize("financial_fields", [{}, {"financial_entries": None}])
def test_omitted_or_null_finances_preserve_existing_rows(as_user, db, financial_fields):
    saved = _create(as_user, db)
    response = as_user.put(
        f"/api/projects/{saved['id']}/financial-entries", json=[_finance(db, "cost", amount="1.234")],
    )
    assert response.status_code == 200, response.text
    rows = response.json()
    response = as_user.put(
        f"/api/projects/{saved['id']}", json=_payload(db, description="Старый клиент", **financial_fields),
    )
    assert response.status_code == 200, response.text
    assert response.json()["financial_entries"] == rows
    assert response.json()["created_at"] == saved["created_at"]
    assert [log.action for log in _logs(db, saved["id"])] == ["create", "replace_financial_entries", "update"]


def test_update_replaces_all_rows_and_audits_card_and_finances(as_user, db, monkeypatch):
    saved = _create(as_user, db, financial_entries=[_finance(db, amount="1.234"), _finance(db, amount="2.345")])
    replacement = _finance(db, "cost", amount="0.001", vat_included=False, year=2027, month=1)
    replacement["id"] = saved["financial_entries"][0]["id"]
    events = []
    commit = db.commit

    def commit_once():
        commit()
        events.append("commit")

    monkeypatch.setattr(db, "commit", commit_once)
    monkeypatch.setattr(projects.cache, "bump", lambda namespace: events.append(namespace))
    response = as_user.put(
        f"/api/projects/{saved['id']}",
        json=_payload(db, description="Карточка и финансы", financial_entries=[replacement]),
    )
    assert response.status_code == 200, response.text
    updated = response.json()
    assert events == ["commit", "analytics"]
    assert updated["created_at"] == saved["created_at"]
    assert updated["description"] == "Карточка и финансы"
    assert len(updated["financial_entries"]) == 1
    assert updated["financial_entries"][0]["amount"] == "0.001"
    assert updated["financial_entries"][0]["year"] == 2027
    logs = _logs(db, saved["id"])
    assert [log.action for log in logs] == [
        "create", "replace_financial_entries", "update", "replace_financial_entries",
    ]
    assert logs[-2].payload["before"]["description"] == ""
    assert logs[-2].payload["after"]["description"] == "Карточка и финансы"
    assert [row["amount"] for row in logs[-1].payload["before"]] == ["1.234", "2.345"]
    assert logs[-1].payload["after"][0]["amount"] == "0.001"


@pytest.mark.parametrize("replacement", [[], "changed"])
def test_financial_only_change_updates_timestamp_and_preserves_creation(as_user, db, replacement):
    saved = _create(as_user, db, financial_entries=[_finance(db, amount="1.234")])
    project = db.get(Project, saved["id"])
    project.updated_at = datetime(2020, 1, 1)
    db.commit()
    rows = (
        [_finance(db, amount="2.345") | {"id": saved["financial_entries"][0]["id"]}]
        if replacement == "changed" else []
    )
    response = as_user.put(f"/api/projects/{saved['id']}", json=_payload(db, financial_entries=rows))
    assert response.status_code == 200, response.text
    updated = response.json()
    assert updated["created_at"] == saved["created_at"]
    assert datetime.fromisoformat(updated["updated_at"]) > datetime(2020, 1, 1)
    assert len(updated["financial_entries"]) == len(rows)
    assert [log.action for log in _logs(db, saved["id"])] == [
        "create", "replace_financial_entries", "replace_financial_entries",
    ]


@pytest.mark.parametrize("financial_fields", ["reordered", "empty", "omitted", "null"])
def test_noop_keeps_history_row_ids_and_timestamps(as_user, db, monkeypatch, financial_fields):
    rows = [] if financial_fields == "empty" else [_finance(db, amount="1.230"), _finance(db, "cost"), _finance(db)]
    saved = _create(as_user, db, financial_entries=rows)
    project = db.get(Project, saved["id"])
    project.updated_at = datetime(2020, 1, 1)
    for row in project.financial_entries:
        row.created_at = row.updated_at = datetime(2020, 1, 1)
    db.commit()
    saved = as_user.get(f"/api/projects/{saved['id']}").json()
    fields = {} if financial_fields == "omitted" else {
        "financial_entries": None if financial_fields == "null" else list(reversed(rows)),
    }
    before = _counts(db)
    bump = Mock()
    monkeypatch.setattr(projects.cache, "bump", bump)
    for _ in range(2):
        response = as_user.put(f"/api/projects/{saved['id']}", json=_payload(db, **fields))
        assert response.status_code == 200, response.text
        assert response.json() == saved
    assert _counts(db) == before
    bump.assert_not_called()


def test_duplicate_financial_rows_are_counted_in_noop_comparison(as_user, db):
    row = _finance(db, amount="1.230")
    saved = _create(as_user, db, financial_entries=[row, row])
    response = as_user.put(
        f"/api/projects/{saved['id']}",
        json=_payload(db, financial_entries=[row | {"id": saved["financial_entries"][0]["id"]}]),
    )
    assert response.status_code == 200, response.text
    assert len(response.json()["financial_entries"]) == 1
    assert len(_logs(db, saved["id"])) == 3


@pytest.mark.parametrize("operation", ["create", "update", "legacy"])
def test_financial_limit_is_checked_before_mutations(as_user, db, operation):
    saved = _create(as_user, db, financial_entries=[_finance(db, amount="1.234")]) if operation != "create" else None
    before = _counts(db)
    rows = [_finance(db)] * 501
    payload = _payload(db, name="Лимит финансовых строк", financial_entries=rows)
    if operation == "create":
        response = as_user.post("/api/projects", json=payload)
    elif operation == "legacy":
        response = as_user.put(f"/api/projects/{saved['id']}/financial-entries", json=rows)
    else:
        response = as_user.put(f"/api/projects/{saved['id']}", json=payload)
    assert response.status_code == 422
    assert _counts(db) == before
    if saved is not None:
        assert as_user.get(f"/api/projects/{saved['id']}").json() == saved


def test_financial_limit_accepts_500_rows(as_user, db):
    saved = _create(as_user, db, financial_entries=[_finance(db, amount="0.001")] * 500)
    assert len(saved["financial_entries"]) == 500
    assert all(row["amount"] == "0.001" for row in saved["financial_entries"])


@pytest.mark.parametrize("operation", ["create", "update"])
@pytest.mark.parametrize("invalid", [{"amount": "0.0001"}, {"amount": "NaN"}, {"month": 13}, {"kind": "other"}])
def test_financial_schema_errors_leave_no_partial_save(as_user, db, operation, invalid):
    saved = _create(as_user, db, financial_entries=[_finance(db, amount="1.234")]) if operation == "update" else None
    before = _counts(db)
    payload = _payload(db, description="Не сохранять", financial_entries=[_finance(db, **invalid)])
    response = (
        as_user.post("/api/projects", json=payload)
        if saved is None else as_user.put(f"/api/projects/{saved['id']}", json=payload)
    )
    assert response.status_code == 422
    assert _counts(db) == before
    if saved is not None:
        assert as_user.get(f"/api/projects/{saved['id']}").json() == saved


def test_card_validation_does_not_replace_valid_finances(as_user, db):
    saved = _create(as_user, db, financial_entries=[_finance(db, amount="1.234")])
    stage = db.scalar(select(ReferenceValue).where(
        ReferenceValue.category == "customer_stage", ReferenceValue.id != saved["customer_stage"]["id"],
    ))
    stage.probability = None
    db.commit()
    before = _counts(db)
    response = as_user.put(
        f"/api/projects/{saved['id']}",
        json=_payload(db, name="Не сохранять", customer_stage_id=stage.id, financial_entries=[]),
    )
    assert response.status_code == 422
    assert _counts(db) == before
    assert as_user.get(f"/api/projects/{saved['id']}").json() == saved


def test_legacy_financial_endpoint_invalidates_only_after_commit(as_user, db, monkeypatch):
    saved = _create(as_user, db)
    events = []
    commit = db.commit

    def commit_once():
        commit()
        events.append("commit")

    monkeypatch.setattr(db, "commit", commit_once)
    monkeypatch.setattr(projects.cache, "bump", lambda namespace: events.append(namespace))
    url = f"/api/projects/{saved['id']}/financial-entries"
    response = as_user.put(url, json=[_finance(db, amount="1.234")])
    assert response.status_code == 200
    assert events == ["commit", "analytics"]
    events.clear()
    assert as_user.put(url, json=[_finance(db, amount="1.234")]).json() == response.json()
    assert events == []


def test_user_cannot_change_other_users_project_or_finances(as_user, db, monkeypatch):
    me = db.scalar(select(User).where(User.email == "manager1@example.com"))
    other = db.scalar(select(Project).where(Project.manager_id != me.id))
    before = projects.project_snapshot(db, other)
    counts = _counts(db)
    bump = Mock()
    monkeypatch.setattr(projects.cache, "bump", bump)
    for project_id in (other.id, 9999999):
        response = as_user.put(
            f"/api/projects/{project_id}", json=_payload(db, manager_id=me.id, financial_entries=[_finance(db)]),
        )
        assert response.status_code == 404
        response = as_user.put(f"/api/projects/{project_id}/financial-entries", json=[_finance(db)])
        assert response.status_code == 404
    assert projects.project_snapshot(db, other) == before
    assert _counts(db) == counts
    bump.assert_not_called()


def test_user_saves_only_as_self_even_with_another_manager_id(as_user, db):
    me = db.scalar(select(User).where(User.email == "manager1@example.com"))
    other_id = db.scalar(select(User.id).where(User.id != me.id))
    saved = _create(as_user, db, manager_id=other_id, financial_entries=[_finance(db)])
    assert saved["manager"]["id"] == me.id
    response = as_user.put(
        f"/api/projects/{saved['id']}", json=_payload(db, manager_id=other_id, financial_entries=[]),
    )
    assert response.status_code == 200
    assert response.json()["manager"]["id"] == me.id
    assert response.json()["financial_entries"] == []


@pytest.mark.parametrize("email", ["analyst@example.com", "admin@example.com"])
def test_privileged_roles_can_save_card_and_finances_for_another_manager(client, db, email):
    user = login(client, db, email)
    manager_id = db.scalar(select(User.id).where(User.id != user.id))
    saved = _create(client, db, manager_id=manager_id, financial_entries=[_finance(db)])
    assert saved["manager"]["id"] == manager_id
    response = client.put(
        f"/api/projects/{saved['id']}", json=_payload(db, manager_id=manager_id, financial_entries=[]),
    )
    assert response.status_code == 200
    assert response.json()["financial_entries"] == []


def test_atomic_save_requires_authentication(client, db):
    project_id = db.scalar(select(Project.id))
    before = _counts(db)
    payload = _payload(db, financial_entries=[_finance(db)])
    assert client.post("/api/projects", json=payload).status_code == 401
    assert client.put(f"/api/projects/{project_id}", json=payload).status_code == 401
    assert _counts(db) == before
