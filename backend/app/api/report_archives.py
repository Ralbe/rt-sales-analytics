from io import BytesIO
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from openpyxl import Workbook
from openpyxl.cell import WriteOnlyCell
from pydantic import UUID4, BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.reports import actor, editor, snapshot
from app.db import get_db
from app.deps import get_current_user
from app.models import Project, ReportArchive, Role, User
from app.services import audit, report_builder

router = APIRouter(prefix="/report-archives", tags=["reports"])


class ArchiveInput(BaseModel):
    snapshot_id: UUID4


def authorized(db: Session, user: User, archive_id: str) -> ReportArchive:
    user = actor(db, user)
    editor(user)
    item = db.get(ReportArchive, archive_id)
    if item is None or item.owner_id != user.id or item.owner_role != user.role.value:
        raise HTTPException(404, "Версия отчёта недоступна")
    # Администратор может поднимать историю после архивирования или удаления проекта.
    if user.role != Role.admin:
        rows = db.execute(select(Project.id, Project.archived_at).where(
            Project.id.in_(item.project_ids),
        ).with_for_update(read=True)).all()
        if len(rows) != len(item.project_ids) or any(archived is not None for _, archived in rows):
            raise HTTPException(404, "Версия отчёта содержит недоступные проекты")
    return item


@router.post("", status_code=201)
def save(data: ArchiveInput, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    user = actor(db, user)
    editor(user)
    report_builder.lock_quota(db)
    source = snapshot(db, user, str(data.snapshot_id))
    existing = db.scalar(select(ReportArchive).where(ReportArchive.source_snapshot_id == source.id))
    if existing:
        return {"id": existing.id}
    own = db.scalar(select(func.count()).select_from(ReportArchive).where(ReportArchive.owner_id == user.id))
    total = db.scalar(select(func.count()).select_from(ReportArchive))
    if own >= 100 or total >= 1000:
        raise HTTPException(429, "Достигнут лимит сохранённых версий отчётов")
    item = ReportArchive(
        id=str(uuid4()), source_snapshot_id=source.id, owner_id=user.id, owner_role=user.role.value,
        title=source.title, report_version=source.report_version, columns=source.columns, rows=source.rows,
        project_ids=source.project_ids, print_metadata=source.print_metadata,
    )
    db.add(item)
    audit.record(db, user.id, "save_version", "report_archive", None, archive_id=item.id, title=item.title)
    db.commit()
    return {"id": item.id}


@router.get("")
def list_versions(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    user = actor(db, user)
    editor(user)
    items = db.scalars(select(ReportArchive).where(
        ReportArchive.owner_id == user.id, ReportArchive.owner_role == user.role.value,
    ).order_by(ReportArchive.created_at.desc(), ReportArchive.id).limit(100)).all()
    return {"items": [{"id": i.id, "title": i.title, "created_at": i.created_at,
                       "report_version": i.report_version, "total": len(i.rows)} for i in items]}


@router.get("/{archive_id}")
def page(archive_id: str, offset: int = Query(0, ge=0, le=10000), limit: int = Query(100, ge=1, le=200),
         db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    item = authorized(db, user, archive_id)
    return {"snapshot_id": item.id, "title": item.title, "columns": item.columns,
            "rows": item.rows[offset:offset + limit], "total": len(item.rows), "offset": offset, "limit": limit,
            "expires_at": None, "report_version": item.report_version, "metadata": item.print_metadata,
            "saved_at": item.created_at}


@router.get("/{archive_id}/export")
def export(archive_id: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    item = authorized(db, user, archive_id)
    book = Workbook(write_only=True)
    sheet = book.create_sheet("Отчёт")

    def cells(values):
        for value in values:
            cell = WriteOnlyCell(sheet, value=value)
            if isinstance(value, str):
                cell.data_type = "s"
            yield cell

    sheet.append(list(cells(c["label"] for c in item.columns)))
    for row in item.rows:
        sheet.append(list(cells(row[c["id"]] for c in item.columns)))
    buffer = BytesIO()
    book.save(buffer)
    return Response(buffer.getvalue(), media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    headers={"Content-Disposition": 'attachment; filename="report-version.xlsx"'})
