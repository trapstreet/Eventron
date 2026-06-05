"""Attendee import API — preview + confirm workflow."""

from __future__ import annotations

import logging
import uuid

from fastapi import APIRouter, Depends, HTTPException, UploadFile

from app.api.auth import get_current_organizer
from app.deps import get_import_service
from app.schemas.import_preview import (
    ImportConfirmRequest,
    ImportPreviewResponse,
)
from app.services.import_service import ImportService

logger = logging.getLogger(__name__)

router = APIRouter()


@router.post(
    "/events/{event_id}/attendees/import-preview",
    response_model=ImportPreviewResponse,
)
async def import_preview(
    event_id: uuid.UUID,
    file: UploadFile,
    organizer=Depends(get_current_organizer),
    svc: ImportService = Depends(get_import_service),
):
    """Upload Excel, get preview with auto-mapped columns.

    Errors are intentionally caught and re-raised as HTTPException so the
    response body is always JSON (``{"detail": "..."}``). Returning FastAPI's
    default ``Internal Server Error`` plain-text 500 page would crash the
    frontend's response.json() call with "Unexpected token 'I'".
    """
    if not file.filename or not file.filename.endswith((".xlsx", ".xls")):
        raise HTTPException(status_code=422, detail="只支持 .xlsx / .xls 文件")

    content = await file.read()
    if len(content) > 10 * 1024 * 1024:  # 10MB limit
        raise HTTPException(status_code=422, detail="文件过大（上限 10MB）")

    try:
        result = await svc.preview(event_id, content)
    except ValueError as e:
        # ValueError is the service's "the file isn't usable" signal — empty
        # workbook, no header row, missing 姓名 column, etc. User-facing.
        raise HTTPException(status_code=422, detail=str(e)) from e
    except HTTPException:
        raise
    except Exception as e:
        # Unexpected — log full traceback server-side, surface the type +
        # message to the user so the import tab isn't a black box.
        logger.exception("import_preview failed for event %s", event_id)
        raise HTTPException(
            status_code=500,
            detail=f"导入预览失败：{type(e).__name__}: {e}",
        ) from e

    return ImportPreviewResponse(**result)


@router.post("/events/{event_id}/attendees/import-confirm")
async def import_confirm(
    event_id: uuid.UUID,
    file: UploadFile,
    body: ImportConfirmRequest = Depends(),
    organizer=Depends(get_current_organizer),
    svc: ImportService = Depends(get_import_service),
):
    """Confirm import with user-adjusted field mappings.

    Same error-shaping policy as ``import_preview`` — always JSON response.
    """
    content = await file.read()
    try:
        result = await svc.confirm_import(
            event_id=event_id,
            file_bytes=content,
            column_mappings=body.column_mappings,
            skip_duplicates=body.skip_duplicates,
        )
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("import_confirm failed for event %s", event_id)
        raise HTTPException(
            status_code=500,
            detail=f"导入失败：{type(e).__name__}: {e}",
        ) from e
    return result
