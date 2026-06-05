"""VenueArea repository — all venue-area-related DB queries."""

import uuid

from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.models.venue_area import VenueArea
from app.repositories.base import BaseRepository


class VenueAreaRepository(BaseRepository[VenueArea]):
    """Data access for VenueArea entities."""

    model = VenueArea

    async def get_by_event(
        self, event_id: uuid.UUID
    ) -> list[VenueArea]:
        """Fetch all areas for an event, ordered by display_order.

        Eager-loads ``seats`` so the route can compute ``seat_count``
        without triggering an async lazy-load (which 500'd in
        production with ``MissingGreenlet``).
        """
        stmt = (
            select(VenueArea)
            .where(VenueArea.event_id == event_id)
            .options(selectinload(VenueArea.seats))
            .order_by(VenueArea.display_order)
        )
        result = await self._session.execute(stmt)
        return list(result.scalars().all())
