"""Seat assignment + layout + swap logic — core business rules."""

import uuid

from app.models.seat import Seat
from app.models.venue_area import VenueArea
from app.repositories.attendee_repo import AttendeeRepository
from app.repositories.seat_repo import SeatRepository
from app.repositories.venue_area_repo import VenueAreaRepository
from app.services.exceptions import (
    AttendeeNotFoundError,
    DuplicateAssignmentError,
    SeatNotAvailableError,
    SeatNotFoundError,
)
from tools.seating_engine import (
    assign_seats_by_department,
    assign_seats_by_zone,
    assign_seats_priority_first,
    assign_seats_random,
    assign_seats_vip_first,
    generate_custom_layout,
    generate_layout,
)


class SeatingService:
    """Business logic for seat assignment and management."""

    def __init__(
        self,
        seat_repo: SeatRepository,
        attendee_repo: AttendeeRepository,
        area_repo: VenueAreaRepository | None = None,
    ):
        self._seat_repo = seat_repo
        self._attendee_repo = attendee_repo
        self._area_repo = area_repo

    def begin_nested(self):
        """Create a SAVEPOINT for atomic multi-step operations.

        Usage::

            async with seat_svc.begin_nested():
                await seat_svc.create_area(...)
                await seat_svc.generate_area_layout(...)
                # rolls back ALL if any step raises
        """
        return self._seat_repo._session.begin_nested()

    # ------------------------------------------------------------------
    # Venue layout creation
    # ------------------------------------------------------------------

    async def create_venue_grid(
        self, event_id: uuid.UUID, rows: int, cols: int
    ) -> list[Seat]:
        """Create a simple rectangular seat grid (legacy API)."""
        return await self._seat_repo.bulk_create_grid(event_id, rows, cols)

    async def create_venue_layout(
        self,
        event_id: uuid.UUID,
        layout_type: str,
        rows: int,
        cols: int,
        *,
        table_size: int = 8,
        aisle_every: int = 0,
        spacing: float = 60.0,
        replace: bool = True,
    ) -> list[Seat]:
        """Generate seats using a layout template.

        If `replace` is True, existing seats are removed first.

        Args:
            event_id: Target event.
            layout_type: grid|theater|roundtable|banquet|u_shape|classroom.
            rows, cols: Venue dimensions (interpretation varies by layout).
            table_size: Seats per table (roundtable/banquet).
            aisle_every: Insert aisle column every N seats.
            spacing: Canvas units between seats.
            replace: Delete existing seats before creating new ones.

        Returns:
            List of created Seat ORM objects.
        """
        if replace:
            await self._seat_repo.delete_by_event(event_id)

        specs = generate_layout(
            layout_type, rows, cols,
            spacing=spacing,
            table_size=table_size,
            aisle_every=aisle_every,
        )
        return await self._seat_repo.bulk_create_from_specs(event_id, specs)

    async def create_custom_layout(
        self,
        event_id: uuid.UUID,
        row_specs: list[dict],
        *,
        replace: bool = True,
    ) -> list[Seat]:
        """Create layout with variable seats per row.

        Each row_spec: {count, repeat?, spacing?, zone?, label_prefix?}
        """
        if replace:
            await self._seat_repo.delete_by_event(event_id)
        specs = generate_custom_layout(row_specs)
        return await self._seat_repo.bulk_create_from_specs(event_id, specs)

    # ------------------------------------------------------------------
    # Queries
    # ------------------------------------------------------------------

    async def get_seats(self, event_id: uuid.UUID) -> list[Seat]:
        """Get all seats for an event."""
        return await self._seat_repo.get_by_event(event_id)

    async def clear_all_seats(self, event_id: uuid.UUID) -> int:
        """Delete every seat for an event (used before bulk regenerate)."""
        return await self._seat_repo.delete_by_event(event_id)

    async def get_available_seats(self, event_id: uuid.UUID) -> list[Seat]:
        """Get unoccupied, non-disabled seats."""
        return await self._seat_repo.get_available_seats(event_id)

    # ------------------------------------------------------------------
    # Auto-assignment
    # ------------------------------------------------------------------

    async def auto_assign(
        self,
        event_id: uuid.UUID,
        strategy: str = "random",
        zone_rules: list[dict] | None = None,
    ) -> list[dict[str, str]]:
        """Run auto-assignment algorithm and persist results.

        Args:
            event_id: Target event.
            strategy: 'random', 'priority_first', 'by_department',
                      'by_zone', or legacy 'vip_first'.
            zone_rules: For by_zone strategy, list of
                {zone: str, min_priority: int}.

        Returns:
            List of {attendee_id, seat_id} assignments made.
        """
        attendees = await self._attendee_repo.get_by_event(event_id)
        all_seats = await self._seat_repo.get_by_event(event_id)
        seats = await self._seat_repo.get_available_seats(event_id)

        seated_ids = {
            str(s.attendee_id) for s in all_seats if s.attendee_id is not None
        }

        att_dicts = [
            {
                "id": str(a.id),
                "name": a.name,
                "role": a.role,
                "priority": getattr(a, "priority", 0),
                "department": a.department,
            }
            for a in attendees
            if a.status in ("confirmed", "pending")
            and str(a.id) not in seated_ids
        ]
        seat_dicts = [
            {
                "id": str(s.id),
                "row_num": s.row_num,
                "col_num": s.col_num,
                "zone": getattr(s, "zone", None),
            }
            for s in seats
        ]

        if strategy == "priority_first":
            assignments = assign_seats_priority_first(att_dicts, seat_dicts)
        elif strategy == "by_department":
            assignments = assign_seats_by_department(att_dicts, seat_dicts)
        elif strategy == "by_zone":
            assignments = assign_seats_by_zone(
                att_dicts, seat_dicts, zone_rules
            )
        elif strategy == "vip_first":
            # Legacy compat
            assignments = assign_seats_vip_first(att_dicts, seat_dicts)
        else:
            assignments = assign_seats_random(att_dicts, seat_dicts)

        for a in assignments:
            await self._seat_repo.assign_attendee(
                uuid.UUID(a["seat_id"]),
                uuid.UUID(a["attendee_id"]),
            )

        return assignments

    # ------------------------------------------------------------------
    # Bulk operations
    # ------------------------------------------------------------------

    async def bulk_update_zone(
        self,
        seat_ids: list[uuid.UUID],
        zone: str | None,
    ) -> int:
        """Set zone on multiple seats (drag-select zone painting)."""
        return await self._seat_repo.bulk_update_zone(seat_ids, zone)

    async def bulk_update_type(
        self,
        seat_ids: list[uuid.UUID],
        seat_type: str,
    ) -> int:
        """Set seat_type on multiple seats."""
        return await self._seat_repo.bulk_update_type(seat_ids, seat_type)

    async def bulk_shift_seats(
        self,
        seat_ids: list[uuid.UUID],
        dx: float,
        dy: float,
    ) -> int:
        """Translate ``pos_x``/``pos_y`` on every listed seat by ``(dx, dy)``.

        Drives the area-drag UX — moving an area shifts all its seats.
        """
        return await self._seat_repo.bulk_shift(seat_ids, dx, dy)

    async def bulk_delete_seats(
        self,
        seat_ids: list[uuid.UUID],
    ) -> int:
        """Delete every seat in ``seat_ids``."""
        return await self._seat_repo.bulk_delete(seat_ids)

    # ------------------------------------------------------------------
    # Single-seat operations
    # ------------------------------------------------------------------

    async def assign_seat(
        self, seat_id: uuid.UUID, attendee_id: uuid.UUID
    ) -> Seat:
        """Manually assign one attendee to one seat."""
        seat = await self._seat_repo.get_by_id(seat_id)
        if seat is None:
            raise SeatNotFoundError(f"Seat {seat_id} not found")
        if seat.attendee_id is not None:
            raise SeatNotAvailableError(f"Seat {seat_id} is already occupied")
        if seat.seat_type in ("disabled", "aisle"):
            raise SeatNotAvailableError(f"Seat {seat_id} is {seat.seat_type}")

        attendee = await self._attendee_repo.get_by_id(attendee_id)
        if attendee is None:
            raise AttendeeNotFoundError(f"Attendee {attendee_id} not found")

        existing = await self._seat_repo.get_by_attendee(attendee_id)
        if existing is not None:
            raise DuplicateAssignmentError(
                f"Attendee {attendee_id} already has seat {existing.label}"
            )

        result = await self._seat_repo.assign_attendee(seat_id, attendee_id)
        if result is None:
            raise SeatNotFoundError(f"Seat {seat_id} not found")
        return result

    async def unassign_seat(self, seat_id: uuid.UUID) -> Seat:
        """Remove attendee from a seat."""
        result = await self._seat_repo.unassign(seat_id)
        if result is None:
            raise SeatNotFoundError(f"Seat {seat_id} not found")
        return result

    async def swap_seats(
        self, seat_a_id: uuid.UUID, seat_b_id: uuid.UUID
    ) -> tuple[Seat, Seat]:
        """Swap attendees between two seats."""
        a, b = await self._seat_repo.swap_seats(seat_a_id, seat_b_id)
        if a is None or b is None:
            raise SeatNotFoundError("One or both seats not found")
        return (a, b)

    # ------------------------------------------------------------------
    # Venue areas
    # ------------------------------------------------------------------

    async def list_areas(self, event_id: uuid.UUID) -> list[VenueArea]:
        """List all venue areas for an event."""
        if self._area_repo is None:
            return []
        return await self._area_repo.get_by_event(event_id)

    async def create_area(
        self, event_id: uuid.UUID, **kwargs,
    ) -> VenueArea:
        """Create a new venue area."""
        assert self._area_repo is not None
        return await self._area_repo.create(event_id=event_id, **kwargs)

    async def update_area(
        self, area_id: uuid.UUID, **kwargs,
    ) -> VenueArea | None:
        """Update a venue area."""
        assert self._area_repo is not None
        return await self._area_repo.update(area_id, **kwargs)

    async def delete_area(self, area_id: uuid.UUID) -> bool:
        """Delete a venue area and all its seats."""
        assert self._area_repo is not None
        # Delete seats in this area first
        area = await self._area_repo.get_by_id(area_id)
        if area is None:
            return False
        await self._seat_repo.delete_by_area(area_id)
        return await self._area_repo.delete(area_id)

    async def generate_area_layout(
        self, event_id: uuid.UUID, area_id: uuid.UUID,
    ) -> list[Seat]:
        """Generate seats within a specific area.

        Uses the area's layout_type, rows, cols. Replaces existing
        seats in this area (not the whole event).
        """
        assert self._area_repo is not None
        area = await self._area_repo.get_by_id(area_id)
        if area is None:
            raise SeatNotFoundError(f"Area {area_id} not found")

        # Delete existing seats in this area
        await self._seat_repo.delete_by_area(area_id)

        specs = generate_layout(
            area.layout_type, area.rows, area.cols,
            spacing=46.0,
        )

        # Offset specs by area's offset_x/offset_y
        for s in specs:
            s["pos_x"] = s.get("pos_x", 0) + area.offset_x
            s["pos_y"] = s.get("pos_y", 0) + area.offset_y
            s["area_id"] = area_id

        return await self._seat_repo.bulk_create_from_specs(
            event_id, specs,
        )
