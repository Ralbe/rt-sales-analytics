from conftest import login
from sqlalchemy import select

from app.models import AuditLog


def test_default_dashboard_created(as_analyst):
    items = as_analyst.get("/api/dashboards").json()
    assert len(items) == 1
    assert items[0]["name"] == "Дашборд 1"
    assert items[0]["editable"] is True
    assert {w["type"] for w in items[0]["widgets"]} >= {"kpi", "trend", "breakdown"}


def test_swap_chart_type_and_save(as_analyst):
    d = as_analyst.get("/api/dashboards").json()[0]
    widgets = d["widgets"]
    seg = next(w for w in widgets if w["id"] == "by-segment")
    seg["config"]["chart"] = "donut"
    r = as_analyst.put(f"/api/dashboards/{d['id']}", json={"name": d["name"], "widgets": widgets, "filters": {}})
    assert r.status_code == 200
    saved = next(w for w in r.json()["widgets"] if w["id"] == "by-segment")
    assert saved["config"]["chart"] == "donut"


def test_shared_dashboard_visible_but_readonly_for_user(client, db):
    login(client, db, "analyst@example.com")
    shared = client.post("/api/dashboards", json={"name": "Для всех", "widgets": [], "is_shared": True}).json()
    client.post("/api/auth/logout")

    login(client, db, "manager1@example.com")
    dashboards = client.get("/api/dashboards").json()
    names = [d["name"] for d in dashboards]
    assert "Для всех" in names
    assert all(d["editable"] is False for d in dashboards)
    r = client.put(f"/api/dashboards/{shared['id']}", json={"name": "x", "widgets": []})
    assert r.status_code == 403
    assert client.post(f"/api/dashboards/{shared['id']}/copy").status_code == 403
    assert client.post("/api/dashboards", json={"name": "Моё", "is_shared": True}).status_code == 403
    assert client.post("/api/dashboards", json={"name": "Мой", "widgets": []}).status_code == 403


def test_admin_can_manage_other_users_dashboards_and_actions_are_audited(client, db):
    owner = login(client, db, "analyst@example.com")
    private = client.post("/api/dashboards", json={"name": "Личный", "widgets": []}).json()
    shared = client.post("/api/dashboards", json={"name": "Общий", "widgets": [], "is_shared": True}).json()
    client.post("/api/auth/logout")
    admin = login(client, db, "admin@example.com")

    items = {item["id"]: item for item in client.get("/api/dashboards").json()}
    for item in (private, shared):
        assert item["id"] in items
        assert items[item["id"]]["editable"] is True
        assert items[item["id"]]["owner"]["id"] == owner.id
        assert client.get(f"/api/dashboards/{item['id']}").status_code == 200

    response = client.put(f"/api/dashboards/{private['id']}", json={
        "name": "Исправлено", "widgets": [], "is_shared": True,
    })
    assert response.status_code == 200
    assert response.json()["owner"]["id"] == owner.id
    update = db.scalar(select(AuditLog).where(
        AuditLog.entity == "dashboard", AuditLog.entity_id == private["id"], AuditLog.action == "update",
    ))
    assert update.user_id == admin.id
    assert update.payload["owner_id"] == owner.id
    assert update.payload["before"]["name"] == "Личный"
    assert update.payload["after"]["name"] == "Исправлено"
    assert client.delete(f"/api/dashboards/{shared['id']}").status_code == 204
    deleted = db.scalar(select(AuditLog).where(
        AuditLog.entity == "dashboard", AuditLog.entity_id == shared["id"], AuditLog.action == "delete",
    ))
    assert deleted.user_id == admin.id


def test_other_analyst_and_user_cannot_manage_or_see_private_dashboards(client, db):
    login(client, db, "admin@example.com")
    private = client.post("/api/dashboards", json={"name": "Личный", "widgets": []}).json()
    shared = client.post("/api/dashboards", json={"name": "Общий", "widgets": [], "is_shared": True}).json()
    client.post("/api/auth/logout")
    for email in ("analyst@example.com", "manager1@example.com"):
        login(client, db, email)
        items = {item["id"]: item for item in client.get("/api/dashboards").json()}
        assert private["id"] not in items
        assert items[shared["id"]]["editable"] is False
        assert client.get(f"/api/dashboards/{private['id']}").status_code == 404
        assert client.put(f"/api/dashboards/{shared['id']}", json={"name": "x", "widgets": []}).status_code == 403
        assert client.delete(f"/api/dashboards/{shared['id']}").status_code == 403
        client.post("/api/auth/logout")


def test_revoked_admin_session_cannot_access_dashboard(client, db):
    admin = login(client, db, "admin@example.com")
    dashboard = client.post("/api/dashboards", json={"name": "Личный", "widgets": []}).json()
    admin.auth_version += 1
    db.flush()
    assert client.get(f"/api/dashboards/{dashboard['id']}").status_code == 401
    assert client.delete(f"/api/dashboards/{dashboard['id']}").status_code == 401
