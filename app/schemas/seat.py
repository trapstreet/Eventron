"""Pydantic schemas for Seat API."""

import uuid
from typing import Optional

from pydantic import BaseModel, Field


class SeatCreate(BaseModel):
    """Request body for creating a seat."""

    row_num: int = Field(..., ge=1)
    col_num: int = Field(..., ge=1)
    label: Optional[str] = Field(None, max_length=20)
    seat_type: str = Field("normal", pattern=r"^(normal|reserved|disabled|aisle)$")
    zone: Optional[str] = Field(None, max_length=50)
    pos_x: Optional[float] = None
    pos_y: Optional[float] = None
    rotation: Optional[float] = 0.0


class SeatUpdate(BaseModel):
    """Request body for updating a seat."""

    label: Optional[str] = Field(None, max_length=20)
    seat_type: Optional[str] = Field(
        None, pattern=r"^(normal|reserved|disabled|aisle)$"
    )
    zone: Optional[str] = Field(None, max_length=50)
    attendee_id: Optional[uuid.UUID] = None
    pos_x: Optional[float] = None
    pos_y: Optional[float] = None
    rotation: Optional[float] = None


class SeatResponse(BaseModel):
    """Response body for seat data."""

    model_config = {"from_attributes": True}

    id: uuid.UUID
    event_id: uuid.UUID
    area_id: Optional[uuid.UUID] = None
    row_num: int
    col_num: int
    label: Optional[str]
    seat_type: str
    zone: Optional[str]
    attendee_id: Optional[uuid.UUID]
    pos_x: Optional[float] = None
    pos_y: Optional[float] = None
    rotation: Optional[float] = 0.0


class BulkSeatUpdate(BaseModel):
    """Bulk-update multiple seats at once (e.g. zone painting via drag-select)."""

    seat_ids: list[uuid.UUID] = Field(..., min_length=1, max_length=5000)
    zone: Optional[str] = Field(None, max_length=50)
    seat_type: Optional[str] = Field(
        None, pattern=r"^(normal|reserved|disabled|aisle)$"
    )
    # Translate all listed seats by the same delta. Used by the area-drag UX:
    # the frontend moves a whole area's seats by `(pos_dx, pos_dy)` after the
    # user drops the area rectangle.
    pos_dx: Optional[float] = None
    pos_dy: Optional[float] = None


class BulkSeatDelete(BaseModel):
    """Bulk-delete multiple seats at once (drag-select → delete UX)."""

    seat_ids: list[uuid.UUID] = Field(..., min_length=1, max_length=5000)


class LayoutRequest(BaseModel):
    """Request body for generating a venue layout."""

    layout_type: str = Field(
        "grid",
        pattern=(
            r"^(grid|theater|roundtable|banquet|u_shape|classroom|custom)$"
        ),
    )
    rows: int = Field(..., ge=1, le=100)
    cols: int = Field(..., ge=1, le=100)
    # Layout-specific overrides
    table_size: int = Field(8, ge=4, le=16, description="Seats per table (roundtable/banquet)")
    aisle_every: int = Field(0, ge=0, description="Insert aisle every N columns")
    spacing: float = Field(60.0, ge=30, le=120, description="Seat spacing in canvas units")


class CustomRowSpec(BaseModel):
    """One row-group specification for custom layouts."""

    count: int = Field(..., ge=1, le=200, description="Seats in this row")
    repeat: int = Field(1, ge=1, le=50, description="How many identical rows")
    spacing: float | None = Field(None, ge=30, le=120, description="Seat spacing override")
    zone: str | None = Field(None, max_length=50, description="Zone label")
    label_prefix: str | None = Field(None, max_length=5, description="Row label prefix")


class CustomLayoutRequest(BaseModel):
    """Request body for creating a layout with variable seats per row."""

    row_specs: list[CustomRowSpec] = Field(
        ..., min_length=1, max_length=50,
        description="Rows from front to back",
    )


class ZoneRule(BaseModel):
    """Maps a zone name to a minimum priority threshold."""
    zone: str
    min_priority: int = 0


class AutoAssignRequest(BaseModel):
    """Request body for auto-assigning seats."""

    strategy: str = Field(
        "random",
        pattern=r"^(random|priority_first|by_department|by_zone)$",
    )
    zone_rules: list[ZoneRule] | None = None
    # priority_first: high-priority attendees get front/center seats
    # by_zone: match attendee priority to seat zones (auto-infers if no rules)
