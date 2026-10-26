import asyncio
from datetime import UTC, datetime, timedelta, timezone
from io import BytesIO
from types import SimpleNamespace

import pytest
from openpyxl import load_workbook
from sqlalchemy import select
from test_projects import _payload

from app.api.projects import export_projects
from app.models import Project, ReferenceValue, User


def _entry(refs, kind="cost", vat=True):
    value = {"kind": kind, "year": 2026, "month": 10, "amount": "123.456", "vat_included": vat,
             "status_id": refs["revenue_statuses" if kind == "revenue" else "cost_statuses"][0]["id"]}
    if kind == "cost":
        value.update(article_id=refs["cost_articles"][0]["id"], cost_type_id=refs["cost_types"][0]["id"])
    return value


@pytest.mark.parametrize("kind", ["revenue", "cost"])
@pytest.mark.parametrize("vat", [True, False])
def test_financial_kind_and_vat_roundtrip_preserves_input(as_user, db, kind, vat):
    refs = as_user.get("/api/refs").json()
    project = as_user.post("/api/projects", json=_payload(db)).json()
    response = as_user.put(f"/api/projects/{project['id']}/financial-entries", json=[_entry(refs, kind, vat)])
    assert response.status_code == 200
    reopened = as_user.get(f"/api/projects/{project['id']}").json()["financial_entries"]
    assert len(reopened) == 1
    assert reopened[0]["amount"] == "123.456"
    assert reopened[0]["vat_included"] is vat
    assert reopened[0]["kind"] == kind


@pytest.mark.parametrize("field", ["article_id", "cost_type_id", "status_id"])
@pytest.mark.parametrize("invalid", ["missing", "inactive", "wrong_category"])
def test_invalid_cost_reference_preserves_previous_rows(as_user, db, field, invalid):
    refs = as_user.get("/api/refs").json()
    project = as_user.post("/api/projects", json=_payload(db)).json()
    path = f"/api/projects/{project['id']}/financial-entries"
    valid = _entry(refs)
    before = as_user.put(path, json=[valid]).json()
    bad = dict(valid, amount="999.999")
    if invalid == "missing":
        bad[field] = -1
    elif invalid == "wrong_category":
        bad[field] = refs["payment_types"][0]["id"]
    else:
        reference = db.get(ReferenceValue, bad[field])
        reference.is_active = False
        db.flush()
    response = as_user.put(path, json=[bad])
    assert response.status_code == 422
    assert response.json()["detail"]["field"] == field
    assert as_user.get(f"/api/projects/{project['id']}").json()["financial_entries"] == before


@pytest.mark.parametrize("created_at", [
    datetime(2026, 10, 25, 12, 34, 56, tzinfo=timezone(timedelta(hours=3))),
    datetime(2026, 10, 25, 9, 34, 56, tzinfo=UTC),
    datetime(2026, 10, 25, 9, 34, 56),
])
def test_xlsx_serializes_timezone_and_keeps_text_literal(db, created_at):
    project = db.scalar(select(Project).limit(1))
    project.created_at = created_at
    project.name = '=HYPERLINK("https://example.invalid", "Текст")'
    # SQLite не сохраняет tzinfo; этот тест подаёт сериализатору реальный aware datetime из PostgreSQL.
    result = SimpleNamespace(unique=lambda: SimpleNamespace(all=lambda: [project]))
    response = export_projects(
        params=SimpleNamespace(query=lambda _: select(Project)),
        # Проект получает исходный aware datetime; подписи читаются из настоящей тестовой БД.
        db=SimpleNamespace(scalars=lambda _: result, execute=db.execute),
        user=db.scalar(select(User).where(User.email == "analyst@example.com")),
    )

    async def content():
        return b"".join([chunk async for chunk in response.body_iterator])

    workbook = load_workbook(BytesIO(asyncio.run(content())), read_only=True, data_only=False)
    sheet = workbook.active
    cells = list(sheet.iter_rows())
    assert cells[1][1].value == project.name
    assert cells[1][1].data_type == "s"
    assert cells[1][3].data_type == "s"
    assert cells[1][-1].value == "2026-10-25T09:34:56+00:00"
    workbook.close()
