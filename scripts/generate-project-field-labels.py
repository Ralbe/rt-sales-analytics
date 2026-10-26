"""Обновляет frontend fallback из backend-каталога без сетевых запросов."""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app.project_field_label_catalog import FIELD_LABELS  # noqa: E402

destination = ROOT / "frontend/src/lib/project-field-label-defaults.json"
destination.write_text(
    json.dumps(
        {key: {"label": spec.default_label, "suffix": spec.suffix} for key, spec in FIELD_LABELS.items()},
        ensure_ascii=False, indent=2,
    ) + "\n",
    encoding="utf-8",
)
