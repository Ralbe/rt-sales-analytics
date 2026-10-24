"""align user roles with the client specification

Revision ID: 0002
Revises: 0001
"""

from alembic import op
import sqlalchemy as sa


revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    connection = op.get_bind()
    connection.execute(sa.text("UPDATE users SET role = 'user' WHERE role = 'manager'"))
    connection.execute(sa.text("UPDATE users SET role = 'admin' WHERE role = 'head'"))


def downgrade() -> None:
    connection = op.get_bind()
    connection.execute(sa.text("UPDATE users SET role = 'manager' WHERE role = 'user'"))
