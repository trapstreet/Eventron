import { useState, useMemo, useRef, useCallback, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Grid3X3, Shuffle, Users, Download, Sparkles,
  Paintbrush, X, ZoomIn, ZoomOut, Move, MousePointer,
  UserPlus, XCircle, Maximize, Layers, Plus, Trash2,
} from 'lucide-react';
import { apiClient } from '../../lib/api';
import type { VenueArea } from '../../lib/api';
import { SubAgentPanel } from '../SubAgentPanel';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

interface SeatingTabProps {
  eventId: string;
  event: {
    venue_rows: number;
    venue_cols: number;
    layout_type: string;
  };
}

interface Seat {
  id: string;
  row_num: number;
  col_num: number;
  label: string;
  seat_type: string;
  zone: string | null;
  attendee_id: string | null;
  pos_x: number | null;
  pos_y: number | null;
  rotation: number | null;
  area_id: string | null;
}

interface Attendee {
  id: string;
  name: string;
  role: string;
  priority: number;
  department: string | null;
  status: string;
}

interface ZoneSuggestion {
  zone: string;
  rows: number[];
  count: number;
  color: string;
  description: string;
}

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

const LAYOUT_OPTIONS: { value: string; label: string; desc: string }[] = [
  { value: 'grid', label: '方形网格', desc: '标准长方形网格' },
  { value: 'theater', label: '剧院弧形', desc: '弧形排列，面向讲台' },
  { value: 'classroom', label: '课桌式', desc: '双人课桌排列' },
  { value: 'roundtable', label: '圆桌式', desc: '多桌圆形座位' },
  { value: 'banquet', label: '宴会长桌', desc: '长桌两侧座位' },
  { value: 'u_shape', label: 'U 形', desc: '三面围合，适合会议' },
];

/** Rotating color palette for auto-generated zone colors */
const ZONE_COLORS = [
  '#e2b93b', '#4a90d9', '#9b59b6', '#27ae60', '#6b7280',
  '#e94560', '#00b894', '#fd79a8', '#636e72', '#0984e3',
];

const SEAT_W = 42;   // seat width  (3 Chinese chars ≈ 36px @12px; < 46 spacing)
const SEAT_H = 32;   // seat height
const SEAT_RX = 4;   // corner radius — rounded-rect
const SEL_PAD = 3;   // selection ring padding
const BACK_H = 5;    // chair-back thickness
const MIN_ZOOM = 0.3;
const MAX_ZOOM = 3;
// Zoom factor per wheel "step" (120 deltaY = 1 "notch" on most mice)
const ZOOM_STEP = 0.06;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function getSeatFill(
  seat: Seat,
  att: Attendee | undefined,
  zoneColorMap: Map<string, string>,
): string {
  if (seat.seat_type === 'disabled') return '#d1d5db';
  if (seat.seat_type === 'aisle') return 'transparent';
  // Zone color is primary — occupied seats use higher opacity, empty seats lighter
  if (seat.zone) {
    const zc = zoneColorMap.get(seat.zone);
    if (zc) {
      if (seat.seat_type === 'reserved') return `${zc}55`;
      return seat.attendee_id ? `${zc}66` : `${zc}33`;
    }
  }
  // No zone: fall back to assignment-based colors
  if (seat.attendee_id && att) {
    if (att.priority >= 10) return '#c4b5fd';
    if (att.priority >= 5) return '#fde68a';
    return '#bbf7d0';
  }
  if (seat.seat_type === 'reserved') return '#fef3c7';
  return '#dbeafe';
}

function getSeatStroke(
  seat: Seat,
  att: Attendee | undefined,
  zoneColorMap: Map<string, string>,
): string {
  if (seat.seat_type === 'disabled') return '#9ca3af';
  if (seat.seat_type === 'aisle') return 'transparent';
  // Zone color is primary for stroke too
  if (seat.zone) {
    const zc = zoneColorMap.get(seat.zone);
    if (zc) return zc;
  }
  // No zone: fall back to priority-based stroke
  if (seat.attendee_id && att) {
    if (att.priority >= 10) return '#7c3aed';
    if (att.priority >= 5) return '#d97706';
    return '#22c55e';
  }
  return '#93c5fd';
}

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

export function SeatingTab({ eventId, event }: SeatingTabProps) {
  // ── state ──
  const [selectedSeat, setSelectedSeat] = useState<Seat | null>(null);
  const [strategy, setStrategy] = useState('priority_first');
  const [paintMode, setPaintMode] = useState(false);
  const [paintZone, setPaintZone] = useState<string>('');
  const [showZonePanel, setShowZonePanel] = useState(false);
  const [layoutType, setLayoutType] = useState(event.layout_type || 'grid');
  const [rows, setRows] = useState(event.venue_rows || 5);
  const [cols, setCols] = useState(event.venue_cols || 8);
  const [tableSize, setTableSize] = useState(8);
  // Assign picker
  const [showAssignPicker, setShowAssignPicker] = useState(false);
  const [assignSearch, setAssignSearch] = useState('');

  // Area management
  const [showAreaPanel, setShowAreaPanel] = useState(false);
  const [newAreaName, setNewAreaName] = useState('');
  const [newAreaLayout, setNewAreaLayout] = useState('grid');
  const [newAreaRows, setNewAreaRows] = useState(5);
  const [newAreaCols, setNewAreaCols] = useState(10);
  const [newAreaStage, setNewAreaStage] = useState('');

  // SVG pan/zoom
  const zoomRef = useRef(1);
  const [zoom, _setZoom] = useState(1);
  const setZoom = useCallback((v: number | ((z: number) => number)) => {
    _setZoom((prev) => {
      const next = typeof v === 'function' ? v(prev) : v;
      const clamped = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(next * 100) / 100));
      zoomRef.current = clamped;
      return clamped;
    });
  }, []);
  const panRef = useRef({ x: 40, y: 60 });
  const [pan, _setPan] = useState({ x: 40, y: 60 });
  const setPan = useCallback((v: { x: number; y: number }) => {
    panRef.current = v;
    _setPan(v);
  }, []);
  const [isPanning, setIsPanning] = useState(false);
  const panStart = useRef({ x: 0, y: 0, px: 0, py: 0 });

  // Drag selection
  const [selRect, setSelRect] = useState<{
    x: number; y: number; w: number; h: number;
  } | null>(null);
  const selStart = useRef<{ x: number; y: number } | null>(null);

  // Tool mode: 'select' | 'pan'
  const [toolMode, setToolMode] = useState<'select' | 'pan'>('select');

  // Multi-select set populated by drag-select in 'select' mode (NOT paint
  // mode — paint-mode drag immediately fires the zone bulk-update instead).
  // When non-empty, a floating action bar surfaces "删除 / 清除".
  const [selectedSeatIds, setSelectedSeatIds] = useState<Set<string>>(new Set());
  const selectedSeatIdsRef = useRef(selectedSeatIds);
  useEffect(() => { selectedSeatIdsRef.current = selectedSeatIds; }, [selectedSeatIds]);

  // Area drag — set while the user drags an area's boundary rect.
  // `delta` is updated live so we can translate the visual ghost during
  // the drag; on mouseup we PATCH the area + bulk-shift its seats.
  //
  // Why two refs + one state: the document listeners are bound once
  // and read live data via refs (no re-binding); React state is just
  // for rendering the ghost translation.
  const [areaDrag, setAreaDrag] = useState<{
    areaId: string;
    delta: { dx: number; dy: number };
  } | null>(null);
  const areaDragRef = useRef<{
    areaId: string;
    startSvg: { x: number; y: number };
  } | null>(null);
  const areaDragDeltaRef = useRef<{ dx: number; dy: number }>({ dx: 0, dy: 0 });

  const svgRef = useRef<SVGSVGElement>(null);
  const queryClient = useQueryClient();

  // ── data fetching ──
  const { data: seats = [], isLoading: seatsLoading } = useQuery({
    queryKey: ['seats', eventId],
    queryFn: async () => {
      const result = await apiClient.getSeats(eventId);
      return ((result as any).data || result) as Seat[];
    },
  });

  const { data: attendees = [] } = useQuery({
    queryKey: ['attendees', eventId],
    queryFn: async () => {
      const result = await apiClient.getAttendees(eventId);
      return ((result as any).data || result) as Attendee[];
    },
  });

  const { data: areas = [] } = useQuery({
    queryKey: ['areas', eventId],
    queryFn: () => apiClient.getAreas(eventId),
  });

  // ── mutations ──
  // Refs so mutation callbacks can call latest version
  const centerViewRef = useRef<() => void>(() => {});
  const fitAllRef = useRef<() => void>(() => {});

  const createLayoutMutation = useMutation({
    mutationFn: () =>
      apiClient.createSeatLayout(eventId, {
        layout_type: layoutType,
        rows,
        cols,
        table_size: tableSize,
      }),
    onSuccess: async () => {
      // Sync rows/cols back to event model
      await apiClient.updateEvent(eventId, {
        venue_rows: rows,
        venue_cols: cols,
        layout_type: layoutType,
      });
      await queryClient.invalidateQueries({ queryKey: ['seats', eventId] });
      queryClient.invalidateQueries({ queryKey: ['event', eventId] });
      queryClient.invalidateQueries({ queryKey: ['dashboard', eventId] });
      queryClient.invalidateQueries({ queryKey: ['areas', eventId] });
      // Auto-fit: scale zoom so all seats visible (better for large layouts)
      setTimeout(() => fitAllRef.current(), 100);
    },
  });

  const autoAssignMutation = useMutation({
    mutationFn: () => apiClient.autoAssignSeats(eventId, strategy),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['seats', eventId] });
      queryClient.invalidateQueries({ queryKey: ['dashboard', eventId] });
    },
  });

  const bulkUpdateMutation = useMutation({
    mutationFn: (params: { seat_ids: string[]; zone?: string | null }) =>
      apiClient.bulkUpdateSeats(eventId, params),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['seats', eventId] });
    },
  });

  const assignSeatMutation = useMutation({
    mutationFn: (params: { seatId: string; attendeeId: string }) =>
      apiClient.assignSeat(eventId, params.seatId, params.attendeeId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['seats', eventId] });
      queryClient.invalidateQueries({ queryKey: ['dashboard', eventId] });
      setShowAssignPicker(false);
      setAssignSearch('');
    },
  });

  const unassignSeatMutation = useMutation({
    mutationFn: (seatId: string) =>
      apiClient.updateSeat(eventId, seatId, { attendee_id: null }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['seats', eventId] });
      queryClient.invalidateQueries({ queryKey: ['dashboard', eventId] });
    },
  });

  const suggestZonesMutation = useMutation({
    mutationFn: () => apiClient.suggestZones(eventId),
    onSuccess: async (data: any) => {
      const zones = data.zones as ZoneSuggestion[];
      for (const zone of zones) {
        const ids = (seats as Seat[])
          .filter((s) => zone.rows.includes(s.row_num))
          .map((s) => s.id);
        if (ids.length > 0) {
          await apiClient.bulkUpdateSeats(eventId, {
            seat_ids: ids,
            zone: zone.zone,
          });
        }
      }
      queryClient.invalidateQueries({ queryKey: ['seats', eventId] });
    },
  });

  // ── area mutations ──
  const createAreaMutation = useMutation({
    mutationFn: async () => {
      // Stack new areas below existing seats so they don't pile up at
      // (0,0) and overlap. Picks the largest pos_y of every current seat,
      // pads a gap, and uses that as offset_y. Existing areas with their
      // own offset still get respected because seat pos already includes
      // their offset.
      const existing = seats as Seat[];
      let offsetY = 0;
      if (existing.length > 0) {
        const maxY = Math.max(
          ...existing.map((s) => s.pos_y ?? (s.row_num - 1) * 60),
        );
        offsetY = maxY + 200;
      }
      const area = await apiClient.createArea(eventId, {
        name: newAreaName,
        layout_type: newAreaLayout,
        rows: newAreaRows,
        cols: newAreaCols,
        offset_y: offsetY,
        stage_label: newAreaStage || null,
      });
      // Auto-generate layout for this area
      await apiClient.generateAreaLayout(eventId, area.id);
      return area;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['areas', eventId] });
      queryClient.invalidateQueries({ queryKey: ['seats', eventId] });
      setNewAreaName('');
      setNewAreaStage('');
    },
  });

  // Bulk delete — for drag-select → 删除 UX.
  const bulkDeleteMutation = useMutation({
    mutationFn: (seatIds: string[]) =>
      apiClient.bulkDeleteSeats(eventId, seatIds),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['seats', eventId] });
      setSelectedSeatIds(new Set());
    },
  });

  // Area drag → shift all seats in the area by (dx, dy) + update the
  // area's stored offset so subsequent layout-regenerations land in the
  // new position.
  const areaShiftMutation = useMutation({
    mutationFn: async ({
      areaId, dx, dy,
    }: { areaId: string; dx: number; dy: number }) => {
      if (dx === 0 && dy === 0) return;
      const seatIds = (seats as Seat[])
        .filter((s) => s.area_id === areaId)
        .map((s) => s.id);
      if (seatIds.length > 0) {
        await apiClient.bulkUpdateSeats(eventId, {
          seat_ids: seatIds,
          pos_dx: dx,
          pos_dy: dy,
        });
      }
      const area = (areas as VenueArea[]).find((a) => a.id === areaId);
      if (area) {
        await apiClient.updateArea(eventId, areaId, {
          offset_x: (area.offset_x ?? 0) + dx,
          offset_y: (area.offset_y ?? 0) + dy,
        });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['seats', eventId] });
      queryClient.invalidateQueries({ queryKey: ['areas', eventId] });
    },
  });

  const deleteAreaMutation = useMutation({
    mutationFn: (areaId: string) => apiClient.deleteArea(eventId, areaId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['areas', eventId] });
      queryClient.invalidateQueries({ queryKey: ['seats', eventId] });
    },
  });

  const regenAreaMutation = useMutation({
    mutationFn: (areaId: string) => apiClient.generateAreaLayout(eventId, areaId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['seats', eventId] });
    },
  });

  // ── lookups ──
  const attendeeMap = useMemo(() => {
    const map = new Map<string, Attendee>();
    (attendees as Attendee[]).forEach((a) => map.set(a.id, a));
    return map;
  }, [attendees]);

  // Dynamic zone palette: derive from attendee roles (+ "普通区" fallback)
  const zonePalette = useMemo(() => {
    const roleSet = new Set<string>();
    (attendees as Attendee[]).forEach((a) => {
      if (a.role && a.role !== '参会者') roleSet.add(a.role);
    });
    const roles = Array.from(roleSet);
    // Build zone entries: "{role}区" with rotating colors
    const zones = roles.map((r, i) => ({
      name: r.endsWith('区') ? r : `${r}区`,
      color: ZONE_COLORS[i % ZONE_COLORS.length],
    }));
    // Always include "普通区" at the end
    if (!zones.some((z) => z.name === '普通区')) {
      zones.push({ name: '普通区', color: '#6b7280' });
    }
    return zones;
  }, [attendees]);

  // Sync paintZone to first palette entry when palette changes
  useEffect(() => {
    if (zonePalette.length > 0 && !zonePalette.some((z) => z.name === paintZone)) {
      setPaintZone(zonePalette[0].name);
    }
  }, [zonePalette, paintZone]);

  const zoneColorMap = useMemo(() => {
    const map = new Map<string, string>();
    // First, map from palette
    zonePalette.forEach((z) => map.set(z.name, z.color));
    // Also map any existing seat zones not in the palette
    (seats as Seat[]).forEach((s) => {
      if (s.zone && !map.has(s.zone)) {
        map.set(s.zone, ZONE_COLORS[map.size % ZONE_COLORS.length]);
      }
    });
    return map;
  }, [seats, zonePalette]);

  const activeZones = useMemo(() => {
    const zones = new Map<string, number>();
    (seats as Seat[]).forEach((s) => {
      if (s.zone) zones.set(s.zone, (zones.get(s.zone) || 0) + 1);
    });
    return Array.from(zones.entries()).map(([name, count]) => ({
      name,
      count,
      color: zoneColorMap.get(name) || '#6b7280',
    }));
  }, [seats, zoneColorMap]);

  // Area lookup map
  const areaMap = useMemo(() => {
    const map = new Map<string, VenueArea>();
    (areas as VenueArea[]).forEach((a) => map.set(a.id, a));
    return map;
  }, [areas]);

  // Per-area bounding boxes (for labels + boundary rects)
  const areaBounds = useMemo(() => {
    const typed = seats as Seat[];
    const map = new Map<string, { minX: number; minY: number; maxX: number; maxY: number; area: VenueArea }>();
    for (const s of typed) {
      if (!s.area_id) continue;
      const area = areaMap.get(s.area_id);
      if (!area) continue;
      const x = s.pos_x ?? (s.col_num - 1) * 60;
      const y = s.pos_y ?? (s.row_num - 1) * 60;
      const existing = map.get(s.area_id);
      if (existing) {
        existing.minX = Math.min(existing.minX, x);
        existing.minY = Math.min(existing.minY, y);
        existing.maxX = Math.max(existing.maxX, x);
        existing.maxY = Math.max(existing.maxY, y);
      } else {
        map.set(s.area_id, { minX: x, minY: y, maxX: x, maxY: y, area });
      }
    }
    return map;
  }, [seats, areaMap]);

  // ── derived values ──
  const hasSeats = (seats as Seat[]).length > 0;
  const assignedCount = (seats as Seat[]).filter((s) => s.attendee_id).length;
  const totalSeats = (seats as Seat[]).length;
  // Attendees already seated
  const seatedIds = useMemo(() => {
    const set = new Set<string>();
    (seats as Seat[]).forEach((s) => {
      if (s.attendee_id) set.add(s.attendee_id);
    });
    return set;
  }, [seats]);
  const unassignedAttendees = useMemo(() =>
    (attendees as Attendee[]).filter(
      (a) => a.status !== 'cancelled' && !seatedIds.has(a.id),
    ),
  [attendees, seatedIds]);
  const totalAttendees = (attendees as Attendee[]).filter(
    (a) => a.status !== 'cancelled',
  ).length;

  // Filtered attendee list for assign picker
  const filteredUnassigned = useMemo(() => {
    if (!assignSearch.trim()) return unassignedAttendees.slice(0, 20);
    const q = assignSearch.toLowerCase();
    return unassignedAttendees
      .filter(
        (a) =>
          a.name.toLowerCase().includes(q) ||
          (a.role || '').toLowerCase().includes(q) ||
          (a.department || '').toLowerCase().includes(q),
      )
      .slice(0, 20);
  }, [unassignedAttendees, assignSearch]);

  // Compute SVG viewBox from seat positions
  const bounds = useMemo(() => {
    const typed = seats as Seat[];
    if (typed.length === 0) return { minX: 0, minY: 0, maxX: 600, maxY: 400 };
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of typed) {
      const x = s.pos_x ?? (s.col_num - 1) * 60;
      const y = s.pos_y ?? (s.row_num - 1) * 60;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    return {
      minX: minX - 40,
      minY: minY - 60,
      maxX: maxX + 40,
      maxY: maxY + 40,
    };
  }, [seats]);

  // ── SVG coordinate helpers ──
  // Use refs so native event handlers always see the latest zoom/pan
  const svgPoint = useCallback(
    (clientX: number, clientY: number) => {
      if (!svgRef.current) return { x: 0, y: 0 };
      const rect = svgRef.current.getBoundingClientRect();
      const z = zoomRef.current;
      const p = panRef.current;
      const x = (clientX - rect.left) / z - p.x;
      const y = (clientY - rect.top) / z - p.y;
      return { x, y };
    },
    [],
  );

  // Refs for values used in document-level listeners (avoids stale closures)
  const isPanningRef = useRef(false);
  const toolModeRef = useRef(toolMode);
  const paintModeRef = useRef(paintMode);
  const paintZoneRef = useRef(paintZone);
  const seatsRef = useRef(seats);
  const selRectRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  useEffect(() => { toolModeRef.current = toolMode; }, [toolMode]);
  useEffect(() => { paintModeRef.current = paintMode; }, [paintMode]);
  useEffect(() => { paintZoneRef.current = paintZone; }, [paintZone]);
  useEffect(() => { seatsRef.current = seats; }, [seats]);
  // Stable refs for mutate so document listeners don't depend on mutation object
  const bulkMutateRef = useRef(bulkUpdateMutation.mutate);
  useEffect(() => { bulkMutateRef.current = bulkUpdateMutation.mutate; }, [bulkUpdateMutation.mutate]);
  const areaShiftMutateRef = useRef(areaShiftMutation.mutate);
  useEffect(() => {
    areaShiftMutateRef.current = areaShiftMutation.mutate;
  }, [areaShiftMutation.mutate]);

  // Helper: find seats in a selection rect
  const findSeatsInRect = useCallback(
    (rect: { x: number; y: number; w: number; h: number }) => {
      return (seatsRef.current as Seat[]).filter((s) => {
        if (s.seat_type === 'disabled' || s.seat_type === 'aisle') return false;
        const sx = s.pos_x ?? (s.col_num - 1) * 60;
        const sy = s.pos_y ?? (s.row_num - 1) * 60;
        return (
          sx >= rect.x &&
          sx <= rect.x + rect.w &&
          sy >= rect.y &&
          sy <= rect.y + rect.h
        );
      });
    },
    [],
  );

  // ── pan / drag handlers (document-level for reliability) ──
  const handleMouseDown = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      // Middle / right click → always pan
      if (e.button === 1 || e.button === 2) {
        e.preventDefault();
        isPanningRef.current = true;
        setIsPanning(true);
        panStart.current = {
          x: e.clientX, y: e.clientY,
          px: panRef.current.x, py: panRef.current.y,
        };
        return;
      }
      if (toolModeRef.current === 'pan') {
        isPanningRef.current = true;
        setIsPanning(true);
        panStart.current = {
          x: e.clientX, y: e.clientY,
          px: panRef.current.x, py: panRef.current.y,
        };
        return;
      }
      // Drag-select: starts both in paint mode (bulk zone painting on
      // mouseup) AND in plain 'select' mode (populates selectedSeatIds
      // for the floating "删除/清除" action bar).
      if (paintModeRef.current || toolModeRef.current === 'select') {
        const pt = svgPoint(e.clientX, e.clientY);
        selStart.current = pt;
        const initRect = { x: pt.x, y: pt.y, w: 0, h: 0 };
        selRectRef.current = initRect;
        setSelRect(initRect);
      }
    },
    [svgPoint],
  );

  // Area-boundary mousedown: starts area drag. Document-level listeners
  // handle move + up. Stops propagation so the SVG-level handler doesn't
  // also start a pan / drag-select.
  const handleAreaMouseDown = useCallback(
    (areaId: string, e: React.MouseEvent) => {
      // Only left-click; middle/right still pan via SVG handler
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      const start = svgPoint(e.clientX, e.clientY);
      areaDragRef.current = { areaId, startSvg: start };
      setAreaDrag({ areaId, delta: { dx: 0, dy: 0 } });
    },
    [svgPoint],
  );

  // Document-level move / up so drag continues outside SVG.
  // All state is read via refs — zero dependency on React state objects,
  // so this effect registers listeners exactly once.
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (isPanningRef.current) {
        const z = zoomRef.current;
        const dx = (e.clientX - panStart.current.x) / z;
        const dy = (e.clientY - panStart.current.y) / z;
        setPan({ x: panStart.current.px + dx, y: panStart.current.py + dy });
        return;
      }
      // Area dragging — visual only; mouseup persists.
      if (areaDragRef.current) {
        const cur = svgPoint(e.clientX, e.clientY);
        const dx = cur.x - areaDragRef.current.startSvg.x;
        const dy = cur.y - areaDragRef.current.startSvg.y;
        areaDragDeltaRef.current = { dx, dy };
        setAreaDrag({ areaId: areaDragRef.current.areaId, delta: { dx, dy } });
        return;
      }
      if (selStart.current) {
        const pt = svgPoint(e.clientX, e.clientY);
        const sx = selStart.current.x;
        const sy = selStart.current.y;
        const newRect = {
          x: Math.min(sx, pt.x),
          y: Math.min(sy, pt.y),
          w: Math.abs(pt.x - sx),
          h: Math.abs(pt.y - sy),
        };
        selRectRef.current = newRect;
        setSelRect(newRect);
      }
    };

    const onUp = () => {
      if (isPanningRef.current) {
        isPanningRef.current = false;
        setIsPanning(false);
        return;
      }
      // Area drag landed — commit shift if non-trivial.
      if (areaDragRef.current) {
        const { areaId } = areaDragRef.current;
        const { dx, dy } = areaDragDeltaRef.current;
        areaDragRef.current = null;
        areaDragDeltaRef.current = { dx: 0, dy: 0 };
        setAreaDrag(null);
        if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
          areaShiftMutateRef.current({ areaId, dx, dy });
        }
        return;
      }
      if (selStart.current) {
        // Read final rect from ref (not from React state — avoids stale closure)
        const finalRect = selRectRef.current;
        if (finalRect && (finalRect.w > 3 || finalRect.h > 3)) {
          const selected = findSeatsInRect(finalRect);
          if (selected.length > 0) {
            if (paintModeRef.current) {
              // Paint mode → bulk paint zone
              bulkMutateRef.current({
                seat_ids: selected.map((s) => s.id),
                zone: paintZoneRef.current || null,
              });
            } else if (toolModeRef.current === 'select') {
              // Select mode → add to multi-select set (replaces existing)
              setSelectedSeatIds(new Set(selected.map((s) => s.id)));
            }
          }
        }
        // Clean up
        selStart.current = null;
        selRectRef.current = null;
        setSelRect(null);
      }
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    // All live state read via refs; only svgPoint / setPan / findSeatsInRect
    // are deps. Effect attaches the listeners exactly once.
  }, [svgPoint, setPan, findSeatsInRect]);

  // ── Zoom: native wheel listener (non-passive) + zoom toward cursor ──
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const rect = svg.getBoundingClientRect();
      // Mouse position in screen coords relative to SVG element
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      // Normalize: mice send ±120 per notch, trackpads send smaller values
      const normalized =
        Math.sign(e.deltaY) * Math.min(Math.abs(e.deltaY) / 120, 1);
      const factor = 1 - normalized * ZOOM_STEP;

      const oldZ = zoomRef.current;
      const newZ = Math.max(
        MIN_ZOOM,
        Math.min(MAX_ZOOM, Math.round(oldZ * factor * 100) / 100),
      );
      if (newZ === oldZ) return;

      // Zoom toward cursor: adjust pan so the point under the cursor stays fixed
      // Before: screenPt = (svgPt + pan) * oldZ => svgPt = screenPt/oldZ - pan
      // After:  (svgPt + newPan) * newZ = screenPt
      //   => newPan = screenPt / newZ - svgPt = screenPt / newZ - (screenPt / oldZ - pan)
      const p = panRef.current;
      const newPanX = mx / newZ - (mx / oldZ - p.x);
      const newPanY = my / newZ - (my / oldZ - p.y);

      // Batch updates
      zoomRef.current = newZ;
      panRef.current = { x: newPanX, y: newPanY };
      _setZoom(newZ);
      _setPan({ x: newPanX, y: newPanY });
    };
    const prevent = (e: Event) => e.preventDefault();
    svg.addEventListener('wheel', onWheel, { passive: false });
    svg.addEventListener('contextmenu', prevent);
    return () => {
      svg.removeEventListener('wheel', onWheel);
      svg.removeEventListener('contextmenu', prevent);
    };
  }, []);

  // ── seat click ──
  const handleSeatClick = (seat: Seat, e: React.MouseEvent) => {
    e.stopPropagation();
    if (seat.seat_type === 'disabled' || seat.seat_type === 'aisle') return;
    if (paintMode) {
      bulkUpdateMutation.mutate({
        seat_ids: [seat.id],
        zone: paintZone || null,
      });
      return;
    }
    if (selectedSeat?.id === seat.id) {
      setSelectedSeat(null);
      setShowAssignPicker(false);
    } else {
      setSelectedSeat(seat);
      setShowAssignPicker(false);
    }
  };

  // ── render SVG ──
  const renderSVGCanvas = () => {
    if (!hasSeats) return null;

    return (
      <svg
        ref={svgRef}
        className="w-full h-full bg-gray-50"
        style={{
          cursor: isPanning
            ? 'grabbing'
            : toolMode === 'pan'
              ? 'grab'
              : paintMode
                ? 'crosshair'
                : 'default',
        }}
        onMouseDown={handleMouseDown}
      >
        <g transform={`scale(${zoom}) translate(${pan.x}, ${pan.y})`}>
          {/* Global stage bar (only when no areas have stage_labels) */}
          {(areas as VenueArea[]).every((a) => !a.stage_label) && (
            <>
              <rect
                x={bounds.minX}
                y={bounds.minY - 10}
                width={bounds.maxX - bounds.minX}
                height={24}
                rx={4}
                fill="#1f2937"
              />
              <text
                x={(bounds.minX + bounds.maxX) / 2}
                y={bounds.minY + 6}
                textAnchor="middle"
                fill="white"
                fontSize={11}
                fontWeight="500"
              >
                讲台 / 前方
              </text>
            </>
          )}

          {/* Area boundaries, labels, and per-area stage labels */}
          {Array.from(areaBounds.entries()).map(([areaId, ab]) => {
            const pad = 28;
            const rx = ab.minX - pad;
            const ry = ab.minY - pad - 16;
            const rw = ab.maxX - ab.minX + pad * 2;
            const rh = ab.maxY - ab.minY + pad * 2 + 16;
            const dragging = areaDrag?.areaId === areaId;
            const tx = dragging ? areaDrag.delta.dx : 0;
            const ty = dragging ? areaDrag.delta.dy : 0;
            return (
              <g
                key={`area-${areaId}`}
                transform={dragging ? `translate(${tx}, ${ty})` : undefined}
                style={{ opacity: dragging ? 0.7 : 1 }}
              >
                {/* Area boundary — also the drag handle. Pointer-events
                    `stroke` means clicks on the dashed border start a drag,
                    but clicks INSIDE the rect fall through to seats below. */}
                <rect
                  x={rx} y={ry} width={rw} height={rh}
                  rx={6} fill="transparent"
                  stroke="#cbd5e1" strokeWidth={6}
                  strokeDasharray="8,4"
                  style={{ cursor: 'move', pointerEvents: 'stroke' }}
                  onMouseDown={(e) => handleAreaMouseDown(areaId, e)}
                />
                {/* Area name label — also draggable */}
                <text
                  x={rx + 6} y={ry + 12}
                  fontSize={11} fontWeight="600"
                  fill="#64748b"
                  style={{ cursor: 'move', userSelect: 'none' }}
                  onMouseDown={(e) => handleAreaMouseDown(areaId, e)}
                >
                  {ab.area.name}
                </text>
                {/* Per-area stage/backdrop label */}
                {ab.area.stage_label && (
                  <>
                    <rect
                      x={rx + 2}
                      y={ab.minY - pad - 12}
                      width={rw - 4}
                      height={20}
                      rx={3}
                      fill="#334155"
                    />
                    <text
                      x={rx + rw / 2}
                      y={ab.minY - pad + 2}
                      textAnchor="middle"
                      fill="white"
                      fontSize={10}
                      fontWeight="500"
                    >
                      {ab.area.stage_label}
                    </text>
                  </>
                )}
              </g>
            );
          })}

          {/* Aisle indicators (visible walkway gaps) */}
          {(seats as Seat[]).filter((s) => s.seat_type === 'aisle').map((seat) => {
            const x = seat.pos_x ?? (seat.col_num - 1) * 60;
            const y = seat.pos_y ?? (seat.row_num - 1) * 60;
            return (
              <g key={`aisle-${seat.id}`}>
                <line
                  x1={x} y1={y - SEAT_H / 2 - 4}
                  x2={x} y2={y + SEAT_H / 2 + 4}
                  stroke="#e2e8f0" strokeWidth={1}
                  strokeDasharray="3,3"
                />
              </g>
            );
          })}

          {/* Seats */}
          {(seats as Seat[]).map((seat) => {
            let x = seat.pos_x ?? (seat.col_num - 1) * 60;
            let y = seat.pos_y ?? (seat.row_num - 1) * 60;
            // Follow the in-flight area drag: seats in the dragging area
            // visually translate by the same delta as the boundary rect.
            if (areaDrag && seat.area_id === areaDrag.areaId) {
              x += areaDrag.delta.dx;
              y += areaDrag.delta.dy;
            }
            if (seat.seat_type === 'aisle') return null;
            const att = seat.attendee_id
              ? attendeeMap.get(seat.attendee_id)
              : undefined;
            const fill = getSeatFill(seat, att, zoneColorMap);
            const stroke = getSeatStroke(seat, att, zoneColorMap);
            const isSelected =
              selectedSeat?.id === seat.id || selectedSeatIds.has(seat.id);
            const rotation = seat.rotation || 0;
            const displayLabel = seat.attendee_id
              ? (att?.name?.slice(0, 3) || '✓')
              : (seat.label || '');

            return (
              <g
                key={seat.id}
                transform={`translate(${x}, ${y}) rotate(${rotation})`}
                onClick={(e) => handleSeatClick(seat, e)}
                style={{ cursor: paintMode ? 'crosshair' : 'pointer' }}
              >
                {/* Chair back — drawn first so it sits behind the seat */}
                <rect
                  x={-SEAT_W / 2 + 2}
                  y={SEAT_H / 2 - 2}
                  width={SEAT_W - 4}
                  height={BACK_H}
                  rx={3}
                  ry={3}
                  fill={isSelected ? '#4f46e5' : stroke}
                  opacity={0.6}
                />
                {/* Main seat body (on top of back) */}
                <rect
                  x={-SEAT_W / 2}
                  y={-SEAT_H / 2}
                  width={SEAT_W}
                  height={SEAT_H}
                  rx={SEAT_RX}
                  ry={SEAT_RX}
                  fill={fill}
                  stroke={isSelected ? '#4f46e5' : stroke}
                  strokeWidth={isSelected ? 2.5 : 1.5}
                />
                {isSelected && (
                  <rect
                    x={-(SEAT_W / 2 + SEL_PAD)}
                    y={-(SEAT_H / 2 + SEL_PAD)}
                    width={SEAT_W + SEL_PAD * 2}
                    height={SEAT_H + SEL_PAD * 2}
                    rx={SEAT_RX + 2}
                    ry={SEAT_RX + 2}
                    fill="none"
                    stroke="#4f46e5"
                    strokeWidth={1.5}
                    strokeDasharray="4,3"
                  />
                )}
                <text
                  textAnchor="middle"
                  dominantBaseline="central"
                  fontSize={12}
                  fontWeight="600"
                  fill="#374151"
                  transform={`rotate(${-rotation})`}
                  style={{ pointerEvents: 'none', userSelect: 'none' }}
                >
                  {displayLabel.length > 4
                    ? displayLabel.slice(0, 4)
                    : displayLabel}
                </text>
                <title>
                  {seat.label}
                  {seat.zone ? ` [${seat.zone}]` : ''}
                  {att ? ` - ${att.name} (P${att.priority})` : ''}
                </title>
              </g>
            );
          })}

          {/* Drag selection rectangle */}
          {selRect && selRect.w > 2 && (
            <rect
              x={selRect.x}
              y={selRect.y}
              width={selRect.w}
              height={selRect.h}
              fill="rgba(79,70,229,0.12)"
              stroke="#4f46e5"
              strokeWidth={1}
              strokeDasharray="6,3"
              pointerEvents="none"
            />
          )}
        </g>
      </svg>
    );
  };

  // ── Fit all: reset zoom/pan so all seats are visible ──
  const fitAll = useCallback(() => {
    if (!svgRef.current) return;
    const svg = svgRef.current;
    const rect = svg.getBoundingClientRect();
    const svgW = rect.width;
    const svgH = rect.height;
    const contentW = bounds.maxX - bounds.minX + 80;
    const contentH = bounds.maxY - bounds.minY + 80;
    if (contentW <= 0 || contentH <= 0) return;
    const fitZoom = Math.min(svgW / contentW, svgH / contentH, MAX_ZOOM) * 0.9;
    const clamped = Math.max(MIN_ZOOM, Math.round(fitZoom * 100) / 100);
    const fitPanX = (svgW / clamped - contentW) / 2 - bounds.minX + 40;
    const fitPanY = (svgH / clamped - contentH) / 2 - bounds.minY + 40;
    setZoom(clamped);
    setPan({ x: fitPanX, y: fitPanY });
  }, [bounds, setZoom, setPan]);

  // Center view at 100% zoom (used after layout generation)
  const centerView = useCallback(() => {
    if (!svgRef.current) return;
    const svg = svgRef.current;
    const rect = svg.getBoundingClientRect();
    const svgW = rect.width;
    const svgH = rect.height;
    const contentW = bounds.maxX - bounds.minX + 80;
    const contentH = bounds.maxY - bounds.minY + 80;
    if (contentW <= 0 || contentH <= 0) return;
    // 100% zoom, centered on content
    const panX = (svgW - contentW) / 2 - bounds.minX + 40;
    const panY = (svgH - contentH) / 2 - bounds.minY + 40;
    setZoom(1);
    setPan({ x: panX, y: panY });
  }, [bounds, setZoom, setPan]);

  useEffect(() => { centerViewRef.current = centerView; }, [centerView]);
  useEffect(() => { fitAllRef.current = fitAll; }, [fitAll]);

  // ── Selected seat detail panel with assign/unassign + zone picker ──
  const renderSeatDetail = () => {
    if (!selectedSeat) return null;
    const att = selectedSeat.attendee_id
      ? attendeeMap.get(selectedSeat.attendee_id)
      : undefined;

    return (
      <div className="bg-white rounded-lg shadow px-4 py-3">
        <div className="flex items-center justify-between mb-2">
          <h4 className="text-sm font-semibold text-gray-900">
            {selectedSeat.label}
          </h4>
          <button
            onClick={() => { setSelectedSeat(null); setShowAssignPicker(false); }}
            className="p-1 hover:bg-gray-100 rounded"
          >
            <X size={14} className="text-gray-400" />
          </button>
        </div>

        {/* Info row */}
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-600 mb-3">
          <span>类型: <strong>{selectedSeat.seat_type}</strong></span>
          <span>入座: <strong>{att ? `${att.name} (P${att.priority})` : '空座'}</strong></span>
        </div>

        {/* Zone picker — always visible for single seat */}
        <div className="mb-3">
          <div className="text-xs text-gray-500 mb-1.5">分区：</div>
          <div className="flex flex-wrap items-center gap-1.5">
            {zonePalette.map((z) => (
              <button
                key={z.name}
                onClick={() => {
                  bulkUpdateMutation.mutate({
                    seat_ids: [selectedSeat.id],
                    zone: z.name,
                  });
                  setSelectedSeat({ ...selectedSeat, zone: z.name });
                }}
                className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border-2 transition-all ${
                  selectedSeat.zone === z.name
                    ? 'ring-2 ring-offset-1 ring-indigo-500 scale-105'
                    : ''
                }`}
                style={{
                  backgroundColor: `${z.color}22`,
                  borderColor: z.color,
                  color: z.color,
                }}
              >
                <span className="w-2 h-2 rounded-full" style={{ backgroundColor: z.color }} />
                {z.name}
              </button>
            ))}
            <button
              onClick={() => {
                bulkUpdateMutation.mutate({
                  seat_ids: [selectedSeat.id],
                  zone: null,
                });
                setSelectedSeat({ ...selectedSeat, zone: null });
              }}
              className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border-2 border-gray-300 text-gray-500 ${
                !selectedSeat.zone ? 'ring-2 ring-offset-1 ring-indigo-500' : ''
              }`}
            >
              <span className="w-2 h-2 rounded-full bg-gray-300" />
              无
            </button>
          </div>
        </div>

        {/* Assign / Unassign actions */}
        <div className="border-t pt-2">
          {selectedSeat.attendee_id && att ? (
            <div className="flex items-center justify-between">
              <span className="text-xs text-gray-600">
                入座：<strong>{att.name}</strong>
                <span className="text-gray-400 ml-1">({att.role})</span>
              </span>
              <button
                onClick={() => unassignSeatMutation.mutate(selectedSeat.id)}
                disabled={unassignSeatMutation.isPending}
                className="flex items-center gap-1 px-2 py-1 text-red-600 border border-red-200 rounded text-[11px] hover:bg-red-50 disabled:opacity-50"
              >
                <XCircle size={12} />
                取消
              </button>
            </div>
          ) : (
            <div>
              {!showAssignPicker ? (
                <button
                  onClick={() => setShowAssignPicker(true)}
                  disabled={unassignedAttendees.length === 0}
                  className="flex items-center gap-1.5 px-2.5 py-1 bg-indigo-600 text-white rounded text-xs hover:bg-indigo-700 disabled:opacity-50"
                >
                  <UserPlus size={13} />
                  {unassignedAttendees.length === 0
                    ? '无待分配参会者'
                    : '指定入座人'}
                </button>
              ) : (
                <div className="space-y-2">
                  <input
                    type="text"
                    value={assignSearch}
                    onChange={(e) => setAssignSearch(e.target.value)}
                    placeholder="搜索姓名、角色、部门..."
                    className="w-full px-2.5 py-1 border border-gray-300 rounded text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    autoFocus
                  />
                  <div className="max-h-32 overflow-y-auto border border-gray-200 rounded divide-y">
                    {filteredUnassigned.length === 0 ? (
                      <div className="px-3 py-2 text-xs text-gray-400">无匹配</div>
                    ) : (
                      filteredUnassigned.map((a) => (
                        <button
                          key={a.id}
                          onClick={() =>
                            assignSeatMutation.mutate({
                              seatId: selectedSeat.id,
                              attendeeId: a.id,
                            })
                          }
                          disabled={assignSeatMutation.isPending}
                          className="w-full flex items-center justify-between px-2.5 py-1.5 hover:bg-indigo-50 transition-colors disabled:opacity-50"
                        >
                          <div className="text-left">
                            <span className="text-xs font-medium text-gray-900">{a.name}</span>
                            <span className="text-[10px] text-gray-500 ml-1.5">
                              {a.role} · P{a.priority}
                              {a.department ? ` · ${a.department}` : ''}
                            </span>
                          </div>
                          <UserPlus size={11} className="text-indigo-400" />
                        </button>
                      ))
                    )}
                  </div>
                  <button
                    onClick={() => { setShowAssignPicker(false); setAssignSearch(''); }}
                    className="text-xs text-gray-500 hover:text-gray-700"
                  >
                    取消
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    );
  };

  // Zone action helper for both paint-palette and drag-select bar
  const renderZoneButtons = (
    onSelect: (zone: string | null) => void,
    size: 'sm' | 'md' = 'md',
  ) => (
    <div className="flex flex-wrap items-center gap-1.5">
      {zonePalette.map((z) => (
        <button
          key={z.name}
          onClick={() => onSelect(z.name)}
          className={`flex items-center gap-1 rounded-full font-medium border-2 transition-all ${
            paintMode && paintZone === z.name
              ? 'ring-2 ring-offset-1 ring-indigo-500 scale-105'
              : ''
          } ${size === 'sm' ? 'px-2 py-0.5 text-[11px]' : 'px-2.5 py-1 text-xs'}`}
          style={{
            backgroundColor: `${z.color}22`,
            borderColor: z.color,
            color: z.color,
          }}
        >
          <span
            className={`rounded-full ${size === 'sm' ? 'w-2 h-2' : 'w-2.5 h-2.5'}`}
            style={{ backgroundColor: z.color }}
          />
          {z.name}
        </button>
      ))}
      <button
        onClick={() => onSelect(null)}
        className={`flex items-center gap-1 rounded-full font-medium border-2 border-gray-300 text-gray-500 ${
          paintMode && paintZone === ''
            ? 'ring-2 ring-offset-1 ring-indigo-500'
            : ''
        } ${size === 'sm' ? 'px-2 py-0.5 text-[11px]' : 'px-2.5 py-1 text-xs'}`}
      >
        <span className={`rounded-full bg-gray-300 ${size === 'sm' ? 'w-2 h-2' : 'w-2.5 h-2.5'}`} />
        清除
      </button>
    </div>
  );

  return (
    <div className="flex gap-4 h-full overflow-hidden">
      {/* ═══ Left: Canvas + Controls ═══ */}
      <div className="flex-1 flex flex-col min-w-0 gap-3 overflow-hidden">

        {/* Toolbar row 1: Layout + view controls */}
        <div className="bg-white rounded-lg shadow px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            {/* Layout type */}
            <select
              value={layoutType}
              onChange={(e) => setLayoutType(e.target.value)}
              className="px-2 py-1.5 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            >
              {LAYOUT_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>

            {/* Rows × Cols */}
            <div className="flex items-center gap-1 text-sm">
              <input
                type="number"
                min={1}
                max={50}
                value={rows}
                onChange={(e) => setRows(Number(e.target.value))}
                className="w-14 px-1.5 py-1.5 border border-gray-300 rounded text-center text-sm"
              />
              <span className="text-gray-400 text-xs">行</span>
              <span className="text-gray-300">×</span>
              <input
                type="number"
                min={1}
                max={50}
                value={cols}
                onChange={(e) => setCols(Number(e.target.value))}
                className="w-14 px-1.5 py-1.5 border border-gray-300 rounded text-center text-sm"
              />
              <span className="text-gray-400 text-xs">列</span>
            </div>

            {(layoutType === 'roundtable' || layoutType === 'banquet') && (
              <div className="flex items-center gap-1 text-sm">
                <input
                  type="number"
                  min={4}
                  max={16}
                  value={tableSize}
                  onChange={(e) => setTableSize(Number(e.target.value))}
                  className="w-14 px-1.5 py-1.5 border border-gray-300 rounded text-center text-sm"
                />
                <span className="text-gray-400 text-xs">人/桌</span>
              </div>
            )}

            <button
              onClick={() => createLayoutMutation.mutate()}
              disabled={
                createLayoutMutation.isPending ||
                rows <= 0 ||
                cols <= 0
              }
              className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 text-white rounded text-sm hover:bg-indigo-700 disabled:opacity-50"
            >
              <Grid3X3 size={15} />
              {createLayoutMutation.isPending
                ? '生成中...'
                : hasSeats
                  ? '重新生成'
                  : '生成座位'}
            </button>

            <span className="w-px h-6 bg-gray-200" />

            {/* Auto-assign */}
            <select
              value={strategy}
              onChange={(e) => setStrategy(e.target.value)}
              className="px-2 py-1.5 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            >
              <option value="random">随机</option>
              <option value="priority_first">优先级</option>
              <option value="by_department">按部门</option>
              <option value="by_zone">按分区</option>
            </select>
            <button
              onClick={() => autoAssignMutation.mutate()}
              disabled={autoAssignMutation.isPending || unassignedAttendees.length === 0}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-green-600 text-white rounded text-sm hover:bg-green-700 disabled:opacity-50"
            >
              <Shuffle size={15} />
              {autoAssignMutation.isPending ? '分配中...' : '排座'}
            </button>

            <span className="w-px h-6 bg-gray-200" />

            {/* Zone tools */}
            <button
              onClick={() => suggestZonesMutation.mutate()}
              disabled={suggestZonesMutation.isPending || !hasSeats}
              className="flex items-center gap-1 px-2.5 py-1.5 bg-amber-500 text-white rounded text-sm hover:bg-amber-600 disabled:opacity-50"
              title="AI 自动分区"
            >
              <Sparkles size={14} />
              AI分区
            </button>
            <button
              onClick={() => {
                const next = !paintMode;
                setPaintMode(next);
                setShowZonePanel(next);
                if (next) setToolMode('select');
              }}
              className={`flex items-center gap-1 px-2.5 py-1.5 rounded text-sm font-medium transition-colors ${
                paintMode
                  ? 'bg-indigo-600 text-white'
                  : 'border border-gray-300 text-gray-700 hover:bg-gray-50'
              }`}
            >
              <Paintbrush size={14} />
              {paintMode ? '退出涂色' : '涂色'}
            </button>
            <button
              onClick={() => setShowAreaPanel(!showAreaPanel)}
              className={`flex items-center gap-1 px-2.5 py-1.5 rounded text-sm font-medium transition-colors ${
                showAreaPanel
                  ? 'bg-purple-600 text-white'
                  : 'border border-gray-300 text-gray-700 hover:bg-gray-50'
              }`}
            >
              <Layers size={14} />
              区域{(areas as VenueArea[]).length > 0 ? ` (${(areas as VenueArea[]).length})` : ''}
            </button>

            {/* Stats (right-aligned) */}
            <div className="flex items-center gap-1 text-xs text-gray-500 ml-auto">
              <Users size={14} />
              {assignedCount}/{totalSeats}
              {totalAttendees > 0 && (
                <span> · 待{unassignedAttendees.length}人</span>
              )}
            </div>

            <a
              href={apiClient.getExportSeatmapUrl(eventId)}
              className="p-1.5 border border-gray-300 text-gray-500 rounded hover:bg-gray-50"
              title="导出"
            >
              <Download size={14} />
            </a>
          </div>

          {/* Paint mode: zone palette inline below toolbar */}
          {paintMode && showZonePanel && (
            <div className="mt-2 pt-2 border-t border-indigo-100 flex items-center gap-2">
              <span className="text-xs text-indigo-700 whitespace-nowrap">涂色分区：</span>
              {renderZoneButtons((z) => setPaintZone(z ?? ''), 'md')}
            </div>
          )}
        </div>

        {/* Toolbar row 2: View controls (zoom/pan/select) — sticky */}
        {hasSeats && (
          <div className="flex items-center gap-1.5 px-1">
            <button
              onClick={() => setToolMode('select')}
              className={`p-1.5 rounded ${
                toolMode === 'select'
                  ? 'bg-indigo-100 text-indigo-700'
                  : 'text-gray-400 hover:bg-gray-100'
              }`}
              title="选择 / 框选"
            >
              <MousePointer size={15} />
            </button>
            <button
              onClick={() => setToolMode('pan')}
              className={`p-1.5 rounded ${
                toolMode === 'pan'
                  ? 'bg-indigo-100 text-indigo-700'
                  : 'text-gray-400 hover:bg-gray-100'
              }`}
              title="拖拽平移"
            >
              <Move size={15} />
            </button>
            <button
              onClick={() => setZoom((z) => Math.min(MAX_ZOOM, z * 1.25))}
              className="p-1.5 rounded text-gray-400 hover:bg-gray-100"
              title="放大"
            >
              <ZoomIn size={15} />
            </button>
            <button
              onClick={() => setZoom((z) => Math.max(MIN_ZOOM, z * 0.8))}
              className="p-1.5 rounded text-gray-400 hover:bg-gray-100"
              title="缩小"
            >
              <ZoomOut size={15} />
            </button>
            <button
              onClick={() => {
                const isNear100 = Math.abs(zoom - 1) < 0.05;
                if (isNear100) {
                  fitAll();
                } else {
                  centerView();
                }
              }}
              className="p-1.5 rounded text-gray-400 hover:bg-gray-100"
              title={Math.abs(zoom - 1) < 0.05 ? '全览 — 缩放到全部可见' : '重置 — 回到100%居中'}
            >
              <Maximize size={15} />
            </button>
            <span className="text-[11px] text-gray-400 select-none">
              {Math.round(zoom * 100)}%
            </span>

            {/* Legend (inline) */}
            <div className="flex items-center gap-2 text-[11px] text-gray-500 ml-auto">
              <span className="flex items-center gap-0.5">
                <span className="w-2 h-2 rounded-full" style={{ backgroundColor: '#bbf7d0', border: '1px solid #22c55e' }} /> 已分配
              </span>
              <span className="flex items-center gap-0.5">
                <span className="w-2 h-2 rounded-full" style={{ backgroundColor: '#c4b5fd', border: '1px solid #7c3aed' }} /> 高优先
              </span>
              <span className="flex items-center gap-0.5">
                <span className="w-2 h-2 rounded-full" style={{ backgroundColor: '#dbeafe', border: '1px solid #93c5fd' }} /> 空座
              </span>
              {activeZones.map((z) => (
                <span key={z.name} className="flex items-center gap-0.5">
                  <span className="w-2 h-2 rounded-full" style={{ backgroundColor: `${z.color}33`, border: `1px solid ${z.color}` }} />
                  {z.name}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* ═══ Area Management Panel ═══ */}
        {showAreaPanel && (
          <div className="bg-white rounded-lg shadow px-4 py-3 text-sm space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="font-semibold text-gray-800 flex items-center gap-1.5">
                <Layers size={15} /> 区域管理
              </h4>
              <button onClick={() => setShowAreaPanel(false)} className="p-1 hover:bg-gray-100 rounded">
                <X size={14} className="text-gray-400" />
              </button>
            </div>

            {/* Existing areas */}
            {(areas as VenueArea[]).length > 0 && (
              <div className="space-y-1.5">
                {(areas as VenueArea[]).map((a) => (
                  <div key={a.id} className="flex items-center justify-between px-3 py-1.5 bg-gray-50 rounded">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-gray-700">{a.name}</span>
                      <span className="text-xs text-gray-400">
                        {a.layout_type} {a.rows}×{a.cols}
                        {a.stage_label && ` · ${a.stage_label}`}
                      </span>
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => regenAreaMutation.mutate(a.id)}
                        disabled={regenAreaMutation.isPending}
                        className="px-2 py-0.5 text-xs text-indigo-600 hover:bg-indigo-50 rounded"
                        title="重新生成该区域座位"
                      >
                        <Grid3X3 size={12} />
                      </button>
                      <button
                        onClick={() => { if (confirm(`确定删除 ${a.name}？`)) deleteAreaMutation.mutate(a.id); }}
                        className="px-2 py-0.5 text-xs text-red-500 hover:bg-red-50 rounded"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Add new area form */}
            <div className="border-t pt-2 flex flex-wrap items-end gap-2">
              <div>
                <label className="text-[11px] text-gray-500">名称</label>
                <input
                  value={newAreaName}
                  onChange={(e) => setNewAreaName(e.target.value)}
                  placeholder="如：贵宾区"
                  className="block w-24 px-2 py-1 border border-gray-300 rounded text-xs"
                />
              </div>
              <div>
                <label className="text-[11px] text-gray-500">布局</label>
                <select
                  value={newAreaLayout}
                  onChange={(e) => setNewAreaLayout(e.target.value)}
                  className="block px-1 py-1 border border-gray-300 rounded text-xs"
                >
                  {LAYOUT_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-[11px] text-gray-500">行×列</label>
                <div className="flex items-center gap-0.5">
                  <input
                    type="number" min={1} max={50} value={newAreaRows}
                    onChange={(e) => setNewAreaRows(Number(e.target.value))}
                    className="w-12 px-1 py-1 border border-gray-300 rounded text-xs text-center"
                  />
                  <span className="text-gray-400 text-xs">×</span>
                  <input
                    type="number" min={1} max={50} value={newAreaCols}
                    onChange={(e) => setNewAreaCols(Number(e.target.value))}
                    className="w-12 px-1 py-1 border border-gray-300 rounded text-xs text-center"
                  />
                </div>
              </div>
              <div>
                <label className="text-[11px] text-gray-500">舞台标签</label>
                <input
                  value={newAreaStage}
                  onChange={(e) => setNewAreaStage(e.target.value)}
                  placeholder="可选"
                  className="block w-20 px-2 py-1 border border-gray-300 rounded text-xs"
                />
              </div>
              <button
                onClick={() => createAreaMutation.mutate()}
                disabled={!newAreaName.trim() || createAreaMutation.isPending}
                className="flex items-center gap-1 px-2.5 py-1 bg-indigo-600 text-white rounded text-xs hover:bg-indigo-700 disabled:opacity-50"
              >
                <Plus size={13} />
                {createAreaMutation.isPending ? '创建中...' : '添加区域'}
              </button>
            </div>
          </div>
        )}

        {/* ═══ SVG Canvas (fills remaining height) ═══ */}
        <div className="flex-1 bg-white rounded-lg shadow relative overflow-hidden min-h-0">
          {seatsLoading ? (
            <div className="flex items-center justify-center h-full text-gray-500">
              加载中...
            </div>
          ) : !hasSeats ? (
            <div className="flex flex-col items-center justify-center h-full">
              <Grid3X3 size={48} className="text-gray-300 mb-4" />
              <p className="text-gray-500 text-sm">
                选择布局类型、设置行列数，点击「生成座位」
              </p>
            </div>
          ) : (
            renderSVGCanvas()
          )}

          {/* Multi-select action bar — appears when drag-select in 'select'
              mode picked up any seats. Floats over the bottom of the canvas. */}
          {selectedSeatIds.size > 0 && !paintMode && (
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-2 bg-white rounded-full shadow-lg border border-gray-200 px-3 py-2 text-sm z-10">
              <span className="text-gray-700 font-medium">
                已选 {selectedSeatIds.size} 个座位
              </span>
              <button
                onClick={() => {
                  if (
                    confirm(`确定删除选中的 ${selectedSeatIds.size} 个座位？`)
                  ) {
                    bulkDeleteMutation.mutate(Array.from(selectedSeatIds));
                  }
                }}
                disabled={bulkDeleteMutation.isPending}
                className="px-3 py-1 bg-red-600 text-white rounded-full font-medium hover:bg-red-700 disabled:opacity-50"
              >
                {bulkDeleteMutation.isPending ? '删除中…' : '删除'}
              </button>
              <button
                onClick={() => setSelectedSeatIds(new Set())}
                className="px-3 py-1 border border-gray-200 text-gray-600 rounded-full hover:bg-gray-50"
              >
                清除
              </button>
            </div>
          )}
        </div>

        {/* Selected Seat Detail with assign/unassign */}
        {renderSeatDetail()}

        {/* Feedback toasts */}
        {autoAssignMutation.isSuccess && (
          <div className="bg-green-50 border border-green-200 rounded-lg p-3 text-sm text-green-800">
            排座完成，分配 {(autoAssignMutation.data as any)?.count || 0} 个座位
          </div>
        )}
        {autoAssignMutation.isError && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-800">
            排座失败：{(autoAssignMutation.error as Error)?.message}
          </div>
        )}
      </div>

      {/* ═══ Right: Agent Sidebar (always visible) ═══ */}
      <SubAgentPanel
        eventId={eventId}
        scope="seating"
        title="排座 AI 助手"
        placeholder="如：生成剧院弧形布局、前3排设为贵宾区..."
        welcomeMessage={`我可以帮你：
1. 生成布局 — 如「用圆桌布局 8人一桌」
2. 自动排座 — 如「按优先级排座」
3. 分区规划 — 如「前3排设为贵宾区」
4. 查看状态 — 如「目前排座情况」`}
      />
    </div>
  );
}
