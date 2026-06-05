"""Seat repository — all seat-related DB queries."""

import uuid
from typing import Any

from sqlalchemy import delete, select, update

from app.models.seat import Seat
from app.repositories.base import BaseRepository


class SeatRepository(BaseRepository[Seat]):
    """Data access for Seat entities."""

    model = Seat

    async def get_by_event(self, event_id: uuid.UUID) -> list[Seat]:
        """Fetch all seats for an event, ordered by row then col."""
        stmt = (
            select(Seat)
            .where(Seat.event_id == event_id)
            .order_by(Seat.row_num, Seat.col_num)
        )
        result = await self._session.execute(stmt)
        return list(result.scalars().all())

    async def get_available_seats(self, event_id: uuid.UUID) -> list[Seat]:
        """Fetch seats that have no attendee and are not disabled/aisle."""
        stmt = (
            select(Seat)
            .where(Seat.event_id == event_id)
            .where(Seat.attendee_id.is_(None))
            .where(Seat.seat_type.notin_(["disabled", "aisle"]))
            .order_by(Seat.row_num, Seat.col_num)
        )
        result = await self._session.execute(stmt)
        return list(result.scalars().all())

    async def assign_attendee(
        self, seat_id: uuid.UUID, attendee_id: uuid.UUID
    ) -> Seat | None:
        """Assign an attendee to a seat."""
        return await self.update(seat_id, attendee_id=attendee_id)

    async def unassign(self, seat_id: uuid.UUID) -> Seat | None:
        """Remove attendee from a seat."""
        return await self.update(seat_id, attendee_id=None)

    async def swap_seats(
        self, seat_a_id: uuid.UUID, seat_b_id: uuid.UUID
    ) -> tuple[Seat | None, Seat | None]:
        """Swap the attendees of two seats atomically."""
        seat_a = await self.get_by_id(seat_a_id)
        seat_b = await self.get_by_id(seat_b_id)
        if seat_a is None or seat_b is None:
            return (None, None)

        seat_a.attendee_id, seat_b.attendee_id = (
            seat_b.attendee_id, seat_a.attendee_id
        )
        await self._session.flush()
        await self._session.refresh(seat_a)
        await self._session.refresh(seat_b)
        return (seat_a, seat_b)

    async def bulk_create_grid(
        self, event_id: uuid.UUID, rows: int, cols: int
    ) -> list[Seat]:
        """Create a rectangular seat grid (legacy — no pos_x/pos_y)."""
        return await self.bulk_create_from_specs(
            event_id,
            [
                {
                    "row_num": r,
                    "col_num": c,
                    "label": f"{chr(64 + r)}{c}",
                    "seat_type": "normal",
                    "pos_x": (c - 1) * 60.0,
                    "pos_y": (r - 1) * 60.0,
                    "rotation": 0,
                }
                for r in range(1, rows + 1)
                for c in range(1, cols + 1)
            ],
        )

    async def bulk_create_from_specs(
        self,
        event_id: uuid.UUID,
        specs: list[dict[str, Any]],
    ) -> list[Seat]:
        """Create seats from layout generator output (pos_x/pos_y aware).

        Args:
            event_id: Target event UUID.
            specs: List of dicts from seating_engine.generate_layout().
        """
        seats: list[Seat] = []
        for spec in specs:
            seat = Seat(
                event_id=event_id,
                row_num=spec["row_num"],
                col_num=spec["col_num"],
                label=spec.get("label", ""),
                seat_type=spec.get("seat_type", "normal"),
                pos_x=spec.get("pos_x"),
                pos_y=spec.get("pos_y"),
                rotation=spec.get("rotation", 0),
                zone=spec.get("zone"),
                area_id=spec.get("area_id"),
            )
            self._session.add(seat)
            seats.append(seat)
        await self._session.flush()
        for s in seats:
            await self._session.refresh(s)
        return seats

    async def bulk_update_zone(
        self,
        seat_ids: list[uuid.UUID],
        zone: str | None,
    ) -> int:
        """Set zone on multiple seats at once (drag-select painting)."""
        if not seat_ids:
            return 0
        stmt = (
            update(Seat)
            .where(Seat.id.in_(seat_ids))
            .values(zone=zone)
        )
        result = await self._session.execute(stmt)
        await self._session.flush()
        return result.rowcount  # type: ignore[return-value]

    async def bulk_update_type(
        self,
        seat_ids: list[uuid.UUID],
        seat_type: str,
    ) -> int:
        """Set seat_type on multiple seats at once."""
        if not seat_ids:
            return 0
        stmt = (
            update(Seat)
            .where(Seat.id.in_(seat_ids))
            .values(seat_type=seat_type)
        )
        result = await self._session.execute(stmt)
        await self._session.flush()
        return result.rowcount  # type: ignore[return-value]

    async def bulk_shift(
        self,
        seat_ids: list[uuid.UUID],
        dx: float,
        dy: float,
    ) -> int:
        """Translate `pos_x`/`pos_y` by `(dx, dy)` for each listed seat.

        Used by the area-drag UX: when the user drops a venue area in a
        new spot, every seat inside gets shifted by the same delta so
        the visual layout follows the move.
        """
        if not seat_ids or (dx == 0 and dy == 0):
            return 0
        stmt = (
            update(Seat)
            .where(Seat.id.in_(seat_ids))
            .values(
                pos_x=Seat.pos_x + dx,
                pos_y=Seat.pos_y + dy,
            )
        )
        result = await self._session.execute(stmt)
        await self._session.flush()
        return result.rowcount  # type: ignore[return-value]

    async def bulk_delete(self, seat_ids: list[uuid.UUID]) -> int:
        """Delete every seat whose id is in `seat_ids`.

        Drag-select → 删除 UX. Missing IDs are skipped silently.
        """
        if not seat_ids:
            return 0
        stmt = delete(Seat).where(Seat.id.in_(seat_ids))
        result = await self._session.execute(stmt)
        await self._session.flush()
        return result.rowcount  # type: ignore[return-value]

    async def delete_by_event(self, event_id: uuid.UUID) -> int:
        """Delete all seats for an event (before re-generating layout)."""
        seats = await self.get_by_event(event_id)
        count = len(seats)
        for s in seats:
            await self._session.delete(s)
        await self._session.flush()
        return count

    async def delete_by_area(self, area_id: uuid.UUID) -> int:
        """Delete all seats in a specific venue area."""
        stmt = select(Seat).where(Seat.area_id == area_id)
        result = await self._session.execute(stmt)
        seats = list(result.scalars().all())
        for s in seats:
            await self._session.delete(s)
        await self._session.flush()
        return len(seats)

    async def get_by_attendee(self, attendee_id: uuid.UUID) -> Seat | None:
        """Find the seat assigned to a specific attendee."""
        stmt = select(Seat).where(Seat.attendee_id == attendee_id)
        result = await self._session.execute(stmt)
        return result.scalars().first()
