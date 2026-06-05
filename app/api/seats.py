"""Seat API routes — thin layer, delegates to SeatingService."""

import uuid

from fastapi import APIRouter, Depends, HTTPException

from app.deps import get_attendee_service, get_event_service, get_seating_service
from app.schemas.seat import (
    AutoAssignRequest,
    BulkSeatDelete,
    BulkSeatUpdate,
    CustomLayoutRequest,
    LayoutRequest,
    SeatResponse,
    SeatUpdate,
)
from app.services.attendee_service import AttendeeService
from app.services.event_service import EventService
from app.services.exceptions import (
    DuplicateAssignmentError,
    EventNotFoundError,
    SeatNotAvailableError,
    SeatNotFoundError,
)
from app.services.seating_service import SeatingService
from tools.seating_engine import suggest_zones

router = APIRouter()


@router.get("/{event_id}/seats", response_model=list[SeatResponse])
async def list_seats(
    event_id: uuid.UUID,
    svc: SeatingService = Depends(get_seating_service),
):
    """List all seats for an event."""
    seats = await svc.get_seats(event_id)
    return [SeatResponse.model_validate(s) for s in seats]


@router.post(
    "/{event_id}/seats/grid",
    response_model=list[SeatResponse],
    status_code=201,
)
async def create_seat_grid(
    event_id: uuid.UUID,
    rows: int,
    cols: int,
    svc: SeatingService = Depends(get_seating_service),
):
    """Create a simple rectangular seat grid (legacy)."""
    seats = await svc.create_venue_grid(event_id, rows, cols)
    return [SeatResponse.model_validate(s) for s in seats]


@router.post(
    "/{event_id}/seats/layout",
    response_model=list[SeatResponse],
    status_code=201,
)
async def create_venue_layout(
    event_id: uuid.UUID,
    body: LayoutRequest,
    svc: SeatingService = Depends(get_seating_service),
):
    """Generate seats using a layout template.

    Supports: grid, theater, roundtable, banquet, u_shape, classroom.
    Replaces any existing seats for the event.
    """
    seats = await svc.create_venue_layout(
        event_id,
        layout_type=body.layout_type,
        rows=body.rows,
        cols=body.cols,
        table_size=body.table_size,
        aisle_every=body.aisle_every,
        spacing=body.spacing,
        replace=True,
    )
    return [SeatResponse.model_validate(s) for s in seats]


@router.post(
    "/{event_id}/seats/custom-layout",
    response_model=list[SeatResponse],
    status_code=201,
)
async def create_custom_layout(
    event_id: uuid.UUID,
    body: CustomLayoutRequest,
    svc: SeatingService = Depends(get_seating_service),
):
    """Create layout with variable seats per row.

    Example: 3 rows of 8 VIP seats, then 12 rows of 20 general seats.
    """
    row_specs = [spec.model_dump(exclude_none=True) for spec in body.row_specs]
    seats = await svc.create_custom_layout(event_id, row_specs, replace=True)
    return [SeatResponse.model_validate(s) for s in seats]


@router.post("/{event_id}/seats/auto-assign")
async def auto_assign(
    event_id: uuid.UUID,
    body: AutoAssignRequest,
    svc: SeatingService = Depends(get_seating_service),
):
    """Run auto-assignment algorithm.

    Strategies: random, priority_first, by_department, by_zone.
    """
    zone_rules = (
        [r.model_dump() for r in body.zone_rules]
        if body.zone_rules
        else None
    )
    try:
        assignments = await svc.auto_assign(
            event_id, strategy=body.strategy, zone_rules=zone_rules,
        )
    except ValueError as e:
        msg = str(e)
        if "Not enough seats" in msg:
            msg = f"座位不足：{msg.split(':')[-1].strip()}"
        raise HTTPException(status_code=422, detail=msg)
    return {"assignments": assignments, "count": len(assignments)}


@router.post("/{event_id}/seats/{seat_id}/assign", response_model=SeatResponse)
async def assign_seat(
    event_id: uuid.UUID,
    seat_id: uuid.UUID,
    attendee_id: uuid.UUID,
    svc: SeatingService = Depends(get_seating_service),
):
    """Manually assign an attendee to a seat."""
    try:
        seat = await svc.assign_seat(seat_id, attendee_id)
    except SeatNotFoundError:
        raise HTTPException(status_code=404, detail="Seat not found")
    except (SeatNotAvailableError, DuplicateAssignmentError) as e:
        raise HTTPException(status_code=422, detail=str(e))
    return SeatResponse.model_validate(seat)


@router.patch("/{event_id}/seats/bulk")
async def bulk_update_seats(
    event_id: uuid.UUID,
    body: BulkSeatUpdate,
    svc: SeatingService = Depends(get_seating_service),
):
    """Bulk-update zone / type / position-delta on multiple seats.

    Dispatch order: position-delta first (it's used by the area-drag UX
    and may be combined with zone/type re-assignment on a future change),
    then zone/type. Caller usually supplies exactly one of the three.
    """
    updated = 0
    if body.pos_dx is not None or body.pos_dy is not None:
        updated = await svc.bulk_shift_seats(
            body.seat_ids,
            dx=body.pos_dx or 0.0,
            dy=body.pos_dy or 0.0,
        )
    elif body.zone is not None:
        updated = await svc.bulk_update_zone(body.seat_ids, body.zone)
    elif body.seat_type is not None:
        updated = await svc.bulk_update_type(body.seat_ids, body.seat_type)
    else:
        # Clear zone (set to None)
        updated = await svc.bulk_update_zone(body.seat_ids, None)
    return {"updated": updated}


@router.delete("/{event_id}/seats/bulk")
async def bulk_delete_seats(
    event_id: uuid.UUID,
    body: BulkSeatDelete,
    svc: SeatingService = Depends(get_seating_service),
):
    """Bulk-delete the given seats (drag-select → 删除 UX).

    Returns the number actually deleted; missing IDs are silently skipped
    (the UI optimistically removed them locally).
    """
    deleted = await svc.bulk_delete_seats(body.seat_ids)
    return {"deleted": deleted}


@router.patch("/{event_id}/seats/{seat_id}", response_model=SeatResponse)
async def update_seat(
    event_id: uuid.UUID,
    seat_id: uuid.UUID,
    body: SeatUpdate,
    svc: SeatingService = Depends(get_seating_service),
):
    """Update seat properties (zone, type, label, position)."""
    seat = await svc._seat_repo.get_by_id(seat_id)
    if seat is None:
        raise HTTPException(status_code=404, detail="Seat not found")

    data = body.model_dump(exclude_unset=True)
    for key, val in data.items():
        setattr(seat, key, val)
    await svc._seat_repo._session.flush()
    return SeatResponse.model_validate(seat)


@router.post("/{event_id}/seats/swap")
async def swap_seats(
    event_id: uuid.UUID,
    seat_a_id: uuid.UUID,
    seat_b_id: uuid.UUID,
    svc: SeatingService = Depends(get_seating_service),
):
    """Swap attendees between two seats."""
    try:
        a, b = await svc.swap_seats(seat_a_id, seat_b_id)
    except SeatNotFoundError:
        raise HTTPException(status_code=404, detail="Seat not found")
    return {
        "seat_a": SeatResponse.model_validate(a),
        "seat_b": SeatResponse.model_validate(b),
    }


@router.get("/{event_id}/seats/suggest-zones")
async def suggest_venue_zones(
    event_id: uuid.UUID,
    event_svc: EventService = Depends(get_event_service),
    att_svc: AttendeeService = Depends(get_attendee_service),
):
    """AI-suggested zone layout based on attendee composition.

    Returns zone suggestions with row ranges, colors, and descriptions.
    """
    try:
        event = await event_svc.get_event(event_id)
    except EventNotFoundError:
        raise HTTPException(status_code=404, detail="Event not found")

    attendees = await att_svc.list_attendees_for_event(event_id)
    att_dicts = [
        {
            "role": getattr(a, "role", "参会者") or "参会者",
            "priority": getattr(a, "priority", 0),
        }
        for a in attendees
    ]

    zones = suggest_zones(event.venue_rows, event.venue_cols, att_dicts)
    return {"zones": zones, "total_rows": event.venue_rows}
