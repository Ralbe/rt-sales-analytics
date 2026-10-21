#!/bin/sh
set -e

# Миграции и демо-данные применяет только API-контейнер (RUN_MIGRATIONS=1)
if [ "$RUN_MIGRATIONS" = "1" ]; then
  alembic upgrade head
  if [ "$SEED_DEMO_DATA" = "1" ]; then
    python -m app.seed
  fi
fi

exec "$@"
