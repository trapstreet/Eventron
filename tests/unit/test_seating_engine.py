"""Unit tests for seating_engine — pure function tests, no DB."""

import pytest

from tests.factories import make_attendee, make_seat_grid
from tools.seating_engine import (
    assign_seats_by_department,
    assign_seats_random,
    assign_seats_vip_first,
    generate_layout,
    generate_seat_labels,
)


class TestAssignSeatsRandom:
    """Tests for random seat assignment."""

    def test_happy_path_all_assigned(self):
        """All attendees get a seat."""
        attendees = [make_attendee(id=f"a{i}") for i in range(5)]
        seats = make_seat_grid(2, 3)  # 6 seats
        result = assign_seats_random(attendees, seats)
        assert len(result) == 5
        assert all("attendee_id" in r and "seat_id" in r for r in result)

    def test_empty_attendees_returns_empty(self):
        """No attendees → empty result."""
        seats = make_seat_grid(2, 2)
        result = assign_seats_random([], seats)
        assert result == []

    def test_more_attendees_than_seats_partial_assign(self):
        """Should assign as many as possible when more attendees than seats."""
        attendees = [make_attendee(id=f"a{i}") for i in range(10)]
        seats = make_seat_grid(1, 3)  # 3 seats
        result = assign_seats_random(attendees, seats)
        assert len(result) == 3  # only 3 seats available
        seat_ids = [r["seat_id"] for r in result]
        assert len(set(seat_ids)) == 3  # no duplicates

    def test_exact_fit(self):
        """Exactly as many attendees as seats."""
        attendees = [make_attendee(id=f"a{i}") for i in range(4)]
        seats = make_seat_grid(2, 2)
        result = assign_seats_random(attendees, seats)
        assert len(result) == 4
        # All seat IDs should be unique
        seat_ids = [r["seat_id"] for r in result]
        assert len(set(seat_ids)) == 4

    def test_no_duplicate_seat_assignments(self):
        """Each seat is assigned to at most one attendee."""
        attendees = [make_attendee(id=f"a{i}") for i in range(6)]
        seats = make_seat_grid(3, 3)  # 9 seats
        result = assign_seats_random(attendees, seats)
        seat_ids = [r["seat_id"] for r in result]
        assert len(seat_ids) == len(set(seat_ids))


class TestAssignSeatsVipFirst:
    """Tests for VIP-priority assignment."""

    def test_vip_gets_front_row_center(self):
        """VIP should get the best seats (front row, center)."""
        attendees = [
            make_attendee(id="vip1", role="vip"),
            make_attendee(id="reg1", role="attendee"),
            make_attendee(id="reg2", role="attendee"),
        ]
        seats = make_seat_grid(3, 3)  # 9 seats
        result = assign_seats_vip_first(attendees, seats)

        # VIP should be first in assignments (gets best seat)
        assert result[0]["attendee_id"] == "vip1"

    def test_speaker_treated_as_vip(self):
        """Speaker role is VIP by default."""
        attendees = [
            make_attendee(id="spk1", role="speaker"),
            make_attendee(id="reg1", role="attendee"),
        ]
        seats = make_seat_grid(2, 2)
        result = assign_seats_vip_first(attendees, seats)
        assert result[0]["attendee_id"] == "spk1"

    def test_all_vip_fills_front_to_back(self):
        """When everyone is VIP, seats fill front-to-back."""
        attendees = [make_attendee(id=f"v{i}", role="vip") for i in range(4)]
        seats = make_seat_grid(2, 2)
        result = assign_seats_vip_first(attendees, seats)
        assert len(result) == 4

    def test_empty_attendees(self):
        result = assign_seats_vip_first([], make_seat_grid(2, 2))
        assert result == []

    def test_overflow_partial_assign(self):
        """Should assign as many as possible when overflow."""
        attendees = [make_attendee(id=f"a{i}") for i in range(5)]
        seats = make_seat_grid(1, 2)
        result = assign_seats_vip_first(attendees, seats)
        assert len(result) == 2  # only 2 seats available

    def test_custom_vip_roles(self):
        """Custom vip_roles parameter is respected."""
        attendees = [
            make_attendee(id="org1", role="organizer"),
            make_attendee(id="reg1", role="attendee"),
        ]
        seats = make_seat_grid(2, 2)
        result = assign_seats_vip_first(
            attendees, seats, vip_roles=("organizer",)
        )
        assert result[0]["attendee_id"] == "org1"


class TestAssignSeatsByDepartment:
    """Tests for department-grouped assignment."""

    def test_same_department_sits_together(self):
        """Members of the same department should be in consecutive seats."""
        attendees = [
            make_attendee(id="a1", department="Sales"),
            make_attendee(id="a2", department="Engineering"),
            make_attendee(id="a3", department="Sales"),
        ]
        seats = make_seat_grid(1, 3)
        result = assign_seats_by_department(attendees, seats)

        # Sales people (a1, a3) should be adjacent
        sales_indices = [
            i for i, r in enumerate(result) if r["attendee_id"] in ("a1", "a3")
        ]
        assert abs(sales_indices[0] - sales_indices[1]) == 1

    def test_empty_attendees(self):
        result = assign_seats_by_department([], make_seat_grid(2, 2))
        assert result == []

    def test_no_department_falls_to_default_group(self):
        """Attendees without department go to a default group."""
        attendees = [
            make_attendee(id="a1", department=None),
            make_attendee(id="a2", department=None),
        ]
        seats = make_seat_grid(1, 2)
        result = assign_seats_by_department(attendees, seats)
        assert len(result) == 2


class TestGenerateSeatLabels:
    """Tests for seat label generation."""

    def test_alpha_labels(self):
        labels = generate_seat_labels(2, 3, style="alpha")
        assert len(labels) == 6
        assert labels[0] == {"row_num": 1, "col_num": 1, "label": "A1"}
        assert labels[5] == {"row_num": 2, "col_num": 3, "label": "B3"}

    def test_numeric_labels(self):
        labels = generate_seat_labels(2, 2, style="numeric")
        assert labels[0]["label"] == "1-1"
        assert labels[3]["label"] == "2-2"

    def test_single_seat(self):
        labels = generate_seat_labels(1, 1)
        assert len(labels) == 1
        assert labels[0]["label"] == "A1"


class TestGenerateLayout:
    """Tests for free-form layout generators."""

    def _check_fields(self, seats: list[dict]):
        """Assert all required fields are present."""
        for s in seats:
            assert "row_num" in s
            assert "col_num" in s
            assert "pos_x" in s
            assert "pos_y" in s
            assert "label" in s
            assert "seat_type" in s
            assert isinstance(s["pos_x"], (int, float))
            assert isinstance(s["pos_y"], (int, float))

    def test_grid_layout_correct_count(self):
        seats = generate_layout("grid", 3, 4)
        assert len(seats) == 12
        self._check_fields(seats)

    def test_grid_layout_positions(self):
        seats = generate_layout("grid", 2, 2, spacing=60)
        xs = sorted({s["pos_x"] for s in seats})
        ys = sorted({s["pos_y"] for s in seats})
        assert xs == [0.0, 60.0]
        assert ys == [0.0, 60.0]

    def test_theater_layout_curved(self):
        """Theater seats should have varying x positions (arc)."""
        seats = generate_layout("theater", 5, 10)
        assert len(seats) >= 50
        self._check_fields(seats)
        # Back rows should be wider than front rows
        row1_xs = [s["pos_x"] for s in seats if s["row_num"] == 1]
        row5_xs = [s["pos_x"] for s in seats if s["row_num"] == 5]
        assert max(row5_xs) - min(row5_xs) >= max(row1_xs) - min(row1_xs)

    def test_classroom_layout(self):
        seats = generate_layout("classroom", 3, 6)
        assert len(seats) == 18
        self._check_fields(seats)

    def test_roundtable_layout(self):
        seats = generate_layout("roundtable", 4, 6, table_size=8)
        # 24 total seats, 3 tables of 8
        assert len(seats) == 24
        self._check_fields(seats)
        # Labels should contain table prefix
        assert seats[0]["label"].startswith("T")

    def test_banquet_layout(self):
        seats = generate_layout("banquet", 3, 4, table_size=8)
        assert len(seats) == 12
        self._check_fields(seats)

    def test_u_shape_layout(self):
        seats = generate_layout("u_shape", 5, 8)
        # Left=5 + bottom=6 + right=5 = 16
        assert len(seats) == 16
        self._check_fields(seats)
        labels = [s["label"] for s in seats]
        assert any(l.startswith("L") for l in labels)
        assert any(l.startswith("R") for l in labels)
        assert any(l.startswith("B") for l in labels)

    def test_unknown_layout_defaults_to_grid(self):
        seats = generate_layout("unknown", 2, 3)
        assert len(seats) == 6

    def test_rotation_present_for_roundtable(self):
        seats = generate_layout("roundtable", 2, 4, table_size=8)
        rotations = {s.get("rotation", 0) for s in seats}
        # Round tables should have varied rotations
        assert len(rotations) > 1

    def _table_sizes(self, seats):
        """Group seat count by table prefix (T1, T2, ...)."""
        counts: dict[str, int] = {}
        for s in seats:
            label = s.get("label", "")
            if "-" in label:
                counts[label.split("-")[0]] = (
                    counts.get(label.split("-")[0], 0) + 1
                )
        return counts

    def test_roundtable_tables_x_seats_contract(self):
        """Caller contract: passing table_size == cols makes (rows, cols)
        mean exactly (n_tables, seats_per_table).

        This is what generate_area_layout / create_layout rely on so the
        UI can offer 桌数 × 每桌人数 instead of the confusing 行×列.
        """
        for n_tables, per_table in [(10, 8), (12, 10), (4, 2), (3, 20)]:
            seats = generate_layout(
                "roundtable", n_tables, per_table,
                table_size=per_table,
            )
            assert len(seats) == n_tables * per_table
            sizes = self._table_sizes(seats)
            assert len(sizes) == n_tables
            assert set(sizes.values()) == {per_table}

    def test_banquet_tables_x_seats_contract(self):
        for n_tables, per_table in [(8, 10), (6, 12), (2, 16)]:
            seats = generate_layout(
                "banquet", n_tables, per_table,
                table_size=per_table,
            )
            assert len(seats) == n_tables * per_table
            sizes = self._table_sizes(seats)
            assert len(sizes) == n_tables
            assert set(sizes.values()) == {per_table}
