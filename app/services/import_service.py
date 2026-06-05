"""Excel import service — preview + confirm workflow for attendee import.

Uses tools/excel_io.py for parsing (pure function),
then AttendeeRepository for persistence.
"""

from __future__ import annotations

import logging
import uuid
from io import BytesIO

from app.repositories.attendee_repo import AttendeeRepository
from tools.excel_io import import_attendees_from_excel

logger = logging.getLogger(__name__)

# Smart field mapping: common header variants → attendee field
_FIELD_ALIASES: dict[str, list[str]] = {
    "name": ["姓名", "名字", "name", "full name", "fullname", "参会人"],
    "title": ["职位", "职务", "头衔", "title", "job title", "position"],
    "organization": ["公司", "组织", "单位", "机构", "organization", "company", "org"],
    "department": ["部门", "department", "dept"],
    "role": ["角色", "身份", "role", "type"],
    "phone": ["电话", "手机", "联系方式", "phone", "mobile", "tel"],
    "email": ["邮箱", "email", "e-mail", "邮件"],
}


def _auto_map_columns(headers: list[str]) -> list[dict]:
    """Auto-map Excel headers to attendee fields with confidence scores."""
    mappings = []
    for header in headers:
        lower = header.strip().lower()
        best_field = None
        best_confidence = 0.0

        for field, aliases in _FIELD_ALIASES.items():
            for alias in aliases:
                if lower == alias.lower():
                    best_field = field
                    best_confidence = 1.0
                    break
                if alias.lower() in lower or lower in alias.lower():
                    if best_confidence < 0.7:
                        best_field = field
                        best_confidence = 0.7
            if best_confidence == 1.0:
                break

        mappings.append({
            "excel_header": header,
            "mapped_to": best_field,
            "confidence": best_confidence,
        })
    return mappings


def _detect_duplicates(
    rows: list[dict], existing_names: set[str]
) -> list[str]:
    """Detect potential duplicate entries."""
    warnings = []
    seen: dict[str, int] = {}

    for i, row in enumerate(rows):
        # `.get(k, "")` doesn't substitute "" when the key exists with a
        # None value (which is exactly what excel_io writes when a cell
        # is blank). Use `or ""` so None | "" both produce "".
        name = (row.get("name") or "").strip()
        org = (row.get("organization") or "").strip()
        key = f"{name}|{org}" if org else name

        if key in seen:
            warnings.append(
                f"Row {i + 1}: possible duplicate of row {seen[key] + 1} ({name})"
            )
        else:
            seen[key] = i

        if name in existing_names:
            warnings.append(f"Row {i + 1}: '{name}' already exists in attendee list")

    return warnings


class ImportService:
    """Preview and confirm Excel attendee imports."""

    def __init__(self, attendee_repo: AttendeeRepository):
        self._attendee_repo = attendee_repo

    async def preview(
        self, event_id: uuid.UUID, file_bytes: bytes
    ) -> dict:
        """Parse Excel and return preview with auto-mapped columns.

        Returns dict with: total_rows, column_mappings, sample_rows, warnings.
        """
        rows = import_attendees_from_excel(BytesIO(file_bytes))

        if not rows:
            return {
                "total_rows": 0,
                "column_mappings": [],
                "sample_rows": [],
                "warnings": ["Empty spreadsheet or no data rows found"],
            }

        # Get headers from first row keys
        headers = list(rows[0].keys())
        mappings = _auto_map_columns(headers)

        # Check for existing attendees (for duplicate detection)
        existing = await self._attendee_repo.get_by_event(event_id)
        existing_names = {a.name for a in existing}
        warnings = _detect_duplicates(rows, existing_names)

        # Rows missing a name (excel_io writes None for blank cells, not "")
        nameless = sum(1 for r in rows if not (r.get("name") or "").strip())
        if nameless > 0:
            warnings.insert(0, f"{nameless} rows have empty name field")

        return {
            "total_rows": len(rows),
            "column_mappings": mappings,
            "sample_rows": rows[:5],
            "warnings": warnings,
        }

    async def confirm_import(
        self,
        event_id: uuid.UUID,
        file_bytes: bytes,
        column_mappings: dict[str, str],
        skip_duplicates: bool = True,
    ) -> dict:
        """Import attendees with user-confirmed field mappings.

        Returns dict with: imported_count, skipped_count, errors.
        """
        rows = import_attendees_from_excel(BytesIO(file_bytes))

        existing = await self._attendee_repo.get_by_event(event_id)
        existing_names = {a.name for a in existing}

        imported = 0
        skipped = 0
        errors: list[str] = []

        for i, raw_row in enumerate(rows):
            # Apply user-defined column mappings
            mapped: dict = {}
            for excel_header, field_name in column_mappings.items():
                if field_name and excel_header in raw_row:
                    mapped[field_name] = raw_row[excel_header]

            name = (mapped.get("name") or "").strip()
            if not name:
                errors.append(f"Row {i + 1}: missing name, skipped")
                skipped += 1
                continue

            if skip_duplicates and name in existing_names:
                skipped += 1
                continue

            # Build create kwargs — only include valid attendee fields
            create_kwargs: dict = {"event_id": event_id, "name": name}
            for field in ("title", "organization", "department", "role", "phone", "email"):
                val = (mapped.get(field) or "").strip()
                if val:
                    create_kwargs[field] = val

            # Anything unmapped goes into attrs JSONB
            attrs: dict = {}
            for excel_header, value in raw_row.items():
                field = column_mappings.get(excel_header)
                if field is None and value:
                    attrs[excel_header] = value
            if attrs:
                create_kwargs["attrs"] = attrs

            try:
                await self._attendee_repo.create(**create_kwargs)
                imported += 1
                existing_names.add(name)
            except Exception as e:
                errors.append(f"Row {i + 1} ({name}): {e}")
                skipped += 1

        return {
            "imported_count": imported,
            "skipped_count": skipped,
            "errors": errors,
        }
