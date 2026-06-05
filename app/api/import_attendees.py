"""Attendee import API — preview + confirm workflow."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, UploadFile

from app.api.auth import get_current_organizer
from app.deps import get_import_service
from app.schemas.import_preview import (
    ImportConfirmRequest,
    ImportPreviewResponse,
)
from app.services.import_service import ImportService

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
    """Upload Excel, get preview with auto-mapped columns."""
    if not file.filename or not file.filename.endswith((".xlsx", ".xls")):
        raise HTTPException(status_code=422, detail="Only .xlsx files are supported")

    content = await file.read()
    if len(content) > 10 * 1024 * 1024:  # 10MB limit
        raise HTTPException(status_code=422, detail="File too large (max 10MB)")

    result = await svc.preview(event_id, content)
    return ImportPreviewResponse(**result)


@router.post("/events/{event_id}/attendees/import-confirm")
async def import_confirm(
    event_id: uuid.UUID,
    file: UploadFile,
    body: ImportConfirmRequest = Depends(),
    organizer=Depends(get_current_organizer),
    svc: ImportService = Depends(get_import_service),
):
    """Confirm import with user-adjusted field mappings."""
    content = await file.read()
    result = await svc.confirm_import(
        event_id=event_id,
        file_bytes=content,
        column_mappings=body.column_mappings,
        skip_duplicates=body.skip_duplicates,
    )
    return result
