from conftest import login


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


def test_shared_dashboard_visible_but_readonly(client, db):
    login(client, db, "analyst@example.com")
    shared = client.post("/api/dashboards", json={"name": "Для всех", "widgets": [], "is_shared": True}).json()
    client.post("/api/auth/logout")

    login(client, db, "manager1@example.com")
    names = [d["name"] for d in client.get("/api/dashboards").json()]
    assert "Для всех" in names
    r = client.put(f"/api/dashboards/{shared['id']}", json={"name": "x", "widgets": []})
    assert r.status_code == 403
    assert client.post(f"/api/dashboards/{shared['id']}/copy").status_code == 201
    # Менеджер не может публиковать
    assert client.post("/api/dashboards", json={"name": "Моё", "is_shared": True}).status_code == 403
