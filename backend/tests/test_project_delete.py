from conftest import login
from project_factories import customer_payload
from sqlalchemy import select

from app.models import AuditLog, Project, ProjectFinancialEntry


def test_admin_deletes_only_archived_project(client, db):
    login(client, db, "admin@example.com")
    project = client.post("/api/projects", json=customer_payload(db, name="Удаляемый проект")).json()
    assert client.delete(f"/api/projects/{project['id']}").status_code == 409
    assert client.post(f"/api/projects/{project['id']}/archive").status_code == 200
    assert client.delete(f"/api/projects/{project['id']}").status_code == 204
    assert db.get(Project, project["id"]) is None
    entries = select(ProjectFinancialEntry).where(ProjectFinancialEntry.project_id == project["id"])
    assert db.scalars(entries).all() == []
    event = db.scalar(select(AuditLog).where(
        AuditLog.entity == "project", AuditLog.entity_id == project["id"], AuditLog.action == "delete",
    ))
    assert event.payload["before"]["name"] == "Удаляемый проект"


def test_non_admin_cannot_delete_project(as_analyst, db):
    project = as_analyst.post("/api/projects", json=customer_payload(db, name="Чужой")).json()
    assert as_analyst.delete(f"/api/projects/{project['id']}").status_code == 403
