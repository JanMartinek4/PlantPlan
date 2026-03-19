import React, { useEffect, useMemo, useRef, useState } from "react";

import {
  DndContext,
  PointerSensor,
  closestCenter,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { supabase } from "./supabaseClient";
import type { DragEndEvent } from "@dnd-kit/core";

// =====================================================
// Planner – prototype "grid + lanes"
// =====================================================

// ---------------------------------------------
// Types
// ---------------------------------------------

type DayKey = string; // YYYY-MM-DD
type ItemType = "task" | "experiment";
type ViewMode = "plan" | "calendar" | "agenda";

type TaskRef = {
  id: string;
  title: string;
  day: DayKey;
  color: string;
  kind: "task" | "subtask";
  meta: any;
};

type TimedEvent = {
  id: string;
  day: DayKey;
  startMin: number;
  endMin: number;
};

type RecurringEvent = {
  id: string;
  title: string;
  color: string;
  weekday: number;
  startMin: number;
  endMin: number;
};

type PlanRecurring = {
  id: string;
  projectId: string;
  title: string;
  weekday: number; // 0=Sun .. 6=Sat
};

type PersistedStateV1 = {
  version: 1;
  windowStart: DayKey;
  windowLen: 7 | 14 | 28;
  viewMode: ViewMode;
  calendarDaysLen: 3 | 5 | 7;
  projects: Project[];
  timedEvents: Record<string, TimedEvent>;
  recurring: RecurringEvent[];
  planRecurring?: PlanRecurring[];
  inbox?: InboxTask[];
  completed?: InboxTask[];
  collapsedProjects?: Record<string, boolean>;
  completedTasks?: Record<string, boolean>;
};

const STORAGE_KEY = "pmorph_planner_v1";

type InboxTask = {
  id: string;
  projectId: string;
  title: string;
  notes?: string;
  checklist?: CheckItem[];
};

type CheckItem = { id: string; text: string; done: boolean };

type ExperimentSubTask = {
  id: string;
  width?: number;
  title: string;
  day: DayKey;
  notes?: string;
  checklist?: CheckItem[];
};

type LaneItem =
  | {
      id: string;
      type: "task";
      title: string;
      start: DayKey;
      end: DayKey;
      notes?: string;
      checklist?: CheckItem[];
    }
  | {
      id: string;
      type: "experiment";
      title: string;
      desc: string;
      start: DayKey;
      end: DayKey;
      subTasks: Record<DayKey, ExperimentSubTask[]>;
      notes?: string;
      checklist?: CheckItem[];
    };

type Lane = {
  id: string;
  items: LaneItem[];
};

type Project = {
  id: string;
  name: string;
  color: string;
  lanes: Lane[];
  notes?: string;
  checklist?: CheckItem[];
};

type Selection =
  | { kind: "item"; projectId: string; itemId: string }
  | { kind: "subtask"; projectId: string; experimentId: string; subTaskId: string }
  | null;

type DetailTarget =
  | { kind: "item"; projectId: string; laneId: string; itemId: string }
  | { kind: "subtask"; projectId: string; laneId: string; experimentId: string; subTaskId: string; day: DayKey }
  | { kind: "inbox"; inboxId: string }
  | { kind: "project"; projectId: string }
  | null;

type DragCreate = {
  projectId: string;
  laneId: string;
  startDay: DayKey;
  currentDay: DayKey;
  pointerId: number;
  moved: boolean;
} | null;

type ResizeExp = {
  projectId: string;
  laneId: string;
  expId: string;
  edge: "start" | "end";
  pointerId: number;
} | null;

// ---------------------------------------------
// Date utils (UTC-safe)
// ---------------------------------------------

function parseDay(day: DayKey): Date {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function formatDay(date: Date): DayKey {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function addDays(day: DayKey, delta: number): DayKey {
  const dt = parseDay(day);
  dt.setUTCDate(dt.getUTCDate() + delta);
  return formatDay(dt);
}

function diffDays(from: DayKey, to: DayKey): number {
  const a = parseDay(from).getTime();
  const b = parseDay(to).getTime();
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  return Math.round((b - a) / MS_PER_DAY);
}

function compareDay(a: DayKey, b: DayKey): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function todayUTC(): DayKey {
  const now = new Date();
  const dt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return formatDay(dt);
}

function dayLabel(day: DayKey) {
  const dt = parseDay(day);
  const weekday = dt.toLocaleDateString(undefined, { weekday: "short", timeZone: "UTC" });
  const md = dt.toLocaleDateString(undefined, { month: "numeric", day: "2-digit", timeZone: "UTC" });
  return { weekday, md };
}

// ---------------------------------------------
// Time-range parser — extracts HH:MM-HH:MM from task title
// Returns null if no valid time range found
// ---------------------------------------------

function parseTimeRange(title: string): { startMin: number; endMin: number } | null {
  // Match patterns like 10:00-12:00, 10:00–12:30, 10.00-12.00
  const m = title.match(/\b(\d{1,2})[:\.·](\d{2})\s*[-–—]\s*(\d{1,2})[:\.·](\d{2})\b/);
  if (!m) return null;
  const startMin = parseInt(m[1]) * 60 + parseInt(m[2]);
  const endMin   = parseInt(m[3]) * 60 + parseInt(m[4]);
  if (startMin >= endMin) return null;
  if (startMin < 0 || endMin > 24 * 60) return null;
  return { startMin, endMin };
}

// ---------------------------------------------
// Scheduling helpers
// ---------------------------------------------

function overlaps(a: { start: DayKey; end: DayKey }, b: { start: DayKey; end: DayKey }) {
  return !(compareDay(a.end, b.start) < 0 || compareDay(b.end, a.start) < 0);
}

function sortLaneItems(items: LaneItem[]) {
  return items.slice().sort((x, y) => {
    const c = compareDay(x.start, y.start);
    if (c !== 0) return c;
    return x.id.localeCompare(y.id);
  });
}

function canPlaceInLane(lane: Lane, candidate: LaneItem, ignoreItemId?: string) {
  for (const it of lane.items) {
    if (ignoreItemId && it.id === ignoreItemId) continue;
    if (overlaps(it, candidate)) return false;
  }
  return true;
}

function upsertIntoLane(lane: Lane, candidate: LaneItem, ignoreItemId?: string): Lane {
  const filtered = ignoreItemId ? lane.items.filter((i) => i.id !== ignoreItemId) : lane.items.slice();
  filtered.push(candidate);
  return { ...lane, items: sortLaneItems(filtered) };
}

function removeFromLanes(lanes: Lane[], itemId: string): Lane[] {
  return lanes
    .map((l) => ({ ...l, items: l.items.filter((i) => i.id !== itemId) }))
    .filter((l) => l.items.length > 0);
}

function ensureAtLeastOneLane(lanes: Lane[]): Lane[] {
  return lanes.length ? lanes : [{ id: `lane_${crypto.randomUUID()}`, items: [] }];
}

function placeItemPacked(project: Project, preferredLaneId: string | null, item: LaneItem, ignoreItemId?: string): Project {
  let lanes = removeFromLanes(project.lanes, ignoreItemId ?? item.id);

  if (preferredLaneId) {
    const idx = lanes.findIndex((l) => l.id === preferredLaneId);
    if (idx !== -1 && canPlaceInLane(lanes[idx], item, ignoreItemId)) {
      lanes[idx] = upsertIntoLane(lanes[idx], item, ignoreItemId);
      return { ...project, lanes: ensureAtLeastOneLane(lanes) };
    }
  }

  for (let i = 0; i < lanes.length; i++) {
    if (canPlaceInLane(lanes[i], item, ignoreItemId)) {
      lanes[i] = upsertIntoLane(lanes[i], item, ignoreItemId);
      return { ...project, lanes: ensureAtLeastOneLane(lanes) };
    }
  }

  const newLane: Lane = { id: `lane_${crypto.randomUUID()}`, items: [item] };
  lanes.push(newLane);
  return { ...project, lanes: ensureAtLeastOneLane(lanes) };
}

function findLane(project: Project, laneId: string): Lane | null {
  return project.lanes.find((l) => l.id === laneId) ?? null;
}

function findExperimentAtDay(lane: Lane, day: DayKey): LaneItem | null {
  for (const it of lane.items) {
    if (it.type !== "experiment") continue;
    if (compareDay(it.start, day) <= 0 && compareDay(day, it.end) <= 0) return it;
  }
  return null;
}

function shiftExperimentSubtasks(subTasks: Record<DayKey, ExperimentSubTask[]>, delta: number) {
  const out: Record<DayKey, ExperimentSubTask[]> = {};
  for (const [day, arr] of Object.entries(subTasks)) {
    const nd = addDays(day, delta);
    out[nd] = arr.map((t) => ({ ...t, day: nd }));
  }
  return out;
}

function subTaskBounds(exp: Extract<LaneItem, { type: "experiment" }>): { min: DayKey; max: DayKey } | null {
  const days = Object.keys(exp.subTasks);
  if (!days.length) return null;
  let min = days[0];
  let max = days[0];
  for (const d of days) {
    if (compareDay(d, min) < 0) min = d;
    if (compareDay(d, max) > 0) max = d;
  }
  return { min, max };
}

// ---------------------------------------------
// DnD ID helpers
// ---------------------------------------------

function splitId(id: string) {
  return id.split(":");
}

function isPrefix(id: string, prefix: string) {
  return id.startsWith(prefix + ":");
}

// ---------------------------------------------
// UI blocks
// ---------------------------------------------

function ExpDayDroppable({
  id,
  title,
  style,
  onClick,
  onPointerDown,
}: {
  id: string;
  title?: string;
  style: React.CSSProperties;
  onClick?: (e: React.MouseEvent<HTMLDivElement>) => void;
  onPointerDown?: (e: React.PointerEvent<HTMLDivElement>) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div
      ref={setNodeRef}
      className={"pointer-events-auto absolute " + (isOver ? "ring-2 ring-zinc-400" : "")}
      style={style}
      title={title}
      onPointerDown={onPointerDown}
      onClick={onClick}
    />
  );
}

function Draggable({
  id,
  children,
  className = "",
}: {
  id: string;
  children: React.ReactNode;
  className?: string;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id });
  const style: React.CSSProperties = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
    : undefined;

  return (
    <div
      ref={setNodeRef}
      style={{ ...style, touchAction: "none" }}
      className={(className ? className + " " : "") + (isDragging ? "opacity-60" : "")}
      {...attributes}
      {...listeners}
    >
      {children}
    </div>
  );
}

function deleteItemFromProject(project: Project, itemId: string): Project {
  const lanes = project.lanes
    .map((l) => ({ ...l, items: l.items.filter((i) => i.id !== itemId) }))
    .filter((l) => l.items.length > 0);
  return { ...project, lanes: ensureAtLeastOneLane(lanes) };
}

function DroppableCell({
  id,
  width,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  isToday = false,
  isWeekend = false,
  className = "",
}: {
  id: string;
  width: number;
  onPointerDown?: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerMove?: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerUp?: (e: React.PointerEvent<HTMLDivElement>) => void;
  isToday?: boolean;
  isWeekend?: boolean;
  className?: string;
}) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div
      ref={setNodeRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      style={{ 
        width,
        background: isToday ? 'var(--today-bg)' : isWeekend ? 'var(--weekend-bg)' : 'var(--cell-bg)',
        borderColor: 'var(--cell-border)'
      }}
      className={
        "relative h-20 border-b border-r " +
        (isOver ? "ring-2 ring-zinc-400 " : "") +
        "cursor-pointer " +
        className
      }
    />
  );
}

function Segment({
  item,
  color,
  selected,
  onDelete,
  onSelect,
  onUpdateTitle,
  onUpdateDesc,
  onClose,
  onOpenDetail,
  projectId,
  laneId,
  onSetDetailTarget,
}: {
  item: LaneItem;
  color: string;
  selected?: boolean;
  onDelete?: () => void;
  onSelect?: () => void;
  onUpdateTitle?: (title: string) => void;
  onUpdateDesc?: (desc: string) => void;
  onClose?: () => void;
  onOpenDetail?: () => void;
  projectId?: string;
  laneId?: string;
  onSetDetailTarget?: (t: DetailTarget) => void;
}) {
  const bg = item.type === "task" ? color : color + "22";
  const border = item.type === "task" ? "transparent" : color;

  const [draftTitle, setDraftTitle] = useState(item.type === "task" ? item.title : "");
  const [draftDesc, setDraftDesc] = useState(item.type === "experiment" ? (item.desc ?? "") : "");
  const titleInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (selected && item.type === "task") setDraftTitle(item.title);
    if (selected && item.type === "experiment") setDraftDesc(item.desc ?? "");
  }, [selected, item]);

  // Auto-focus and select when popover opens for a task
  useEffect(() => {
    if (!selected || item.type !== "task") return;
    // Use a short timeout to ensure the popover DOM has rendered
    const t = setTimeout(() => {
      const el = titleInputRef.current;
      if (el) { el.focus(); el.select(); }
    }, 50);
    return () => clearTimeout(t);
  }, [selected]);

  function commitTitle() {
    if (item.type !== "task") return;
    const t = draftTitle.trim();
    if (!t) {
      setDraftTitle(item.title);
      return;
    }
    if (t !== item.title) onUpdateTitle?.(t);
  }

  return (
    <div
      className="group relative h-full"
      title={item.type === "experiment" ? (item.desc || "") : undefined}
      onClick={(e) => {
        e.stopPropagation();
        onSelect?.();
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        const el = (e.currentTarget as HTMLDivElement).querySelector(
          "input[data-title-editor='1']"
        ) as HTMLInputElement | null;
        el?.focus();
        el?.select();
      }}
    >
      <div
        className={
          (item.type === "experiment" ? "h-full" : "h-10") +
          " rounded-md shadow-sm " +
          (item.type === "task"
            ? "px-2 py-1"
            : "relative border-2" + (selected ? " ring-2 ring-zinc-900/40" : ""))
        }
        style={{ background: bg, borderColor: border }}
      >
        {item.type === "task" && (
          <div className="flex items-center gap-1 truncate text-xs font-semibold text-white">
            <span className="truncate">{item.title}</span>
          </div>
        )}
        {item.type === "experiment" && (
          <div
            className="absolute bottom-1 left-2 right-2 flex items-center gap-1 truncate text-[10px] font-medium leading-tight"
            style={{ color: color }}
          >
            {item.desc && <span className="truncate">{item.desc}</span>}
          </div>
        )}
      </div>

      {selected && item.type === "task" && (
        <div
          className="absolute left-0 top-full z-20 mt-2 w-[260px] rounded-xl border border-zinc-200 bg-white p-2 shadow-lg"
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div className="flex flex-wrap items-center gap-2">
            <input
              data-title-editor="1"
              ref={titleInputRef}
              className="h-8 w-full rounded-lg border border-zinc-200 px-2 text-sm outline-none focus:ring-2 focus:ring-zinc-300"
              value={draftTitle}
              placeholder="task name…"
              onChange={(e) => setDraftTitle(e.target.value)}
              onBlur={() => commitTitle()}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitTitle();
                  onClose?.();
                  (e.currentTarget as HTMLInputElement).blur();
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  setDraftTitle(item.title);
                  onClose?.();
                  (e.currentTarget as HTMLInputElement).blur();
                }
              }}
            />
          </div>
          <div className="mt-2 flex items-center justify-between gap-2">
            <button
              className="h-8 rounded-lg border border-zinc-200 bg-white px-3 text-xs hover:bg-zinc-50"
              onClick={(e) => { 
                e.stopPropagation();
                commitTitle(); 
                if (projectId && laneId) {
                  if (typeof (window as any).__openDetail === "function") (window as any).__openDetail(({ kind: "item", projectId, laneId, itemId: item.id }));
                }
                onClose?.(); 
              }}
              title="Open detail with notes"
            >
              📝 Detail
            </button>
            <div className="flex gap-2">
            <button
              className="h-8 rounded-lg border border-zinc-200 bg-white px-3 text-sm hover:bg-zinc-50"
              onClick={() => { commitTitle(); onClose?.(); }}
            >
              Save
            </button>
            <button
              className="h-8 rounded-lg border border-zinc-200 bg-white px-3 text-sm hover:bg-zinc-50"
              onClick={() => { onDelete?.(); onClose?.(); }}
            >
              Delete
            </button>
            </div>
          </div>
        </div>
      )}
      {/* Experiment popover removed from here - rendered at LaneRow level instead */}

      {onDelete && (
        <button
          className={
            "absolute -right-2 -top-2 h-6 w-6 rounded-full border border-zinc-200 bg-white text-xs shadow-sm " +
            "opacity-0 transition-opacity group-hover:opacity-100 " +
            (selected ? "opacity-100" : "")
          }
          title="Delete"
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
        >
          ✕
        </button>
      )}
    </div>
  );
}

function SubTaskPill({
  text,
  color,
  selected,
  onSelect,
  onDelete,
  onUpdateTitle,
  onClose,
  onOpenDetail,
}: {
  text: string;
  color: string;
  selected?: boolean;
  onSelect?: () => void;
  onDelete?: () => void;
  onUpdateTitle?: (t: string) => void;
  onClose?: () => void;
  onOpenDetail?: () => void;
}) {
  const [draft, setDraft] = useState(text);
  const subTitleRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (selected) setDraft(text);
  }, [selected, text]);

  useEffect(() => {
    if (selected && subTitleRef.current) {
      const el = subTitleRef.current;
      requestAnimationFrame(() => { el.focus(); el.select(); });
    }
  }, [selected]);

  function commit() {
    const t = draft.trim();
    if (!t) { setDraft(text); return; }
    if (t !== text) onUpdateTitle?.(t);
  }

  return (
    <div className="relative">
      <div
        className={
          "truncate rounded-md px-1.5 py-0.5 text-[10px] font-medium text-white " +
          (selected ? "ring-2 ring-zinc-900/30" : "")
        }
        style={{ background: color }}
        onClick={(e) => { e.stopPropagation(); onSelect?.(); }}
        title={text}
      >
        {text}
      </div>

      {selected && (
        <div
          className="absolute left-0 top-full z-30 mt-2 w-[260px] rounded-xl border border-zinc-200 bg-white p-2 shadow-lg"
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div className="flex items-center gap-2">
            <input
              ref={subTitleRef}
              data-title-editor="1"
              className="h-8 w-full rounded-lg border border-zinc-200 px-2 text-sm outline-none focus:ring-2 focus:ring-zinc-300"
              value={draft}
              placeholder="task name…"
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => commit()}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commit();
                  onClose?.();
                  (e.currentTarget as HTMLInputElement).blur();
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  setDraft(text);
                  onClose?.();
                  (e.currentTarget as HTMLInputElement).blur();
                }
              }}
            />
          </div>
          <div className="mt-2 flex items-center justify-between gap-2">
            <button
              className="h-8 rounded-lg border border-zinc-200 bg-white px-3 text-xs hover:bg-zinc-50"
              onClick={() => { commit(); onOpenDetail?.(); onClose?.(); }}
              title="Open detail with notes"
            >
              📝 Detail
            </button>
            <div className="flex gap-2">
            <button
              className="h-8 rounded-lg border border-zinc-200 bg-white px-3 text-sm hover:bg-zinc-50"
              onClick={() => { commit(); onClose?.(); }}
            >
              Save
            </button>
            <button
              className="h-8 rounded-lg border border-zinc-200 bg-white px-3 text-sm hover:bg-zinc-50"
              onClick={() => { onDelete?.(); onClose?.(); }}
            >
              Delete
            </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------
// Demo seed
// ---------------------------------------------

function seed(base: DayKey): Project[] {
  const exp1: LaneItem = {
    id: "i2",
    type: "experiment",
    title: "",
    desc: "",
    start: addDays(base, 2),
    end: addDays(base, 8),
    subTasks: {
      [addDays(base, 2)]: [{ id: "st1", title: "Seeds to shelves + fridge", day: addDays(base, 2) }],
      [addDays(base, 4)]: [{ id: "st2", title: "Remove from fridge → box", day: addDays(base, 4) }],
      [addDays(base, 7)]: [
        { id: "st3", title: "Microscope", day: addDays(base, 7) },
        { id: "st4", title: "Data backup", day: addDays(base, 7) },
      ],
    },
  };

  const p1: Project = {
    id: "p1",
    name: "project1",
    color: "#f59e0b",
    lanes: [
      {
        id: "l1",
        items: [
          { id: "i1", type: "task", title: "Standalone task", start: addDays(base, 1), end: addDays(base, 1) },
          exp1,
          { id: "i4", type: "task", title: "Another task", start: addDays(base, 6), end: addDays(base, 6) },
        ],
      },
    ],
  };

  const p2: Project = {
    id: "p2",
    name: "Project 2",
    color: "#22c55e",
    lanes: [
      {
        id: "l1",
        items: [
          { id: "j1", type: "task", title: "task1", start: addDays(base, 0), end: addDays(base, 0) },
          {
            id: "j2",
            type: "experiment",
            title: "",
            desc: "",
            start: addDays(base, 2),
            end: addDays(base, 5),
            subTasks: {},
          },
        ],
      },
    ],
  };

  p1.lanes = p1.lanes.map((l) => ({ ...l, items: sortLaneItems(l.items) }));
  p2.lanes = p2.lanes.map((l) => ({ ...l, items: sortLaneItems(l.items) }));
  return [p1, p2];
}

// ExperimentPopover — rendered at LaneRow level, outside Segment/Draggable hierarchy
function ExperimentPopover({
  item,
  left,
  projectId,
  laneId,
  onUpdateDesc,
  onDelete,
  onClose,
}: {
  item: LaneItem;
  left: number;
  projectId: string;
  laneId: string;
  onUpdateDesc: (desc: string) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const [draftDesc, setDraftDesc] = useState(item.type === "experiment" ? (item.desc ?? "") : "");
  useEffect(() => { setDraftDesc(item.type === "experiment" ? (item.desc ?? "") : ""); }, [item]);
  return (
    <div
      className="pointer-events-auto absolute z-[300] w-[320px] rounded-xl border border-zinc-200 bg-white p-2 shadow-lg"
      style={{ left, top: -4 }}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="mb-1 text-xs font-medium text-zinc-700">Experiment description</div>
      <textarea
        className="h-20 w-full resize-none rounded-lg border border-zinc-200 p-2 text-sm outline-none focus:ring-2 focus:ring-zinc-300"
        value={draftDesc}
        onChange={(e) => setDraftDesc(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") { e.preventDefault(); setDraftDesc(item.desc ?? ""); onClose(); }
        }}
        onBlur={() => onUpdateDesc(draftDesc)}
      />
      <div className="mt-2 flex items-center justify-between gap-2">
        <button
          className="h-8 rounded-lg border border-zinc-200 bg-white px-3 text-xs hover:bg-zinc-50"
          onClick={() => { 
            onUpdateDesc(draftDesc); 
            if (typeof (window as any).__openDetail === "function") {
              (window as any).__openDetail({ kind: "item", projectId, laneId, itemId: item.id });
            }
            onClose(); 
          }}
          title="Open detail with notes"
        >📝 Detail</button>
        <div className="flex gap-2">
          <button className="h-8 rounded-lg border border-zinc-200 bg-white px-3 text-sm hover:bg-zinc-50" onClick={onDelete}>Delete</button>
          <button className="h-8 rounded-lg bg-zinc-900 px-3 text-sm font-semibold text-white hover:bg-zinc-800" onClick={() => { onUpdateDesc(draftDesc); onClose(); }}>Save</button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------
// LaneRow component — defined OUTSIDE App
// ---------------------------------------------

function LaneRow({
  project,
  lane,
  days,
  cellW,
  dragCreate,
  resizeExp,
  onStartRange,
  onUpdateRange,
  onFinishRange,
  onStartResize,
  onUpdateResize,
  onFinishResize,
  selection,
  onSelectItem,
  onDeleteItem,
  onUpdateTitle,
  onUpdateDesc,
  onClearSelection,
  onAddSubTask,
  onSelectSubTask,
  onUpdateSubTaskTitle,
  onDeleteSubTask,
  onCopyExperiment,
  planRecurringInstances = [],
  onOpenDetail,
}: {
  project: Project;
  lane: Lane;
  days: DayKey[];
  cellW: number;
  dragCreate: DragCreate;
  resizeExp: ResizeExp;
  onStartRange: (day: DayKey, pointerId: number) => void;
  onUpdateRange: (day: DayKey) => void;
  onFinishRange: (pointerId: number, clickedDay: DayKey, clickedExperimentId: string | null) => void;
  onStartResize: (expId: string, edge: "start" | "end", pointerId: number) => void;
  onUpdateResize: (day: DayKey) => void;
  onFinishResize: (pointerId: number) => void;
  selection: Selection;
  onSelectItem: (projectId: string, itemId: string) => void;
  onDeleteItem: (projectId: string, itemId: string) => void;
  onUpdateTitle: (projectId: string, itemId: string, title: string) => void;
  onUpdateDesc: (projectId: string, itemId: string, desc: string) => void;
  onClearSelection: () => void;
  onAddSubTask: (experimentId: string, day: DayKey) => void;
  onSelectSubTask: (experimentId: string, subTaskId: string) => void;
  onUpdateSubTaskTitle: (experimentId: string, subTaskId: string, title: string) => void;
  onDeleteSubTask: (experimentId: string, subTaskId: string) => void;
  onCopyExperiment: (experimentId: string) => void;
  planRecurringInstances?: Array<{ id: string; title: string; day: DayKey; projectId: string; color: string }>;
  onOpenDetail?: (target: DetailTarget) => void;
}) {
  const gridRef = useRef<HTMLDivElement | null>(null);
  const [expandedDay, setExpandedDay] = useState<{ expId: string; day: DayKey } | null>(null);

  const itemsInWindow = lane.items.filter(
    (it) => !(compareDay(it.end, days[0]) < 0 || compareDay(days[days.length - 1], it.start) < 0)
  );

  useEffect(() => {
    if (!resizeExp) return;
    if (resizeExp.projectId !== project.id || resizeExp.laneId !== lane.id) return;

    const pid = resizeExp.pointerId;

    const move = (e: PointerEvent) => {
      if (e.pointerId !== pid) return;
      const rect = gridRef.current?.getBoundingClientRect();
      if (!rect) return;
      const x = e.clientX - rect.left;
      const idx = Math.max(0, Math.min(days.length - 1, Math.floor(x / cellW)));
      onUpdateResize(days[idx]);
    };

    const stop = (e: PointerEvent) => {
      if (e.pointerId !== pid) return;
      onFinishResize(pid);
    };

    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", stop, true);
    window.addEventListener("pointercancel", stop, true);
    return () => {
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", stop, true);
      window.removeEventListener("pointercancel", stop, true);
    };
  }, [resizeExp, project.id, lane.id, days]);

  return (
    <div className="flex">
      <div ref={gridRef} className="relative flex" style={{ width: days.length * cellW, height: 80 }}>
        {/* Cells */}
        <div className="absolute inset-0 flex">
          {days.map((d) => (
            <React.Fragment key={d}>
              <DroppableCell
              key={d}
              width={cellW}
              id={`cell:${project.id}:${lane.id}:${d}`}
              isToday={d === todayUTC()}
              isWeekend={(() => { const wk = dayLabel(d).weekday.toLowerCase(); return wk.startsWith("sat") || wk.startsWith("sun") || wk.startsWith("so") || wk.startsWith("ne"); })()}
              onPointerDown={(e) => {
                if (e.target !== e.currentTarget) return;
                if (e.button !== 0) return;
                if (resizeExp) return;
                (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
                onStartRange(d, e.pointerId);
              }}
              onPointerMove={(e) => {
                if (!dragCreate) return;
                if (dragCreate.projectId !== project.id || dragCreate.laneId !== lane.id) return;
                if (dragCreate.pointerId !== e.pointerId) return;
                const rect = gridRef.current?.getBoundingClientRect();
                if (!rect) return;
                const x = e.clientX - rect.left;
                const idx = Math.max(0, Math.min(days.length - 1, Math.floor(x / cellW)));
                const day = days[idx];
                if (day !== dragCreate.currentDay) onUpdateRange(day);
              }}
              onPointerUp={(e) => {
                if (e.target !== e.currentTarget) {
                  try { (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId); } catch {}
                  return;
                }
                try { (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId); } catch {}

                if (resizeExp && resizeExp.projectId === project.id && resizeExp.laneId === lane.id && resizeExp.pointerId === e.pointerId) {
                  onFinishResize(e.pointerId);
                  return;
                }
                if (!dragCreate) return;
                if (dragCreate.projectId !== project.id || dragCreate.laneId !== lane.id) return;
                // Stop the click from bubbling to the outer container which would clear selection
                e.stopPropagation();
                onFinishRange(
                  e.pointerId,
                  d,
                  (() => {
                    const exp = findExperimentAtDay(lane, d);
                    return exp && exp.type === "experiment" ? exp.id : null;
                  })()
                );
              }}
            />
            </React.Fragment>
          ))}
        </div>

        {/* Range-create preview */}
        {dragCreate &&
          dragCreate.projectId === project.id &&
          dragCreate.laneId === lane.id &&
          (() => {
            const s = compareDay(dragCreate.startDay, dragCreate.currentDay) <= 0 ? dragCreate.startDay : dragCreate.currentDay;
            const e = compareDay(dragCreate.startDay, dragCreate.currentDay) <= 0 ? dragCreate.currentDay : dragCreate.startDay;
            const visStart = compareDay(s, days[0]) < 0 ? days[0] : s;
            const visEnd = compareDay(e, days[days.length - 1]) > 0 ? days[days.length - 1] : e;
            const left = diffDays(days[0], visStart) * cellW + 4;
            const span = diffDays(visStart, visEnd) + 1;
            const width = span * cellW - 8;
            return (
              <div className="pointer-events-none absolute" style={{ left, width, top: 4, height: 72 }}>
                <div className="h-full rounded-md border-2 border-zinc-400 bg-transparent" />
              </div>
            );
          })()}

        {/* Segments + experiment subtasks */}
        <div className="pointer-events-none absolute inset-0">
          {itemsInWindow.map((it) => {
            const visStart = compareDay(it.start, days[0]) < 0 ? days[0] : it.start;
            const visEnd = compareDay(it.end, days[days.length - 1]) > 0 ? days[days.length - 1] : it.end;

            const left = diffDays(days[0], visStart) * cellW + 4;
            const span = diffDays(visStart, visEnd) + 1;
            const width = span * cellW - 8;

            return (
              <div key={it.id} className="absolute" style={{ left, width, top: 4, height: 72 }}>
                <div className="pointer-events-auto h-full">
                  <Draggable id={`item:${project.id}:${lane.id}:${it.id}`} className={it.type === "experiment" ? "h-full" : ""}>
                    <div
                      className="cursor-grab active:cursor-grabbing h-full"
                      onPointerDown={(e) => {
                        // Ctrl/Cmd + click on experiment = copy to new lane
                        if (it.type === "experiment" && (e.ctrlKey || e.metaKey)) {
                          e.stopPropagation();
                          e.preventDefault();
                          onCopyExperiment(it.id);
                        }
                      }}
                    >
                      <Segment
                        item={it}
                        color={project.color}
                        selected={
                          !!selection &&
                          selection.kind === "item" &&
                          selection.projectId === project.id &&
                          selection.itemId === it.id
                        }
                        onSelect={() => onSelectItem(project.id, it.id)}
                        onDelete={() => onDeleteItem(project.id, it.id)}
                        onUpdateTitle={(title) => onUpdateTitle(project.id, it.id, title)}
                        onUpdateDesc={(desc) => onUpdateDesc(project.id, it.id, desc)}
                        onClose={() => onClearSelection()}
                        onOpenDetail={() => onOpenDetail?.({ kind: "item", projectId: project.id, laneId: lane.id, itemId: it.id })}
                        projectId={project.id}
                        laneId={lane.id}
                        onSetDetailTarget={(t) => onOpenDetail?.(t!)}
                      />

                      {it.type === "experiment" && (
                        <>
                          {/* Ctrl+click copy hint — shown on hover */}
                          <div
                            className="pointer-events-none absolute right-5 top-1 z-20 hidden rounded bg-black/60 px-1 py-0.5 text-[9px] text-white group-ctrl:block"
                            style={{ whiteSpace: "nowrap" }}
                          >
                            Ctrl+click = copy
                          </div>
                          <div
                            className="absolute left-0 top-0 z-20 h-full w-3 cursor-ew-resize"
                            title="Change experiment start"
                            onPointerDown={(e) => {
                              e.stopPropagation();
                              if (e.button !== 0) return;
                              onStartResize(it.id, "start", e.pointerId);
                            }}
                            onPointerUp={(e) => { e.stopPropagation(); onFinishResize(e.pointerId); }}
                            onPointerCancel={(e) => { e.stopPropagation(); onFinishResize(e.pointerId); }}
                          />
                          <div
                            className="absolute right-0 top-0 z-20 h-full w-3 cursor-ew-resize"
                            title="Change experiment end"
                            onPointerDown={(e) => {
                              e.stopPropagation();
                              if (e.button !== 0) return;
                              (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
                              onStartResize(it.id, "end", e.pointerId);
                            }}
                            onPointerUp={(e) => {
                              e.stopPropagation();
                              try { (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId); } catch {}
                              onFinishResize(e.pointerId);
                            }}
                            onPointerCancel={(e) => {
                              e.stopPropagation();
                              try { (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId); } catch {}
                              onFinishResize(e.pointerId);
                            }}
                          />
                        </>
                      )}
                    </div>
                  </Draggable>
                </div>
              </div>
            );
          })}

          {/* Experiment popover - rendered at LaneRow level, outside Segment/Draggable */}
          {itemsInWindow
            .filter((it) => it.type === "experiment" && 
              !!selection && selection.kind === "item" && 
              selection.projectId === project.id && selection.itemId === it.id
            )
            .map((it) => {
              const visStart = compareDay(it.start, days[0]) < 0 ? days[0] : it.start;
              const left = diffDays(days[0], visStart) * cellW + 4;
              return (
                <ExperimentPopover
                  key={`exp-popover:${it.id}`}
                  item={it}
                  left={left}
                  projectId={project.id}
                  laneId={lane.id}
                  onUpdateDesc={(desc) => onUpdateDesc(project.id, it.id, desc)}
                  onDelete={() => onDeleteItem(project.id, it.id)}
                  onClose={() => onClearSelection()}
                />
              );
            })}

          {/* ExpDay click zones */}
          {itemsInWindow
            .filter((it) => it.type === "experiment")
            .flatMap((it) => {
              const exp = it as Extract<LaneItem, { type: "experiment" }>;
              const nodes: React.ReactNode[] = [];
              for (const day of days) {
                if (compareDay(day, exp.start) < 0 || compareDay(day, exp.end) > 0) continue;
                const x = diffDays(days[0], day) * cellW + 8;
                nodes.push(
                  <ExpDayDroppable
                    key={`expday:${exp.id}:${day}`}
                    id={`expday:${project.id}:${lane.id}:${exp.id}:${day}`}
                    title="Click: add task to experiment"
                    style={{ left: x, top: 52, width: cellW - 16, height: 20 }}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => { e.stopPropagation(); onAddSubTask(exp.id, day); }}
                  />
                );
              }
              return nodes;
            })}

          {/* Experiment subtask pills */}
          {itemsInWindow
            .filter((it) => it.type === "experiment")
            .flatMap((it) => {
              const exp = it as Extract<LaneItem, { type: "experiment" }>;
              const out: React.ReactNode[] = [];

              for (const [day, tasks] of Object.entries(exp.subTasks)) {
                if (compareDay(day, days[0]) < 0 || compareDay(day, days[days.length - 1]) > 0) continue;
                if (compareDay(day, exp.start) < 0 || compareDay(day, exp.end) > 0) continue;

                const x = diffDays(days[0], day) * cellW + 8;
                const maxShow = 2;
                const shown = tasks.slice(0, maxShow);
                const hidden = tasks.length - shown.length;

                out.push(
                  <div key={`${exp.id}:${day}`} className="pointer-events-auto absolute" style={{ left: x, top: 8, width: cellW - 16 }}>
                    <div className="space-y-1">
                      {shown.map((t) => (
                        <Draggable id={`subtask:${project.id}:${lane.id}:${exp.id}:${t.id}`} key={t.id}>
                          <div className="cursor-grab active:cursor-grabbing">
                            <SubTaskPill
                              text={t.title}
                              color={project.color}
                              onClose={() => onClearSelection()}
                              selected={
                                !!selection &&
                                selection.kind === "subtask" &&
                                selection.projectId === project.id &&
                                selection.experimentId === exp.id &&
                                selection.subTaskId === t.id
                              }
                              onSelect={() => onSelectSubTask(exp.id, t.id)}
                              onUpdateTitle={(title) => onUpdateSubTaskTitle(exp.id, t.id, title)}
                              onDelete={() => onDeleteSubTask(exp.id, t.id)}
                              onOpenDetail={() => onOpenDetail?.({ kind: "subtask", projectId: project.id, laneId: lane.id, experimentId: exp.id, subTaskId: t.id, day })}
                            />
                          </div>
                        </Draggable>
                      ))}

                      {hidden > 0 && (
                        <button
                          className="text-[10px] font-medium text-zinc-700 hover:underline"
                          onClick={(e) => { e.stopPropagation(); setExpandedDay({ expId: exp.id, day }); }}
                        >
                          +{hidden}…
                        </button>
                      )}
                    </div>

                    {expandedDay && expandedDay.expId === exp.id && expandedDay.day === day && (
                      <div
                        className="absolute left-0 top-full z-40 mt-2 w-[320px] rounded-xl border border-zinc-200 bg-white p-2 shadow-lg"
                        onClick={(e) => e.stopPropagation()}
                        onPointerDown={(e) => e.stopPropagation()}
                      >
                        <div className="mb-2 flex items-center justify-between">
                          <div className="text-xs font-medium text-zinc-700">All tasks</div>
                          <button
                            className="h-7 w-7 rounded-full border border-zinc-200 bg-white text-xs hover:bg-zinc-50"
                            onClick={() => setExpandedDay(null)}
                            title="Close"
                          >
                            ✕
                          </button>
                        </div>
                        <div className="space-y-1">
                          {tasks.map((tt) => (
                            <div key={tt.id} className="rounded-lg border border-zinc-200 p-2">
                              <SubTaskPill
                                text={tt.title}
                                color={project.color}
                                selected={
                                  !!selection &&
                                  selection.kind === "subtask" &&
                                  selection.projectId === project.id &&
                                  selection.experimentId === exp.id &&
                                  selection.subTaskId === tt.id
                                }
                                onSelect={() => onSelectSubTask(exp.id, tt.id)}
                                onUpdateTitle={(title) => onUpdateSubTaskTitle(exp.id, tt.id, title)}
                                onDelete={() => onDeleteSubTask(exp.id, tt.id)}
                                onClose={() => onClearSelection()}
                                onOpenDetail={() => onOpenDetail?.({ kind: "subtask", projectId: project.id, laneId: lane.id, experimentId: exp.id, subTaskId: tt.id, day })}
                              />
                            </div>
                          ))}
                        </div>
                        <div className="mt-2 text-right">
                          <button className="text-xs text-zinc-600 hover:underline" onClick={() => setExpandedDay(null)}>
                            Close
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              }
              return out;
            })}
        </div>
      </div>
    </div>
  );
}


// ---------------------------------------------
// AgendaView component
// ---------------------------------------------

function AgendaView({
  days,
  projects,
  planRecurringInstances = [],
  darkMode = false,
  completedTasks = {},
  onToggleComplete,
  onOpenDetail,
}: {
  days: DayKey[];
  projects: Project[];
  planRecurringInstances?: Array<{ id: string; title: string; day: DayKey; projectId: string; color: string }>;
  darkMode?: boolean;
  completedTasks?: Record<string, boolean>;
  onToggleComplete?: (id: string) => void;
  onOpenDetail?: (target: DetailTarget) => void;
}) {
  const today = todayUTC();

  // Build per-day item list from all projects
  const dayItems = useMemo(() => {
    return days.map((day) => {
      const entries: Array<{
        id: string;
        title: string;
        kind: "task" | "subtask" | "experiment";
        projectName: string;
        projectColor: string;
        expTitle?: string;
        detail?: DetailTarget;
      }> = [];

      for (const p of projects) {
        for (const lane of p.lanes) {
          for (const it of lane.items) {
            if (it.type === "task") {
              if (it.start === day) {
                entries.push({
                  id: `t:${p.id}:${it.id}`,
                  title: it.title,
                  kind: "task",
                  projectName: p.name,
                  projectColor: p.color,
                  detail: { kind: "item", projectId: p.id, laneId: lane.id, itemId: it.id },
                });
              }
            } else if (it.type === "experiment") {
              const subTasks = (it as any).subTasks?.[day] ?? [];
              for (const st of subTasks) {
                entries.push({
                  id: `st:${p.id}:${it.id}:${st.id}`,
                  title: st.title,
                  kind: "subtask",
                  projectName: p.name,
                  projectColor: p.color,
                  expTitle: it.desc || undefined,
                  detail: { kind: "subtask", projectId: p.id, laneId: lane.id, experimentId: it.id, subTaskId: st.id, day },
                });
              }
            }
          }
        }
      }

      // Add plan recurring instances for this day
      for (const r of planRecurringInstances) {
        if (r.day === day) {
          const proj = projects.find((p) => p.id === r.projectId);
          entries.push({
            id: r.id,
            title: `↻ ${r.title}`,
            kind: "task" as const,
            projectName: proj?.name ?? "",
            projectColor: r.color,
          });
        }
      }

      return { day, entries };
    });
  }, [days, projects, planRecurringInstances]);

  const hasAnyItem = dayItems.some((d) => d.entries.length > 0);

  return (
    <div className="mt-4 min-h-0 flex-1 overflow-auto rounded-2xl border shadow-sm" style={{ background: darkMode ? '#2c2c2e' : 'white', borderColor: darkMode ? '#3a3a3c' : '#e4e4e7' }}>
      {!hasAnyItem ? (
        <div className="flex h-40 items-center justify-center text-sm" style={{ color: darkMode ? '#8e8e93' : '#a1a1aa' }}>
          No tasks planned in this period.
        </div>
      ) : (
        <div style={{ borderColor: darkMode ? '#3a3a3c' : '#f4f4f5' }}>
          {/* Project color legend */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b px-5 py-2.5" style={{ borderColor: darkMode ? '#3a3a3c' : '#f4f4f5' }}>
            {projects.map((p) => (
              <div key={p.id} className="flex items-center gap-1.5">
                <span style={{ width: 9, height: 9, borderRadius: '50%', background: p.color, flexShrink: 0, display: 'inline-block' }} />
                <span className="text-xs font-medium" style={{ color: darkMode ? '#a1a1a6' : '#71717a' }}>{p.name}</span>
              </div>
            ))}
          </div>

          {dayItems.map(({ day, entries }) => {
            const { weekday, md } = dayLabel(day);
            const wk = weekday.toLowerCase();
            const isWeekend = wk.startsWith("sat") || wk.startsWith("sun") || wk.startsWith("so") || wk.startsWith("ne");
            const isToday = day === today;

            return (
              <div key={day} className="flex gap-0" style={{ 
                background: isToday ? (darkMode ? 'rgba(56, 100, 180, 0.12)' : 'rgba(219, 234, 254, 0.4)') : 'transparent',
                borderBottom: `1px solid ${darkMode ? '#3a3a3c' : '#f4f4f5'}`,
              }}>
                {/* Date column */}
                {(() => {
                  const dt = parseDay(day);
                  const dayNum = dt.getUTCDate();
                  const monthNum = dt.getUTCMonth() + 1;
                  return (
                    <div className="w-20 flex-shrink-0 px-3 py-3 text-right" style={{ 
                      background: isToday ? (darkMode ? 'rgba(56, 100, 180, 0.2)' : '#eff6ff') : (darkMode ? 'rgba(255,255,255,0.03)' : 'rgba(250,250,250,0.6)'),
                    }}>
                      <div className="text-[11px] font-semibold" style={{ color: isToday ? (darkMode ? '#93bbfd' : '#3b82f6') : isWeekend ? (darkMode ? '#f87171' : '#f87171') : (darkMode ? '#8e8e93' : '#a1a1aa') }}>
                        {weekday}
                      </div>
                      <div className="text-2xl font-bold leading-tight" style={{ color: isToday ? (darkMode ? '#93bbfd' : '#2563eb') : isWeekend ? (darkMode ? '#f87171' : '#ef4444') : (darkMode ? '#e5e5e7' : '#18181b') }}>
                        {isToday ? (
                          <span className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-blue-500 text-white text-xl">
                            {dayNum}
                          </span>
                        ) : dayNum}
                      </div>
                      <div className="text-[10px]" style={{ color: isToday ? (darkMode ? '#60a5fa' : '#60a5fa') : (darkMode ? '#636366' : '#a1a1aa') }}>
                        {monthNum}/
                      </div>
                    </div>
                  );
                })()}

                {/* Items column */}
                <div className="flex-1 px-4 py-3">
                  {entries.length === 0 ? (
                    <div className="flex h-full min-h-[36px] items-center text-xs" style={{ color: darkMode ? '#48484a' : '#d4d4d8' }}>—</div>
                  ) : (
                    <div className="space-y-1">
                      {entries.map((entry) => (
                        <div
                          key={entry.id}
                          className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm"
                          style={{
                            opacity: completedTasks[entry.id] ? 0.5 : 1,
                          }}
                        >
                          {/* Project color dot */}
                          <span style={{ width: 10, height: 10, borderRadius: '50%', background: entry.projectColor, flexShrink: 0 }} />
                          <input
                            type="checkbox"
                            checked={!!completedTasks[entry.id]}
                            onChange={() => onToggleComplete?.(entry.id)}
                            style={{ accentColor: entry.projectColor, cursor: "pointer", flexShrink: 0, width: 15, height: 15 }}
                          />
                          <div className="flex-1 min-w-0">
                            <span
                              className="font-medium"
                              style={{
                                color: darkMode ? '#e5e5e7' : '#18181b',
                                textDecoration: completedTasks[entry.id] ? 'line-through' : 'none',
                              }}
                            >
                              {entry.title}
                            </span>
                            {entry.expTitle && (
                              <span className="ml-1.5 text-[10px]" style={{ color: darkMode ? '#8e8e93' : '#a1a1aa' }}>({entry.expTitle})</span>
                            )}
                          </div>
                          {entry.detail && (
                            <button
                              onClick={(e) => { e.stopPropagation(); onOpenDetail?.(entry.detail!); }}
                              style={{
                                flexShrink: 0,
                                width: 24,
                                height: 24,
                                borderRadius: 6,
                                border: `1px solid ${darkMode ? '#48484a' : '#e4e4e7'}`,
                                background: darkMode ? '#3a3a3c' : 'white',
                                color: darkMode ? '#a1a1a6' : '#71717a',
                                fontSize: 12,
                                cursor: "pointer",
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                              }}
                              title="Detail"
                            >⋯</button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------
// CalendarView component — defined OUTSIDE App
// ---------------------------------------------

function CalendarView({
  days,
  inbox,
  catalog,
  events,
  recurring,
  onCreateEvent,
  onMoveEvent,
  onDeleteEvent,
  onAddRecurring,
  onDeleteRecurring,
  onUpdateRecurring,
  recurringModal,
  setRecurringModal,
  calendarDaysLen,
  setCalendarDaysLen,
  sensors,
  resizeEvt,
  setResizeEvt,
  planRecurring = [],
  projects: calProjects = [],
  darkMode = false,
  onCreateNewTask,
}: {
  days: DayKey[];
  inbox: TaskRef[];
  catalog: TaskRef[];
  events: TimedEvent[];
  recurring: RecurringEvent[];
  onCreateEvent: (taskId: string, day: DayKey, startMin: number) => void;
  onMoveEvent: (id: string, patch: Partial<TimedEvent>) => void;
  onDeleteEvent: (id: string) => void;
  onAddRecurring: (r: RecurringEvent) => void;
  onDeleteRecurring: (rid: string) => void;
  onUpdateRecurring: (rid: string, patch: Partial<RecurringEvent>) => void;
  recurringModal: boolean;
  setRecurringModal: React.Dispatch<React.SetStateAction<boolean>>;
  calendarDaysLen: 3 | 5 | 7;
  setCalendarDaysLen: React.Dispatch<React.SetStateAction<3 | 5 | 7>>;
  sensors: any;
  resizeEvt: { id: string; pointerId: number } | null;
  setResizeEvt: React.Dispatch<React.SetStateAction<{ id: string; pointerId: number } | null>>;
  planRecurring?: PlanRecurring[];
  projects?: Project[];
  darkMode?: boolean;
  onCreateNewTask?: (projectId: string, title: string, day: DayKey, startMin: number, endMin: number) => void;
}) {
  const startHour = 6;
  const endHour = 24;
  const hourH = 44;
  // dayW computed from actual container width so columns fill full available space
  const calWrapRef = useRef<HTMLDivElement | null>(null);
  const [calW, setCalW] = useState<number>(0);
  useEffect(() => {
    const el = calWrapRef.current;
    if (!el) return;
    const update = () => {
      const w = el.getBoundingClientRect().width;
      if (w > 0) setCalW(w);
    };
    // Defer first measure so layout has settled
    const id = requestAnimationFrame(() => {
      const id2 = requestAnimationFrame(() => update());
      return id2;
    });
    const ro = new ResizeObserver(() => update());
    ro.observe(el);
    window.addEventListener("resize", update);
    return () => {
      cancelAnimationFrame(id);
      window.removeEventListener("resize", update);
      ro.disconnect();
    };
  }, [days.length]); // re-run when number of days changes
  const TIME_COL = 56; // px for the time label column
  const dayW = calW > 0 ? Math.max(80, (calW - TIME_COL) / Math.max(1, days.length)) : 180;
  const gridRef = useRef<HTMLDivElement | null>(null);

  const [editingRecId, setEditingRecId] = useState<string | null>(null);
  const [recForm, setRecForm] = useState<{ title: string; weekday: number; color: string; from: string; to: string }>({
    title: "",
    weekday: 1,
    color: "#0ea5e9",
    from: "09:00",
    to: "10:00",
  });
  // Editing a scheduled task event (inline title edit)
  const [selectedEvtId, setSelectedEvtId] = useState<string | null>(null);

  // Quick-create: click on empty calendar slot to create a new task
  const [quickCreate, setQuickCreate] = useState<{ day: DayKey; startMin: number; x: number; y: number } | null>(null);
  const [qcTitle, setQcTitle] = useState("");
  const [qcProjectId, setQcProjectId] = useState<string>("");

  const minToHHMM = (m: number) => {
    const h = String(Math.floor(m / 60)).padStart(2, "0");
    const mm = String(m % 60).padStart(2, "0");
    return `${h}:${mm}`;
  };

  const hhmmToMin = (s: string) => {
    const [h, mm] = s.split(":").map(Number);
    return h * 60 + mm;
  };

  const openNewRecurring = () => {
    setEditingRecId(null);
    setRecForm({ title: "", weekday: 1, color: "#0ea5e9", from: "09:00", to: "10:00" });
    setRecurringModal(true);
  };

  const openEditRecurring = (rid: string) => {
    const r = recurring.find((x) => x.id === rid);
    if (!r) return;
    setEditingRecId(rid);
    setRecForm({
      title: r.title,
      weekday: r.weekday,
      color: r.color,
      from: minToHHMM(r.startMin),
      to: minToHHMM(r.endMin),
    });
    setRecurringModal(true);
  };

  const byId = useMemo(() => {
    const m = new Map<string, TaskRef>();
    for (const t of catalog) m.set(t.id, t);
    return m;
  }, [catalog]);

  const allTaskLookup = (id: string): TaskRef | null => byId.get(id) ?? null;

  function DayDrop({ day }: { day: DayKey }) {
    const { setNodeRef, isOver } = useDroppable({ id: `daycol:${day}` });
    const idx = days.indexOf(day);
    const isTodayCol = day === todayUTC();
    const wkd = new Date(day + "T00:00:00Z").getUTCDay();
    const isWeekendCol = wkd === 0 || wkd === 6;
    return (
      <div
        ref={setNodeRef}
        className={"absolute inset-y-0 " + (isOver ? (darkMode ? "bg-zinc-700/30" : "bg-zinc-100") : "")}
        style={{ 
          left: TIME_COL + idx * dayW, width: dayW,
          background: isOver ? undefined : isTodayCol ? (darkMode ? 'rgba(56,100,180,0.12)' : 'rgba(219,234,254,0.4)') : isWeekendCol ? (darkMode ? 'rgba(160,60,60,0.08)' : 'rgba(254,202,202,0.3)') : 'transparent',
        }}
      />
    );
  }

  function EventBox({ ev }: { ev: TimedEvent | (TimedEvent & { isRecurring: true; recurringId: string; color: string; title: string }) }) {
    const isRec = (ev as any).isRecurring;
    const task = isRec ? null : allTaskLookup(ev.id);
    const title = isRec ? (ev as any).title : (task?.title ?? ev.id);
    const color = isRec ? (ev as any).color : (task?.color ?? "#64748b");

    const dayIdx = days.indexOf(ev.day);
    if (dayIdx < 0) return null;

    // Overlap layout
    const layout = overlapLayouts.get(ev.id) ?? { col: 0, totalCols: 1 };
    const colW = (dayW - 12) / layout.totalCols;
    const left = TIME_COL + dayIdx * dayW + 6 + layout.col * colW;
    const width = colW - 2;

    const top = (ev.startMin / 60 - startHour) * hourH;
    const height = Math.max(18, ((ev.endMin - ev.startMin) / 60) * hourH);

    const isSelected = selectedEvtId === ev.id;
    const [draftTitle, setDraftTitle] = useState(title);
    useEffect(() => { setDraftTitle(title); }, [title]);

    const draggable = useDraggable({ id: `calevt:${ev.id}`, disabled: isRec || isSelected });
    const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, isDragging } = draggable;

    const dragStyle: React.CSSProperties = transform
      ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
      : undefined;

    const commitTitle = () => {
      if (!isRec && draftTitle.trim() && draftTitle.trim() !== title) {
        window.dispatchEvent(new CustomEvent("cal-rename-task", { detail: { id: ev.id, title: draftTitle.trim() } }));
      }
    };

    return (
      <div
        ref={setNodeRef}
        className={"absolute pointer-events-auto " + (isDragging ? "opacity-60" : "")}
        style={{ left, top: 44 + top, width, height, ...dragStyle, touchAction: "none", zIndex: isSelected ? 30 : 10 }}
      >
        <div
          ref={setActivatorNodeRef}
          {...(isRec || isSelected ? {} : attributes)}
          {...(isRec || isSelected ? {} : listeners)}
          className={
            "relative h-full rounded-lg px-2 py-1 text-xs font-semibold text-white shadow-sm overflow-hidden border " +
            (isRec ? "cursor-default" : isSelected ? "cursor-default ring-2 ring-white/60" : "cursor-grab active:cursor-grabbing")
          }
          style={{ background: color, borderColor: 'rgba(0,0,0,0.25)' }}
          title={!isSelected ? title : undefined}
          onClick={(e) => {
            e.stopPropagation();
            if (isRec) { openEditRecurring((ev as any).recurringId); return; }
            setSelectedEvtId(isSelected ? null : ev.id);
          }}
        >
          {isSelected && !isRec ? (
            <input
              autoFocus
              className="w-full bg-white/20 rounded px-1 text-xs font-semibold text-white placeholder-white/60 outline-none border border-white/40 focus:border-white/80"
              value={draftTitle}
              onChange={(e) => setDraftTitle(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); commitTitle(); setSelectedEvtId(null); }
                if (e.key === "Escape") { setDraftTitle(title); setSelectedEvtId(null); }
              }}
              onBlur={() => commitTitle()}
            />
          ) : (
            <div className="truncate pr-5">{title}</div>
          )}

          {!isSelected && !isRec && (
            <button
              className="absolute right-1 top-1 h-5 w-5 rounded bg-white/20 text-[10px] hover:bg-white/30"
              onClick={(e) => { e.stopPropagation(); onDeleteEvent(ev.id); }}
              title="Remove timed event"
            >✕</button>
          )}

          {!isRec && !isSelected && (
            <div
              className="absolute bottom-0 left-0 right-0 h-3 cursor-ns-resize"
              title="Change end time"
              onPointerDown={(e) => {
                e.stopPropagation(); e.preventDefault();
                if (e.button !== 0) return;
                (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
                setResizeEvt({ id: ev.id, pointerId: e.pointerId });
              }}
            />
          )}

          {isRec && !isSelected && (
            <button
              className="absolute bottom-1 right-2 rounded bg-white/20 px-1 text-[10px] font-semibold text-white/90 hover:bg-white/30"
              title="Edit recurring"
              onClick={(e) => { e.stopPropagation(); openEditRecurring((ev as any).recurringId); }}
            >↻</button>
          )}
        </div>

        {/* Popover with Detail, Save, Delete, Remove */}
        {isSelected && !isRec && task && (
          <div
            className="absolute left-0 top-full z-[300] mt-1 w-[240px] rounded-xl border bg-white p-2 shadow-lg"
            style={{ borderColor: darkMode ? '#3a3a3c' : '#e4e4e7', background: darkMode ? '#2c2c2e' : 'white' }}
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-1">
              <button
                className="h-7 rounded-lg border px-2 text-xs hover:bg-zinc-50"
                style={{ borderColor: darkMode ? '#48484a' : '#e4e4e7', color: darkMode ? '#e5e5e7' : '#18181b', background: darkMode ? '#3a3a3c' : 'white' }}
                onClick={() => {
                  commitTitle();
                  // Open detail panel via global function
                  if (task.meta && typeof (window as any).__openDetail === "function") {
                    const m = task.meta as any;
                    if (m.projectId && m.itemId) {
                      // find laneId
                      const proj = calProjects.find((p: any) => p.id === m.projectId);
                      const lane = proj?.lanes?.find((l: any) => l.items.some((it: any) => it.id === m.itemId));
                      if (lane) {
                        (window as any).__openDetail({ kind: "item", projectId: m.projectId, laneId: lane.id, itemId: m.itemId });
                      }
                    }
                  }
                  setSelectedEvtId(null);
                }}
                title="Notes & checklist"
              >📝 Detail</button>
              <button
                className="h-7 rounded-lg border px-2 text-xs hover:bg-zinc-50"
                style={{ borderColor: darkMode ? '#48484a' : '#e4e4e7', color: darkMode ? '#e5e5e7' : '#18181b', background: darkMode ? '#3a3a3c' : 'white' }}
                onClick={() => { onDeleteEvent(ev.id); setSelectedEvtId(null); }}
                title="Remove from calendar only"
              >Unschedule</button>
              <button
                className="h-7 rounded-lg border px-2 text-xs text-red-500 hover:bg-red-50"
                style={{ borderColor: darkMode ? '#48484a' : '#e4e4e7', background: darkMode ? '#3a3a3c' : 'white' }}
                onClick={() => {
                  // Delete timed event AND the task from plan
                  onDeleteEvent(ev.id);
                  if (task.meta) {
                    const m = task.meta as any;
                    if (m.projectId && m.itemId) {
                      window.dispatchEvent(new CustomEvent("cal-delete-task", { detail: { projectId: m.projectId, itemId: m.itemId } }));
                    }
                  }
                  setSelectedEvtId(null);
                }}
                title="Delete task permanently"
              >Delete</button>
            </div>
          </div>
        )}
      </div>
    );
  }

  useEffect(() => {
    if (!resizeEvt) return;
    const pid = resizeEvt.pointerId;
    const move = (e: PointerEvent) => {
      if (e.pointerId !== pid) return;
      const rect = gridRef.current?.getBoundingClientRect();
      if (!rect) return;
      const y = e.clientY - rect.top - 44;
      const minutesFromStart = Math.max(0, Math.min((endHour - startHour) * 60, Math.round((y / hourH) * 60 / 15) * 15));
      const ev = events.find((x) => x.id === resizeEvt.id);
      if (!ev) return;
      const endMin = Math.max(ev.startMin + 15, startHour * 60 + minutesFromStart);
      onMoveEvent(ev.id, { endMin: Math.min(endHour * 60, endMin) });
    };
    const stop = (e: PointerEvent) => {
      if (e.pointerId !== pid) return;
      setResizeEvt(null);
    };
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", stop, true);
    window.addEventListener("pointercancel", stop, true);
    return () => {
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", stop, true);
      window.removeEventListener("pointercancel", stop, true);
    };
  }, [resizeEvt, events]);

  const collisionDetection = (args: any) => {
    const within = pointerWithin(args);
    return within.length ? within : closestCenter(args);
  };

  function onCalDragEnd(ev: DragEndEvent) {
    const activeId = String(ev.active.id);
    const overId = ev.over ? String(ev.over.id) : null;

    if (activeId.startsWith("inbox:") && overId && overId.startsWith("daycol:")) {
      const taskId = activeId.slice("inbox:".length);
      const day = overId.slice("daycol:".length) as DayKey;
      // Compute time from drop position
      const rect = gridRef.current?.getBoundingClientRect();
      let dropStartMin = 9 * 60; // fallback
      if (rect && ev.activatorEvent) {
        const clientY = (ev.activatorEvent as PointerEvent).clientY + (ev.delta?.y ?? 0);
        const y = clientY - rect.top - 44;
        const raw = Math.round((y / hourH) * 60 / 15) * 15 + startHour * 60;
        dropStartMin = Math.max(startHour * 60, Math.min(endHour * 60 - 60, raw));
      }
      onCreateEvent(taskId, day, dropStartMin);
      return;
    }

    if (activeId.startsWith("calevt:")) {
      const id = activeId.slice("calevt:".length);
      const existing = events.find((e) => e.id === id);
      if (!existing) return;

      const deltaY = (ev.delta?.y ?? 0);
      const minutesDelta = Math.round((deltaY / hourH) * 60 / 15) * 15;
      let newStart = existing.startMin + minutesDelta;
      newStart = Math.max(startHour * 60, Math.min(endHour * 60 - 15, newStart));
      let newEnd = newStart + (existing.endMin - existing.startMin);
      if (newEnd > endHour * 60) {
        newEnd = endHour * 60;
        newStart = newEnd - (existing.endMin - existing.startMin);
      }

      const patch: Partial<TimedEvent> = { startMin: newStart, endMin: newEnd };
      if (overId && overId.startsWith("daycol:")) {
        patch.day = overId.slice("daycol:".length) as DayKey;
      }
      onMoveEvent(id, patch);
      return;
    }
  }

  const inboxByDay = useMemo(() => {
    const m: Record<string, TaskRef[]> = {};
    for (const d of days) m[d] = [];
    for (const t of inbox) {
      if (!m[t.day]) m[t.day] = [];
      m[t.day].push(t);
    }
    for (const d of Object.keys(m)) {
      m[d] = m[d].slice().sort((a, b) => a.title.localeCompare(b.title));
    }
    return m;
  }, [inbox, days]);

  const recurringInstances = useMemo(() => {
    const out: Array<TimedEvent & { recurringId: string; isRecurring: true; color: string; title: string }> = [];
    // Calendar recurring events
    for (const r of recurring) {
      for (const day of days) {
        const dt = parseDay(day);
        if (dt.getUTCDay() !== r.weekday) continue;
        out.push({
          id: `rec:${r.id}:${day}`,
          day,
          startMin: r.startMin,
          endMin: r.endMin,
          recurringId: r.id,
          isRecurring: true,
          color: r.color,
          title: r.title,
        });
      }
    }
    // Plan recurring events that have a time in their title — show in calendar too
    for (const r of planRecurring) {
      const tr = parseTimeRange(r.title);
      if (!tr) continue; // no time → skip
      const proj = calProjects.find((p) => p.id === r.projectId);
      const color = proj?.color ?? "#64748b";
      // Strip the time part for display title
      const displayTitle = r.title.replace(/\d{1,2}[:.]\d{2}\s*[-–]\s*\d{1,2}[:.]\d{2}/, "").trim();
      for (const day of days) {
        const dt = parseDay(day);
        if (dt.getUTCDay() !== r.weekday) continue;
        out.push({
          id: `planrec:${r.id}:${day}`,
          day,
          startMin: tr.startMin,
          endMin: tr.endMin,
          recurringId: r.id,
          isRecurring: true,
          color,
          title: `↻ ${displayTitle || r.title}`,
        });
      }
    }
    return out;
  }, [recurring, planRecurring, days, calProjects]);

  const hours = Array.from({ length: endHour - startHour + 1 }, (_, i) => startHour + i);

  // Compute non-overlapping columns for events per day (Google Calendar style)
  // Returns Map<eventId, { col: number, totalCols: number }>
  const overlapLayouts = useMemo(() => {
    const result = new Map<string, { col: number; totalCols: number }>();
    const allEvts = [...recurringInstances, ...events] as Array<TimedEvent & { isRecurring?: boolean }>;

    for (const day of days) {
      const dayEvts = allEvts.filter((e) => e.day === day);
      // Sort by startMin then endMin
      const sorted = dayEvts.slice().sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin);

      // Greedy column assignment
      const cols: number[] = []; // cols[i] = end time of last event in column i
      const assignments: number[] = [];

      for (const ev of sorted) {
        let placed = false;
        for (let c = 0; c < cols.length; c++) {
          if (cols[c] <= ev.startMin) {
            cols[c] = ev.endMin;
            assignments.push(c);
            placed = true;
            break;
          }
        }
        if (!placed) {
          assignments.push(cols.length);
          cols.push(ev.endMin);
        }
      }

      const totalCols = cols.length || 1;
      sorted.forEach((ev, i) => {
        result.set(ev.id, { col: assignments[i], totalCols });
      });
    }

    return result;
  }, [events, recurringInstances, days]);

  return (
    <div className="mt-6 rounded-2xl border p-4 shadow-sm" style={{ background: darkMode ? '#2c2c2e' : 'white', borderColor: darkMode ? '#3a3a3c' : '#e4e4e7' }}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="text-sm font-semibold" style={{ color: darkMode ? '#e5e5e7' : '#18181b' }}>Calendar</div>
          <button
            className="rounded-lg border px-2 py-1 text-xs shadow-sm"
            style={{ background: darkMode ? '#3a3a3c' : 'white', borderColor: darkMode ? '#48484a' : '#e4e4e7', color: darkMode ? '#e5e5e7' : '#18181b' }}
            onClick={() => openNewRecurring()}
            title="Add recurring block"
          >
            + opakování
          </button>
        </div>
        <div className="flex items-center gap-2">
          <div className="text-xs" style={{ color: darkMode ? '#a1a1a6' : '#52525b' }}>Dny:</div>
          <div className="flex items-center gap-1 rounded-lg border p-1" style={{ background: darkMode ? '#2c2c2e' : 'white', borderColor: darkMode ? '#3a3a3c' : '#e4e4e7' }}>
            {([3, 5, 7] as const).map((n) => (
              <button
                key={n}
                className="rounded-md px-2 py-1 text-xs hover:opacity-80"
                style={calendarDaysLen === n ? { background: darkMode ? '#e5e5e7' : '#18181b', color: darkMode ? '#1c1c1e' : 'white' } : { color: darkMode ? '#e5e5e7' : '#18181b' }}
                onClick={() => setCalendarDaysLen(n)}
              >
                {n}
              </button>
            ))}
          </div>
        </div>
      </div>

      <DndContext sensors={sensors} collisionDetection={collisionDetection} onDragEnd={onCalDragEnd}>
        <div className="mt-4 overflow-x-auto">
          <div ref={calWrapRef} style={{ width: "100%", minWidth: 56 + days.length * 80 }}>
            {/* Per-day inbox row */}
            <div className="flex" style={{ width: "100%" }}>
              <div className="flex-shrink-0" style={{ width: TIME_COL }} />
              {days.map((d) => (
                <div key={d} className="border" style={{ width: dayW, flexShrink: 0, background: darkMode ? '#1c1c1e' : '#fafafa', borderColor: darkMode ? '#3a3a3c' : '#e4e4e7' }}>
                  <div className="px-2 py-1">
                    <div className="flex flex-wrap gap-1">
                      {(inboxByDay[d] ?? []).length === 0 ? (
                        <span className="text-[11px]" style={{ color: darkMode ? '#636366' : '#71717a' }}>&nbsp;</span>
                      ) : (
                        (inboxByDay[d] ?? []).map((t) => (
                          <Draggable key={t.id} id={`inbox:${t.id}`}>
                            <div
                              className="cursor-grab active:cursor-grabbing rounded-md px-2 py-0.5 text-[11px] font-semibold text-white shadow-sm"
                              style={{ background: t.color }}
                              title={t.title}
                            >
                              <div className="truncate max-w-[150px]">{t.title}</div>
                            </div>
                          </Draggable>
                        ))
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {/* Calendar grid */}
            <div
              ref={gridRef}
              className="relative"
              style={{ width: "100%", height: 44 + (endHour - startHour) * hourH }}
            >
              {/* Header */}
              <div className="absolute left-0 top-0 flex" style={{ height: 44, width: "100%" }}>
                <div className="border flex-shrink-0" style={{ width: TIME_COL, borderColor: darkMode ? '#3a3a3c' : '#e4e4e7', background: darkMode ? '#2c2c2e' : 'white' }} />
                {days.map((d) => {
                  const { weekday, md } = dayLabel(d);
                  const wk = weekday.toLowerCase();
                  const isWeekend = wk.startsWith("sat") || wk.startsWith("sun") || wk.startsWith("so") || wk.startsWith("ne");
                  const isToday = d === todayUTC();
                  return (
                    <div key={d} className="border px-2 py-2 text-center" style={{ 
                      width: dayW, flexShrink: 0, 
                      borderColor: darkMode ? '#3a3a3c' : '#e4e4e7',
                      background: isToday ? (darkMode ? 'rgba(56,100,180,0.2)' : '#eff6ff') : isWeekend ? (darkMode ? 'rgba(160,60,60,0.12)' : 'rgba(254,226,226,0.6)') : (darkMode ? '#2c2c2e' : 'white'),
                    }}>
                      <div className="text-xs font-medium" style={{ color: isToday ? (darkMode ? '#93bbfd' : '#2563eb') : isWeekend ? (darkMode ? '#f87171' : '#dc2626') : (darkMode ? '#a1a1a6' : '#3f3f46'), fontWeight: isToday ? 700 : 500 }}>{weekday}</div>
                      <div className="text-xs" style={{ color: isToday ? (darkMode ? '#60a5fa' : '#3b82f6') : isWeekend ? (darkMode ? '#f87171' : '#ef4444') : (darkMode ? '#8e8e93' : '#71717a') }}>
                        {isToday ? <span className="inline-block rounded-full bg-blue-500 text-white px-1.5">{md}</span> : md}
                      </div>
                    </div>
                  );
                })}
              </div>

              {days.map((d) => <DayDrop key={d} day={d} />)}

              {hours.map((h, idx) => {
                if (h === endHour) return null;
                const top = 44 + idx * hourH;
                return (
                  <React.Fragment key={h}>
                    <div className="absolute left-0" style={{ top, width: TIME_COL, height: 0, borderTop: `1px solid ${darkMode ? '#3a3a3c' : '#e4e4e7'}` }} />
                    <div className="absolute left-0 px-2 text-[11px]" style={{ top: top + 2, width: TIME_COL, color: darkMode ? '#8e8e93' : '#52525b' }}>
                      {String(h).padStart(2, "0")}:00
                    </div>
                    <div className="absolute" style={{ top, left: TIME_COL, right: 0, borderTop: `1px solid ${darkMode ? '#3a3a3c' : '#e4e4e7'}` }} />
                  </React.Fragment>
                );
              })}

              {days.map((_, i) => (
                <div key={i} className="absolute top-[44px] bottom-0" style={{ left: TIME_COL + i * dayW, borderLeft: `1px solid ${darkMode ? '#3a3a3c' : '#e4e4e7'}` }} />
              ))}

              {/* Click-to-create overlay: clicking on empty space creates a new task */}
              {days.map((d, i) => (
                <div
                  key={`click-${d}`}
                  className="absolute cursor-pointer"
                  style={{ left: TIME_COL + i * dayW, top: 44, width: dayW, height: (endHour - startHour) * hourH }}
                  onClick={(e) => {
                    // Only trigger if clicking directly on this overlay (not on an event)
                    if (e.target !== e.currentTarget) return;
                    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
                    const y = e.clientY - rect.top;
                    const rawMin = Math.round((y / hourH) * 60 / 15) * 15 + startHour * 60;
                    const startMin = Math.max(startHour * 60, Math.min(endHour * 60 - 60, rawMin));
                    setQcTitle("");
                    setQcProjectId(calProjects[0]?.id ?? "");
                    setQuickCreate({ day: d, startMin, x: e.clientX, y: e.clientY });
                  }}
                />
              ))}

              {[...recurringInstances, ...events].map((ev) => (
                <EventBox key={ev.id} ev={ev as any} />
              ))}
            </div>
          </div>
        </div>
      </DndContext>

      {recurringModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 p-4"
          onClick={() => setRecurringModal(false)}
        >
          <div
            className="w-full max-w-md rounded-2xl border p-4 shadow-xl"
            style={{ background: darkMode ? '#2c2c2e' : 'white', borderColor: darkMode ? '#3a3a3c' : '#e4e4e7', color: darkMode ? '#e5e5e7' : '#18181b' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between">
              <div className="text-sm font-semibold">{editingRecId ? "Edit recurring" : "New recurring"}</div>
              <button
                className="h-8 w-8 rounded-full border shadow-sm"
                style={{ background: darkMode ? '#3a3a3c' : 'white', borderColor: darkMode ? '#48484a' : '#e4e4e7', color: darkMode ? '#e5e5e7' : '#18181b' }}
                onClick={() => setRecurringModal(false)}
                title="Close"
              >
                ✕
              </button>
            </div>

            <div className="mt-3 space-y-3">
              <div>
                <div className="mb-1 text-xs" style={{ color: darkMode ? '#a1a1a6' : '#52525b' }}>Name</div>
                <input
                  className="h-9 w-full rounded-lg border px-3 text-sm outline-none focus:ring-2 focus:ring-zinc-300"
                  style={{ background: darkMode ? '#1c1c1e' : 'white', borderColor: darkMode ? '#3a3a3c' : '#e4e4e7', color: darkMode ? '#e5e5e7' : '#18181b' }}
                  placeholder="e.g. meeting / seminar"
                  value={recForm.title}
                  onChange={(e) => setRecForm((p) => ({ ...p, title: e.target.value }))}
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="mb-1 text-xs" style={{ color: darkMode ? '#a1a1a6' : '#52525b' }}>Weekday</div>
                  <select
                    className="h-9 w-full rounded-lg border px-3 text-sm"
                    style={{ background: darkMode ? '#1c1c1e' : 'white', borderColor: darkMode ? '#3a3a3c' : '#e4e4e7', color: darkMode ? '#e5e5e7' : '#18181b' }}
                    value={recForm.weekday}
                    onChange={(e) => setRecForm((p) => ({ ...p, weekday: Number(e.target.value) }))}
                  >
                    <option value={1}>Mon</option>
                    <option value={2}>Tue</option>
                    <option value={3}>Wed</option>
                    <option value={4}>Thu</option>
                    <option value={5}>Fri</option>
                    <option value={6}>Sat</option>
                    <option value={0}>Sun</option>
                  </select>
                </div>
                <div>
                  <div className="mb-1 text-xs" style={{ color: darkMode ? '#a1a1a6' : '#52525b' }}>Color</div>
                  <input
                    type="color"
                    className="h-9 w-full rounded-lg border px-2"
                    style={{ borderColor: darkMode ? '#3a3a3c' : '#e4e4e7' }}
                    value={recForm.color}
                    onChange={(e) => setRecForm((p) => ({ ...p, color: e.target.value }))}
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="mb-1 text-xs" style={{ color: darkMode ? '#a1a1a6' : '#52525b' }}>From</div>
                  <input
                    type="time"
                    className="h-9 w-full rounded-lg border px-3 text-sm"
                    style={{ background: darkMode ? '#1c1c1e' : 'white', borderColor: darkMode ? '#3a3a3c' : '#e4e4e7', color: darkMode ? '#e5e5e7' : '#18181b' }}
                    value={recForm.from}
                    onChange={(e) => setRecForm((p) => ({ ...p, from: e.target.value }))}
                  />
                </div>
                <div>
                  <div className="mb-1 text-xs" style={{ color: darkMode ? '#a1a1a6' : '#52525b' }}>To</div>
                  <input
                    type="time"
                    className="h-9 w-full rounded-lg border px-3 text-sm"
                    style={{ background: darkMode ? '#1c1c1e' : 'white', borderColor: darkMode ? '#3a3a3c' : '#e4e4e7', color: darkMode ? '#e5e5e7' : '#18181b' }}
                    value={recForm.to}
                    onChange={(e) => setRecForm((p) => ({ ...p, to: e.target.value }))}
                  />
                </div>
              </div>

              <div className="flex items-center justify-between gap-2">
                <button
                  className="h-9 rounded-lg border px-3 text-sm"
                  style={{ background: darkMode ? '#3a3a3c' : 'white', borderColor: darkMode ? '#48484a' : '#e4e4e7', color: darkMode ? '#e5e5e7' : '#18181b' }}
                  onClick={() => setRecurringModal(false)}
                >
                  Cancel
                </button>
                <div className="flex items-center gap-2">
                  {editingRecId && (
                    <button
                      className="h-9 rounded-lg border px-3 text-sm"
                      style={{ background: darkMode ? '#3a3a3c' : 'white', borderColor: darkMode ? '#48484a' : '#e4e4e7', color: darkMode ? '#e5e5e7' : '#18181b' }}
                      onClick={() => { onDeleteRecurring(editingRecId); setRecurringModal(false); }}
                      title="Delete recurring"
                    >
                      Delete
                    </button>
                  )}
                  <button
                    className="h-9 rounded-lg px-3 text-sm font-semibold text-white"
                    style={{ background: darkMode ? '#e5e5e7' : '#18181b', color: darkMode ? '#1c1c1e' : 'white' }}
                    onClick={() => {
                      const title = recForm.title.trim();
                      if (!title) return;
                      const startMin = hhmmToMin(recForm.from);
                      const endMin = Math.max(startMin + 15, hhmmToMin(recForm.to));
                      if (editingRecId) {
                        onUpdateRecurring(editingRecId, { title, weekday: recForm.weekday, color: recForm.color, startMin, endMin });
                      } else {
                        onAddRecurring({ id: crypto.randomUUID(), title, weekday: recForm.weekday, color: recForm.color, startMin, endMin });
                      }
                      setRecurringModal(false);
                    }}
                  >
                    Save
                  </button>
                </div>
              </div>

              <div className="text-[11px]" style={{ color: darkMode ? '#8e8e93' : '#52525b' }}>
                Opakování je samostatný blok. Klikni na blok nebo ↻ pro úpravu.
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Quick-create popover — click on empty calendar slot */}
      {quickCreate && onCreateNewTask && calProjects.length > 0 && (
        <div
          className="fixed inset-0 z-50"
          onClick={() => setQuickCreate(null)}
        >
          <div
            className="absolute rounded-xl border p-3 shadow-xl"
            style={{
              left: Math.min(quickCreate.x, window.innerWidth - 300),
              top: Math.min(quickCreate.y, window.innerHeight - 200),
              width: 280,
              background: darkMode ? '#2c2c2e' : 'white',
              borderColor: darkMode ? '#48484a' : '#e4e4e7',
              color: darkMode ? '#e5e5e7' : '#18181b',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-xs font-semibold mb-2" style={{ color: darkMode ? '#a1a1a6' : '#71717a' }}>
              New task — {dayLabel(quickCreate.day).weekday} {dayLabel(quickCreate.day).md} · {String(Math.floor(quickCreate.startMin / 60)).padStart(2, "0")}:{String(quickCreate.startMin % 60).padStart(2, "0")}
            </div>
            <input
              autoFocus
              className="h-9 w-full rounded-lg border px-3 text-sm outline-none focus:ring-2 focus:ring-blue-300"
              style={{ background: darkMode ? '#1c1c1e' : 'white', borderColor: darkMode ? '#3a3a3c' : '#e4e4e7', color: darkMode ? '#e5e5e7' : '#18181b' }}
              placeholder="task name…"
              value={qcTitle}
              onChange={(e) => setQcTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && qcTitle.trim()) {
                  e.preventDefault();
                  const pid = qcProjectId || calProjects[0]?.id;
                  if (pid) {
                    onCreateNewTask(pid, qcTitle.trim(), quickCreate.day, quickCreate.startMin, quickCreate.startMin + 60);
                  }
                  setQuickCreate(null);
                }
                if (e.key === "Escape") setQuickCreate(null);
              }}
            />
            <div className="mt-2 flex items-center gap-2">
              <select
                className="h-8 flex-1 rounded-lg border px-2 text-xs"
                style={{ background: darkMode ? '#1c1c1e' : 'white', borderColor: darkMode ? '#3a3a3c' : '#e4e4e7', color: darkMode ? '#e5e5e7' : '#18181b' }}
                value={qcProjectId || calProjects[0]?.id}
                onChange={(e) => setQcProjectId(e.target.value)}
              >
                {calProjects.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
              <button
                className="h-8 rounded-lg px-3 text-xs font-semibold text-white"
                style={{ background: calProjects.find((p) => p.id === (qcProjectId || calProjects[0]?.id))?.color ?? '#18181b' }}
                onClick={() => {
                  if (!qcTitle.trim()) return;
                  const pid = qcProjectId || calProjects[0]?.id;
                  if (pid) {
                    onCreateNewTask(pid, qcTitle.trim(), quickCreate.day, quickCreate.startMin, quickCreate.startMin + 60);
                  }
                  setQuickCreate(null);
                }}
              >
                Add
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------
// DetailPanel — right-side sliding panel for notes + checklist
// ---------------------------------------------

function DetailPanel({
  target,
  projects,
  onClose,
  onUpdateProjects,
  darkMode = false,
  inbox = [],
  onUpdateInbox,
}: {
  target: DetailTarget;
  projects: Project[];
  onClose: () => void;
  onUpdateProjects: (updater: (prev: Project[]) => Project[]) => void;
  darkMode?: boolean;
  inbox?: InboxTask[];
  onUpdateInbox?: (updater: (prev: InboxTask[]) => InboxTask[]) => void;
}) {
  // Close on Escape — must be before any conditional returns
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  if (!target) return null;

  let title = "";
  let notes = "";
  let checklist: CheckItem[] = [];
  let itemLabel = "";
  let projColor = "#64748b";
  let projName = "";

  if (target.kind === "inbox") {
    const t = inbox.find((x) => x.id === target.inboxId);
    if (!t) return null;
    const proj = projects.find((p) => p.id === t.projectId);
    title = t.title;
    notes = t.notes ?? "";
    checklist = t.checklist ?? [];
    itemLabel = "Inbox";
    projColor = proj?.color ?? "#64748b";
    projName = proj?.name ?? "";
  } else if (target.kind === "project") {
    const proj = projects.find((p) => p.id === target.projectId);
    if (!proj) return null;
    title = proj.name;
    notes = proj.notes ?? "";
    checklist = proj.checklist ?? [];
    itemLabel = "Project";
    projColor = proj.color;
    projName = proj.name;
  } else {
    // Resolve the item from projects
    const proj = projects.find((p) => p.id === target.projectId);
    if (!proj) return null;
    const lane = proj.lanes.find((l) => l.id === target.laneId);
    if (!lane) return null;
    projColor = proj.color;
    projName = proj.name;

    if (target.kind === "item") {
      // Search all lanes for the item (it may have been repacked into a different lane)
      let foundItem: LaneItem | null = null;
      let foundLane: Lane | null = null;
      for (const l of proj.lanes) {
        const it = l.items.find((x) => x.id === target.itemId);
        if (it) { foundItem = it; foundLane = l; break; }
      }
      if (!foundItem || !foundLane) return null;
      title = foundItem.type === "task" ? foundItem.title : (foundItem.desc || foundItem.title || "Experiment");
      notes = foundItem.notes ?? "";
      checklist = foundItem.checklist ?? [];
      itemLabel = foundItem.type === "task" ? "Task" : "Experiment";
    } else {
      const exp = lane.items.find((it) => it.id === target.experimentId);
      if (!exp || exp.type !== "experiment") return null;
      const sts = exp.subTasks[target.day] ?? [];
      const st = sts.find((s) => s.id === target.subTaskId);
      if (!st) return null;
      title = st.title;
      notes = st.notes ?? "";
      checklist = st.checklist ?? [];
      itemLabel = "Subtask";
    }
  }

  const updateField = (field: "notes" | "checklist", value: any) => {
    if (target.kind === "inbox") {
      onUpdateInbox?.((prev) => prev.map((t) => t.id === target.inboxId ? { ...t, [field]: value } : t));
      return;
    }
    if (target.kind === "project") {
      onUpdateProjects((prev) => prev.map((p) => p.id === target.projectId ? { ...p, [field]: value } : p));
      return;
    }
    onUpdateProjects((prev) => {
      const next = structuredClone(prev) as Project[];
      const p = next.find((pp) => pp.id === target.projectId);
      if (!p) return prev;

      if (target.kind === "item") {
        // Search all lanes for the item
        for (const l of p.lanes) {
          const it = l.items.find((x) => x.id === target.itemId);
          if (it) {
            if (field === "notes") (it as any).notes = value;
            else (it as any).checklist = value;
            return next;
          }
        }
        return prev;
      } else {
        // Search all lanes for the experiment
        for (const l of p.lanes) {
          const exp = l.items.find((x) => x.id === target.experimentId);
          if (!exp || exp.type !== "experiment") continue;
          const sts = exp.subTasks[target.day];
          if (!sts) continue;
          const st = sts.find((s) => s.id === target.subTaskId);
          if (!st) continue;
          if (field === "notes") st.notes = value;
          else st.checklist = value;
          return next;
        }
        return prev;
      }
    });
  };

  const setNotes = (v: string) => updateField("notes", v);
  const setChecklist = (v: CheckItem[]) => updateField("checklist", v);

  const addCheckItem = () => {
    setChecklist([...checklist, { id: `ci_${crypto.randomUUID()}`, text: "", done: false }]);
  };
  const toggleCheckItem = (id: string) => {
    setChecklist(checklist.map((c) => c.id === id ? { ...c, done: !c.done } : c));
  };
  const updateCheckText = (id: string, text: string) => {
    setChecklist(checklist.map((c) => c.id === id ? { ...c, text } : c));
  };
  const deleteCheckItem = (id: string) => {
    setChecklist(checklist.filter((c) => c.id !== id));
  };

  const bg = darkMode ? '#2c2c2e' : 'white';
  const border = darkMode ? '#3a3a3c' : '#e4e4e7';
  const clr = darkMode ? '#e5e5e7' : '#18181b';
  const textSec = darkMode ? '#a1a1a6' : '#71717a';
  const inputBg = darkMode ? '#1c1c1e' : '#fafafa';

  const doneCount = checklist.filter((c) => c.done).length;
  const totalCount = checklist.length;

  return (
    <>
    {/* Backdrop */}
    <div
      className="fixed inset-0 z-40"
      style={{ background: "rgba(0,0,0,0.08)" }}
      onClick={onClose}
    />
    <div
      className="fixed right-0 top-0 z-50 h-full shadow-2xl"
      style={{ width: 360, background: bg, borderLeft: `1px solid ${border}`, color: clr, display: "flex", flexDirection: "column" }}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {/* Header */}
      <div style={{ padding: "16px 16px 12px", borderBottom: `1px solid ${border}`, flexShrink: 0 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 10, fontWeight: 600, color: textSec, marginBottom: 2, textTransform: "uppercase", letterSpacing: "0.05em" }}>{itemLabel}</div>
            <div style={{ fontSize: 14, fontWeight: 700, lineHeight: 1.3, wordBreak: "break-word" }}>{title}</div>
          </div>
          <button
            onClick={onClose}
            style={{ width: 28, height: 28, borderRadius: 8, border: `1px solid ${border}`, background: darkMode ? '#3a3a3c' : 'white', color: clr, fontSize: 14, cursor: "pointer", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}
          >✕</button>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6 }}>
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: projColor }} />
          <span style={{ fontSize: 11, color: textSec }}>{projName}</span>
        </div>
      </div>

      {/* Body — scrollable */}
      <div style={{ flex: 1, overflow: "auto", padding: 16 }}>
        {/* Notes */}
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: textSec, marginBottom: 6 }}>Poznámky</div>
          <textarea
            style={{
              width: "100%",
              minHeight: 100,
              padding: 10,
              borderRadius: 8,
              border: `1px solid ${border}`,
              background: inputBg,
              color: clr,
              fontSize: 13,
              lineHeight: 1.5,
              resize: "vertical",
              outline: "none",
              fontFamily: "inherit",
            }}
            placeholder="Add a note…"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>

        {/* Checklist */}
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: textSec }}>
              Checklist{totalCount > 0 && ` (${doneCount}/${totalCount})`}
            </div>
            <button
              onClick={addCheckItem}
              style={{ fontSize: 11, fontWeight: 600, color: projColor, cursor: "pointer", background: "none", border: "none", padding: "2px 6px" }}
            >
              + add
            </button>
          </div>

          {totalCount > 0 && (
            <div style={{ height: 3, borderRadius: 2, background: darkMode ? '#48484a' : '#e4e4e7', marginBottom: 10, overflow: "hidden" }}>
              <div style={{ height: "100%", width: `${totalCount > 0 ? (doneCount / totalCount) * 100 : 0}%`, background: projColor, borderRadius: 2, transition: "width 0.2s" }} />
            </div>
          )}

          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {checklist.map((ci) => (
              <div
                key={ci.id}
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 8,
                  padding: "6px 8px",
                  borderRadius: 8,
                  background: ci.done ? (darkMode ? '#1c1c1e' : '#f9fafb') : "transparent",
                }}
              >
                <input
                  type="checkbox"
                  checked={ci.done}
                  onChange={() => toggleCheckItem(ci.id)}
                  style={{ marginTop: 3, accentColor: projColor, cursor: "pointer", flexShrink: 0 }}
                />
                <input
                  style={{
                    flex: 1,
                    background: "transparent",
                    border: "none",
                    outline: "none",
                    fontSize: 13,
                    color: ci.done ? textSec : clr,
                    textDecoration: ci.done ? "line-through" : "none",
                    padding: 0,
                    fontFamily: "inherit",
                  }}
                  value={ci.text}
                  onChange={(e) => updateCheckText(ci.id, e.target.value)}
                  placeholder="…"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addCheckItem();
                    }
                  }}
                />
                <button
                  onClick={() => deleteCheckItem(ci.id)}
                  style={{ fontSize: 12, color: textSec, cursor: "pointer", background: "none", border: "none", padding: "0 2px", flexShrink: 0, opacity: 0.5 }}
                  title="Delete"
                >✕</button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
    </>
  );
}

// ---------------------------------------------
// PrintView — purpose-built print layout
// Day-first layout: each day is a row, tasks are color-coded pills by project
// Hidden on screen, displayed only when printing (Ctrl+P)
// ---------------------------------------------

function PrintView({
  projects,
  days,
  windowStart,
  windowLen,
  planRecurring,
  planRecurringInstances,
}: {
  projects: Project[];
  days: DayKey[];
  windowStart: DayKey;
  windowLen: number;
  planRecurring: PlanRecurring[];
  planRecurringInstances: Array<{ id: string; title: string; day: DayKey; projectId: string; color: string }>;
}) {
  const today = todayUTC();
  const firstDay = days[0];
  const lastDay = days[days.length - 1];

  // Build per-day entries across all projects
  const dayEntries = useMemo(() => {
    type Entry = { title: string; projectName: string; color: string; kind: "task" | "subtask"; expDesc?: string };
    const result: Array<{ day: DayKey; entries: Entry[] }> = [];

    for (const d of days) {
      const entries: Entry[] = [];

      for (const proj of projects) {
        for (const lane of proj.lanes) {
          for (const it of lane.items) {
            if (it.type === "task" && it.start === d) {
              entries.push({ title: it.title, projectName: proj.name, color: proj.color, kind: "task" });
            } else if (it.type === "experiment") {
              const exp = it as Extract<LaneItem, { type: "experiment" }>;
              const sts = exp.subTasks[d] ?? [];
              for (const st of sts) {
                entries.push({ title: st.title, projectName: proj.name, color: proj.color, kind: "subtask", expDesc: exp.desc || undefined });
              }
            }
          }
        }
      }

      // Plan recurring instances
      for (const r of planRecurringInstances) {
        if (r.day === d) {
          const proj = projects.find((p) => p.id === r.projectId);
          entries.push({ title: `↻ ${r.title}`, projectName: proj?.name ?? "", color: r.color, kind: "task" });
        }
      }

      result.push({ day: d, entries });
    }
    return result;
  }, [projects, days, planRecurringInstances]);

  // Project legend
  const activeProjects = useMemo(() => {
    const ids = new Set<string>();
    for (const { entries } of dayEntries) {
      for (const e of entries) ids.add(e.projectName);
    }
    return projects.filter((p) => ids.has(p.name));
  }, [projects, dayEntries]);

  const dateRange = `${dayLabel(firstDay).md} – ${dayLabel(lastDay).md}`;

  // Style constants
  const S = {
    page: { fontFamily: "system-ui, -apple-system, sans-serif", color: "#1a1a1a", fontSize: 11, lineHeight: 1.4 } as React.CSSProperties,
    header: { display: "flex", justifyContent: "space-between", alignItems: "baseline", borderBottom: "2px solid #1a1a1a", paddingBottom: 5, marginBottom: 8 } as React.CSSProperties,
    legend: { display: "flex", flexWrap: "wrap", gap: "6px 14px", marginBottom: 10, paddingBottom: 6, borderBottom: "1px solid #e0e0e0" } as React.CSSProperties,
    legendItem: { display: "flex", alignItems: "center", gap: 4, fontSize: 10 } as React.CSSProperties,
    dot: (color: string) => ({ width: 8, height: 8, borderRadius: "50%", background: color, flexShrink: 0 }) as React.CSSProperties,
    dayRow: (isToday: boolean, isWeekend: boolean) => ({
      display: "flex",
      gap: 0,
      borderBottom: "1px solid #e8e8e8",
      pageBreakInside: "avoid" as const,
      minHeight: 24,
    }) as React.CSSProperties,
    dateCell: (isToday: boolean, isWeekend: boolean) => ({
      width: 58,
      flexShrink: 0,
      padding: "5px 8px 5px 0",
      textAlign: "right" as const,
      borderRight: "2px solid #e8e8e8",
      background: isWeekend ? "#fef2f2" : "transparent",
    }) as React.CSSProperties,
    dayName: (isToday: boolean, isWeekend: boolean) => ({
      fontSize: 11,
      fontWeight: 600,
      color: isWeekend ? "#dc2626" : "#374151",
    }) as React.CSSProperties,
    dayDate: (isToday: boolean) => ({
      fontSize: 9,
      color: "#9ca3af",
      marginTop: 0,
    }) as React.CSSProperties,
    tasksCell: { flex: 1, padding: "4px 8px", display: "flex", flexWrap: "wrap", gap: 4, alignItems: "flex-start", alignContent: "flex-start" } as React.CSSProperties,
    pill: (color: string) => ({
      display: "inline-flex",
      alignItems: "center",
      gap: 3,
      background: color + "18",
      borderLeft: `3px solid ${color}`,
      borderRadius: "0 4px 4px 0",
      padding: "2px 7px 2px 5px",
      fontSize: 10,
      fontWeight: 500,
      color: "#1a1a1a",
      lineHeight: "15px",
      maxWidth: "100%",
    }) as React.CSSProperties,
    empty: { fontSize: 10, color: "#d1d5db", padding: "5px 8px" } as React.CSSProperties,
  };

  return (
    <div style={S.page}>
      {/* Header */}
      <div style={S.header}>
        <div style={{ fontSize: 15, fontWeight: 700 }}>Planner</div>
        <div style={{ fontSize: 10, color: "#6b7280" }}>{dateRange} · {windowLen} days</div>
      </div>

      {/* Project legend */}
      <div style={S.legend}>
        {activeProjects.map((p) => (
          <div key={p.id} style={S.legendItem}>
            <div style={S.dot(p.color)} />
            <span style={{ fontWeight: 600 }}>{p.name}</span>
          </div>
        ))}
      </div>

      {/* Day rows */}
      {dayEntries.map(({ day, entries }) => {
        const { weekday } = dayLabel(day);
        const dt = parseDay(day);
        const dayNum = dt.getUTCDate();
        const monthNum = dt.getUTCMonth() + 1;
        const wk = weekday.toLowerCase();
        const isWeekend = wk.startsWith("sat") || wk.startsWith("sun") || wk.startsWith("so") || wk.startsWith("ne");
        const isToday = day === today;

        return (
          <div key={day} style={S.dayRow(isToday, isWeekend)}>
            {/* Date column */}
            <div style={S.dateCell(isToday, isWeekend)}>
              <div style={S.dayName(isToday, isWeekend)}>{weekday}</div>
              <div style={S.dayDate(isToday)}>{dayNum}/{monthNum}</div>
            </div>

            {/* Tasks */}
            {entries.length === 0 ? (
              <div style={S.empty}>—</div>
            ) : (
              <div style={S.tasksCell}>
                {entries.map((entry, idx) => (
                  <div key={idx} style={S.pill(entry.color)}>
                    <span>{entry.title}</span>
                    {entry.expDesc && (
                      <span style={{ fontSize: 8, color: "#9ca3af", marginLeft: 2 }}>({entry.expDesc})</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------
// Main App component
// ---------------------------------------------

export default function App() {
const [user, setUser] = useState<any>(null);
const [email, setEmail] = useState("");
const [password, setPassword] = useState("");
const [authError, setAuthError] = useState<string | null>(null);
const [loadingAuth, setLoadingAuth] = useState(true);  

const [loadingCloud, setLoadingCloud] = useState(false);
const fileInputRef = useRef<HTMLInputElement | null>(null);
  const planWrapRef = useRef<HTMLDivElement | null>(null);
  const planHeaderRef = useRef<HTMLDivElement | null>(null);
  const syncLockRef = useRef(false);

  const syncScrollX = (from: HTMLDivElement | null, to: HTMLDivElement | null) => {
    if (!from || !to) return;
    if (syncLockRef.current) return;
    syncLockRef.current = true;
    to.scrollLeft = from.scrollLeft;
    requestAnimationFrame(() => { syncLockRef.current = false; });
  };

  const [planW, setPlanW] = useState<number>(0);
  const planRORef = useRef<ResizeObserver | null>(null);

  const readStored = (): PersistedStateV1 | null => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.version !== 1) return null;
      return parsed as PersistedStateV1;
    } catch { return null; }
  };

  const writeStored = (state: PersistedStateV1) => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch {}
  };

  
  const loadCloudState = async (userId: string): Promise<PersistedStateV1 | null> => {
    const { data, error } = await supabase
      .from("planner_states")
      .select("state")
      .eq("user_id", userId)
      .maybeSingle();

    if (error) {
      console.error("Supabase load error:", error);
      return null;
    }
    return (data?.state as PersistedStateV1) ?? null;
  };

  const saveCloudState = async (userId: string, state: PersistedStateV1): Promise<void> => {
    const { error } = await supabase
      .from("planner_states")
      .upsert({ user_id: userId, state, updated_at: new Date().toISOString() }, { onConflict: "user_id" });

    if (error) console.error("Supabase save error:", error);
  };

const stored = readStored();

  const normalizeProjects = (ps: Project[]): Project[] =>
    ps.map((p) => ({
      ...p,
      lanes: ensureAtLeastOneLane(
        (p.lanes ?? []).map((l) => ({
          ...l,
          items: (l.items ?? []).map((it: any) => {
            if (it?.type === "experiment") {
              return { ...it, desc: it.desc ?? "", subTasks: it.subTasks ?? {} };
            }
            return it;
          }),
        }))
      ),
    }));

  const [windowStart, setWindowStart] = useState<DayKey>(() => stored?.windowStart ?? addDays(todayUTC(), -2));
  const [viewMode, setViewMode] = useState<ViewMode>(() => stored?.viewMode ?? "plan");
  const [calendarDaysLen, setCalendarDaysLen] = useState<3 | 5 | 7>(() => stored?.calendarDaysLen ?? 5);
  const [timedEvents, setTimedEvents] = useState<Record<string, TimedEvent>>(() => stored?.timedEvents ?? {});
  const [recurring, setRecurring] = useState<RecurringEvent[]>(() =>
    stored?.recurring ?? [
      { id: "r1", title: "Weekly meeting", color: "#0ea5e9", weekday: 4, startMin: 9 * 60, endMin: 10 * 60 },
      { id: "r2", title: "Department seminar", color: "#a855f7", weekday: 3, startMin: 13 * 60, endMin: 14 * 60 },
    ]
  );
  const [planRecurring, setPlanRecurring] = useState<PlanRecurring[]>(() => (stored as any)?.planRecurring ?? []);
  const [recurringModal, setRecurringModal] = useState(false);
  const [resizeEvt, setResizeEvt] = useState<{ id: string; pointerId: number } | null>(null);

  const [windowLen, setWindowLen] = useState<7 | 14 | 28>(() => stored?.windowLen ?? 14);
  const [projects, setProjects] = useState<Project[]>(() =>
    stored?.projects ? normalizeProjects(stored.projects) : seed(stored?.windowStart ?? windowStart)
  );

  const [inbox, setInbox] = useState<InboxTask[]>(() => stored?.inbox ?? []);
  const [completed, setCompleted] = useState<InboxTask[]>(() => stored?.completed ?? []);
  const [collapsedProjects, setCollapsedProjects] = useState<Record<string, boolean>>(() => stored?.collapsedProjects ?? {});

  // Completed task checkboxes in agenda/day views (keyed by composite id like "t:projId:itemId")
  const initCompletedTasks = stored?.completedTasks ?? {};
  const [cascadedProjects, setCascadedProjects] = useState<Record<string, boolean>>({});
  const [darkMode, setDarkMode] = useState<boolean>(() => {
    const stored = localStorage.getItem("pmorph_darkmode");
    return stored === "true";
  });
  const [archivedProjects, setArchivedProjects] = useState<Project[]>(() => (stored as any)?.archivedProjects ?? []);
  const [showArchive, setShowArchive] = useState<boolean>(false);
  const [closeConfirm, setCloseConfirm] = useState<string | null>(null); // projectId awaiting confirm
  const [inboxOpen, setInboxOpen] = useState<boolean>(true);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [planRecurringModal, setPlanRecurringModal] = useState(false);
  const [planRecForm, setPlanRecForm] = useState<{ projectId: string; title: string; weekday: number }>({ projectId: "", title: "", weekday: 1 });
  const [addTaskModal, setAddTaskModal] = useState(false);
  const [addTaskForm, setAddTaskForm] = useState<{
    projectId: string; title: string; notes: string; day: string; 
    timeEnabled: boolean; startTime: string; endTime: string;
    recurring: boolean; recurringWeekday: number;
  }>({ projectId: "", title: "", notes: "", day: todayUTC(), timeEnabled: false, startTime: "09:00", endTime: "10:00", recurring: false, recurringWeekday: 1 });
  const [inboxFilter, setInboxFilter] = useState<string>("all");
  const [newInboxTitle, setNewInboxTitle] = useState<string>("");

  const [dayFocus, setDayFocus] = useState<DayKey | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [detailTarget, setDetailTarget] = useState<DetailTarget>(null);
  const [completedTasks, setCompletedTasks] = useState<Record<string, boolean>>(initCompletedTasks);
  const [dragCreate, setDragCreate] = useState<DragCreate>(null);
  const [resizeExp, setResizeExp] = useState<ResizeExp>(null);

  // Listen for custom "open-detail" events dispatched from deeply nested components
  // Use a global function ref approach to bypass any event/compilation issues
  const openDetailRef = useRef((t: DetailTarget) => {});
  openDetailRef.current = (t: DetailTarget) => { if (t) setDetailTarget(t); };
  useEffect(() => {
    (window as any).__openDetail = (t: any) => openDetailRef.current(t);
    return () => { delete (window as any).__openDetail; };
  }, []);

  // Robust width tracking — placed AFTER all state declarations to avoid TDZ errors.
  // Re-measures whenever view or windowLen changes, and on window resize.
  const measurePlanW = () => {
    const el = planWrapRef.current;
    if (!el) return;
    const w = el.clientWidth;
    if (w > 0) setPlanW(w);
  };
useEffect(() => {
  const getUser = async () => {
    const { data } = await supabase.auth.getUser();
    setUser(data.user);
    setLoadingAuth(false);
  };

  getUser();

  const { data: listener } = supabase.auth.onAuthStateChange(
    (_event, session) => {
      setUser(session?.user ?? null);
    }
  );

  return () => {
    listener.subscription.unsubscribe();
  };
}, []);





  useEffect(() => {
    if (viewMode !== "plan") return;
    const el = planWrapRef.current;
    if (!el) return;

    planRORef.current?.disconnect();
    const ro = new ResizeObserver(() => measurePlanW());
    ro.observe(el);
    planRORef.current = ro;

    measurePlanW();
    // Delayed re-measure to catch layout shifts after cloud state loads
    const t1 = setTimeout(measurePlanW, 100);
    const t2 = setTimeout(measurePlanW, 500);
    window.addEventListener("resize", measurePlanW);
    return () => {
      window.removeEventListener("resize", measurePlanW);
      clearTimeout(t1);
      clearTimeout(t2);
      ro.disconnect();
    };
  }, [viewMode, windowLen, loadingCloud]); // also re-measure when cloud loading finishes

  const makeSnapshot = (): PersistedStateV1 => ({
    version: 1,
    windowStart,
    windowLen,
    viewMode,
    calendarDaysLen,
    projects,
    timedEvents,
    recurring,
    inbox,
    completed,
    completedTasks,
    ...(archivedProjects.length ? { archivedProjects } : {}),
    ...(planRecurring.length ? { planRecurring } : {}),
  } as any);

  // ---- Undo / Redo (Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y) ----
  const undoStackRef = useRef<PersistedStateV1[]>([]);
  const redoStackRef = useRef<PersistedStateV1[]>([]);
  const prevSnapshotRef = useRef<PersistedStateV1 | null>(null);
  const isRestoringRef = useRef(false);
  const MAX_UNDO = 30;

  const restoreSnapshot = (s: PersistedStateV1) => {
    isRestoringRef.current = true;
    setWindowStart(s.windowStart);
    setWindowLen(s.windowLen);
    setViewMode(s.viewMode);
    setCalendarDaysLen(s.calendarDaysLen);
    setProjects(normalizeProjects(s.projects));
    setTimedEvents(s.timedEvents);
    setRecurring(s.recurring);
    setInbox(s.inbox ?? []);
    setCompleted(s.completed ?? []);
    setCollapsedProjects(s.collapsedProjects ?? {});
    setPlanRecurring((s as any).planRecurring ?? []);
    setArchivedProjects((s as any).archivedProjects ?? []);
    setCompletedTasks((s as any).completedTasks ?? {});
    setSelection(null);
    setDragCreate(null);
    setResizeExp(null);
    writeStored(s);
    // Allow next autosave cycle to see this as new baseline
    requestAnimationFrame(() => {
      prevSnapshotRef.current = s;
      isRestoringRef.current = false;
    });
  };

  // After login: load planner state from Supabase (cloud)
  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;

    (async () => {
      setLoadingCloud(true);

      const cloud = await loadCloudState(user.id);

      if (cancelled) return;

      if (cloud && cloud.version === 1) {
        // Use cloud state as source of truth
        restoreSnapshot(cloud);
      } else {
        // No cloud state yet -> upload current local snapshot once
        const current = makeSnapshot();
        await saveCloudState(user.id, current);
      }

      if (!cancelled) setLoadingCloud(false);
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);


  const performUndo = () => {
    const stack = undoStackRef.current;
    if (stack.length === 0) return;
    const prev = stack.pop()!;
    redoStackRef.current.push(makeSnapshot());
    if (redoStackRef.current.length > MAX_UNDO) redoStackRef.current.shift();
    restoreSnapshot(prev);
  };

  const performRedo = () => {
    const stack = redoStackRef.current;
    if (stack.length === 0) return;
    const next = stack.pop()!;
    undoStackRef.current.push(makeSnapshot());
    if (undoStackRef.current.length > MAX_UNDO) undoStackRef.current.shift();
    restoreSnapshot(next);
  };

  // Keyboard shortcut: Ctrl+Z = undo, Ctrl+Shift+Z / Ctrl+Y = redo
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        performUndo();
      } else if ((e.ctrlKey || e.metaKey) && (e.key === "y" || (e.key === "z" && e.shiftKey) || (e.key === "Z" && e.shiftKey))) {
        e.preventDefault();
        performRedo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  useEffect(() => {
    const t = window.setTimeout(() => {
      if (isRestoringRef.current) return;
      const current = makeSnapshot();
      const prev = prevSnapshotRef.current;
      // Only push to undo if there's a meaningful data change (not just navigation)
      if (prev) {
        const dataChanged =
          JSON.stringify(prev.projects) !== JSON.stringify(current.projects) ||
          JSON.stringify(prev.inbox) !== JSON.stringify((current as any).inbox) ||
          JSON.stringify(prev.completed) !== JSON.stringify((current as any).completed) ||
          JSON.stringify(prev.timedEvents) !== JSON.stringify(current.timedEvents) ||
          JSON.stringify(prev.recurring) !== JSON.stringify(current.recurring) ||
          JSON.stringify((prev as any).planRecurring) !== JSON.stringify((current as any).planRecurring) ||
          JSON.stringify((prev as any).archivedProjects) !== JSON.stringify((current as any).archivedProjects) ||
          JSON.stringify((prev as any).completedTasks) !== JSON.stringify((current as any).completedTasks);
        if (dataChanged) {
          undoStackRef.current.push(prev);
          if (undoStackRef.current.length > MAX_UNDO) undoStackRef.current.shift();
          redoStackRef.current = []; // clear redo on new change
        }
      }
      prevSnapshotRef.current = current;
      writeStored(current);
      setSavedAt(new Date());

      // Also sync to cloud (debounced by this 500ms autosave timer)
      if (user?.id) {
        void saveCloudState(user.id, current);
      }
}, 500);
    return () => window.clearTimeout(t);
  }, [windowStart, windowLen, viewMode, calendarDaysLen, projects, timedEvents, recurring, planRecurring, inbox, completed, collapsedProjects, archivedProjects, completedTasks]);

  useEffect(() => {
    localStorage.setItem("pmorph_darkmode", String(darkMode));
    if (darkMode) {
      document.documentElement.classList.add("dark");
    } else {
      document.documentElement.classList.remove("dark");
    }
  }, [darkMode]);

  const exportJSON = () => {
    const data = JSON.stringify(makeSnapshot(), null, 2);
    const blob = new Blob([data], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "planner.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  // ---- ICS EXPORT ----
  const exportICS = () => {
    const minToHHMM = (m: number) =>
      String(Math.floor(m / 60)).padStart(2, "0") + String(m % 60).padStart(2, "0") + "00";

    const dayToDate = (day: string) => day.replace(/-/g, "");

    const escICS = (s: string) =>
      s.split("\\").join("\\\\").split(";").join("\\;").split(",").join("\\,").split("\n").join("\\n");

    const lines: string[] = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//pmorph planner//EN", "CALSCALE:GREGORIAN"];

    // Timed events (tasks with time in calendar)
    for (const ev of Object.values(timedEvents)) {
      const taskRef = taskCatalog.find((t) => t.id === ev.id);
      const title = taskRef?.title ?? ev.id;
      const d = dayToDate(ev.day);
      const start = `${d}T${minToHHMM(ev.startMin)}`;
      const end   = `${d}T${minToHHMM(ev.endMin)}`;
      const uid   = `${ev.id}-${ev.day}@pmorph`;
      lines.push("BEGIN:VEVENT", `UID:${uid}`, `DTSTART:${start}`, `DTEND:${end}`, `SUMMARY:${escICS(title)}`, "END:VEVENT");
    }

    // Recurring calendar events (for next 90 days)
    const today = new Date();
    for (const r of recurring) {
      for (let i = 0; i < 90; i++) {
        const dt = new Date(today);
        dt.setUTCDate(dt.getUTCDate() + i);
        if (dt.getUTCDay() !== r.weekday) continue;
        const d = dt.toISOString().slice(0, 10).replace(/-/g, "");
        const start = `${d}T${minToHHMM(r.startMin)}`;
        const end   = `${d}T${minToHHMM(r.endMin)}`;
        const uid   = `${r.id}-${d}@pmorph`;
        lines.push("BEGIN:VEVENT", `UID:${uid}`, `DTSTART:${start}`, `DTEND:${end}`, `SUMMARY:${escICS(r.title)}`, "END:VEVENT");
      }
    }

    // All-day tasks from planner (tasks without timed event)
    for (const p of projects) {
      for (const lane of p.lanes) {
        for (const it of lane.items) {
          if (it.type !== "task") continue;
          const evtId = `t:${p.id}:${it.id}`;
          if (timedEvents[evtId]) continue; // already exported with time
          const d = dayToDate(it.start);
          const uid = `${it.id}@pmorph`;
          lines.push("BEGIN:VEVENT", `UID:${uid}`, `DTSTART;VALUE=DATE:${d}`, `DTEND;VALUE=DATE:${d}`, `SUMMARY:${escICS(it.title)}`, `CATEGORIES:${escICS(p.name)}`, "END:VEVENT");
        }
      }
    }

    // Plan recurring (next 90 days)
    for (const r of planRecurring) {
      const proj = projects.find((p) => p.id === r.projectId);
      for (let i = 0; i < 90; i++) {
        const dt = new Date(today);
        dt.setUTCDate(dt.getUTCDate() + i);
        if (dt.getUTCDay() !== r.weekday) continue;
        const d = dt.toISOString().slice(0, 10).replace(/-/g, "");
        const uid = `${r.id}-${d}@pmorph`;
        lines.push("BEGIN:VEVENT", `UID:${uid}`, `DTSTART;VALUE=DATE:${d}`, `DTEND;VALUE=DATE:${d}`, `SUMMARY:↻ ${escICS(r.title)}`, `CATEGORIES:${escICS(proj?.name ?? "")}`, "END:VEVENT");
      }
    }

    lines.push("END:VCALENDAR");
    const blob = new Blob([lines.join("\r\n")], { type: "text/calendar;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "planner.ics";
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  };

  // ---- PDF EXPORT ----
  const exportPDF = () => {
    // Just trigger the browser print dialog — the @media print styles
    // will hide the app and show the PrintView component
    window.print();
  };

  // ---- SHARE URL ----
  const [shareModalOpen, setShareModalOpen] = useState(false);
  const [shareURL, setShareURL] = useState("");

  const exportPNG = async () => {
    const planEl = document.querySelector('[data-plan-view]') as HTMLElement;
    const headerEl = document.querySelector('[data-date-header]') as HTMLElement;
    if (!planEl) return;
    
    try {
      // Dynamically load html2canvas from CDN if not already loaded
      if (!(window as any).html2canvas) {
        await new Promise<void>((resolve, reject) => {
          const script = document.createElement('script');
          script.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
          script.onload = () => resolve();
          script.onerror = () => reject(new Error('Failed to load html2canvas'));
          document.head.appendChild(script);
        });
      }
      
      const html2canvas = (window as any).html2canvas;
      if (!html2canvas) {
        // Fallback: open print dialog
        alert("Could not load html2canvas. Use Ctrl+P to print as PDF, or Ctrl+Shift+S for screenshot (Firefox).");
        return;
      }

      // Create a temporary wrapper with both header and plan for a complete screenshot
      const wrapper = document.createElement('div');
      wrapper.style.position = 'absolute';
      wrapper.style.left = '-9999px';
      wrapper.style.top = '0';
      wrapper.style.background = darkMode ? '#1c1c1e' : '#fafafa';
      wrapper.style.padding = '16px';
      document.body.appendChild(wrapper);
      
      if (headerEl) {
        const headerClone = headerEl.cloneNode(true) as HTMLElement;
        headerClone.style.overflow = 'visible';
        headerClone.style.marginBottom = '0';
        wrapper.appendChild(headerClone);
      }
      const planClone = planEl.cloneNode(true) as HTMLElement;
      planClone.style.overflow = 'visible';
      planClone.style.maxHeight = 'none';
      planClone.style.height = 'auto';
      wrapper.appendChild(planClone);
      
      const canvas = await html2canvas(wrapper, { 
        backgroundColor: darkMode ? '#1c1c1e' : '#fafafa',
        scale: 2,
        useCORS: true,
        logging: false,
      });
      
      document.body.removeChild(wrapper);
      
      const dataUrl = canvas.toDataURL('image/png');
      const a = document.createElement('a');
      a.href = dataUrl;
      a.download = `planner-${new Date().toISOString().slice(0,10)}.png`;
      a.click();
    } catch (err) {
      console.error('Screenshot failed:', err);
      alert("PNG export failed. Use browser screenshot (Ctrl+Shift+S in Firefox, or Ctrl+P to print as PDF).");
    }
  };

  const generateShareURL = () => {
    const snapshot = makeSnapshot();
    const json = JSON.stringify(snapshot);
    const compressed = btoa(encodeURIComponent(json));
    const url = `${window.location.origin}${window.location.pathname}#state=${compressed}`;
    setShareURL(url);
    setShareModalOpen(true);
  };

  // On mount: check URL hash for shared state
  useEffect(() => {
    const hash = window.location.hash;
    if (!hash.startsWith("#state=")) return;
    try {
      const compressed = hash.slice("#state=".length);
      const json = decodeURIComponent(atob(compressed));
      const parsed = JSON.parse(json);
      if (!parsed || parsed.version !== 1) return;
      restoreSnapshot(parsed as PersistedStateV1);
      // Clear hash so refresh doesn't re-import
      window.history.replaceState(null, "", window.location.pathname);
    } catch {
      // invalid hash, ignore
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // On mount: scan all tasks for time-range in title and auto-create missing events
  useEffect(() => {
    setTimedEvents((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const p of projects) {
        for (const lane of p.lanes) {
          for (const it of lane.items) {
            if (it.type !== "task") continue;
            const evtId = `t:${p.id}:${it.id}`;
            if (next[evtId]) continue; // already has an event, skip
            const tr = parseTimeRange(it.title);
            if (tr) {
              next[evtId] = { id: evtId, day: it.start, startMin: tr.startMin, endMin: tr.endMin };
              changed = true;
            }
          }
        }
      }
      return changed ? next : prev;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // run once on mount

  // Initialize undo baseline on mount
  useEffect(() => { prevSnapshotRef.current = makeSnapshot(); }, []);

  const importJSON = async (file: File) => {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (!parsed || parsed.version !== 1) return;
      const s = parsed as PersistedStateV1;
      // Push current state to undo so import can be undone
      undoStackRef.current.push(makeSnapshot());
      if (undoStackRef.current.length > MAX_UNDO) undoStackRef.current.shift();
      redoStackRef.current = [];
      restoreSnapshot(s);
      setDayFocus(null);
      setRecurringModal(false);
    } catch {}
  };

  const days = useMemo(
    () => Array.from({ length: windowLen }, (_, i) => addDays(windowStart, i)),
    [windowStart, windowLen]
  );

  const calDays = useMemo(
    () => Array.from({ length: calendarDaysLen }, (_, i) => addDays(windowStart, i)),
    [windowStart, calendarDaysLen]
  );

  // Expand planRecurring into per-day virtual task items for plan view display
  const planRecurringInstances = useMemo(() => {
    const out: Array<{ id: string; title: string; day: DayKey; projectId: string; color: string }> = [];
    for (const r of planRecurring) {
      const proj = projects.find((p) => p.id === r.projectId);
      if (!proj) continue;
      for (const day of days) {
        const dt = parseDay(day);
        if (dt.getUTCDay() === r.weekday) {
          out.push({ id: `pr:${r.id}:${day}`, title: r.title, day, projectId: r.projectId, color: proj.color });
        }
      }
    }
    return out;
  }, [planRecurring, projects, days]);

  const taskCatalog = useMemo(() => {
    const out: TaskRef[] = [];
    for (const p of projects) {
      for (const lane of p.lanes) {
        for (const it of lane.items) {
          if (it.type === "task") {
            out.push({ id: `t:${p.id}:${it.id}`, title: it.title, day: it.start, color: p.color, kind: "task", meta: { projectId: p.id, itemId: it.id } });
          } else {
            for (const [day, arr] of Object.entries(it.subTasks)) {
              for (const st of arr) {
                out.push({ id: `st:${p.id}:${it.id}:${st.id}`, title: st.title, day, color: p.color, kind: "subtask", meta: { projectId: p.id, experimentId: it.id, subTaskId: st.id } });
              }
            }
          }
        }
      }
    }
    // Also include planRecurring instances so they show up in calendar inbox row
    for (const r of planRecurringInstances) {
      out.push({ id: r.id, title: `↻ ${r.title}`, day: r.day, color: r.color, kind: "task", meta: { isPlanRecurring: true } });
    }
    return out;
  }, [projects, planRecurringInstances]);

  const inboxTasks = useMemo(() => {
    const visible = taskCatalog.filter((t) => calDays.includes(t.day));
    return visible.filter((t) => !timedEvents[t.id]);
  }, [taskCatalog, timedEvents, calDays]);

  const eventsForCal = useMemo(() => {
    return Object.values(timedEvents).filter((e) => calDays.includes(e.day));
  }, [timedEvents, calDays]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const collisionDetection = (args: any) => {
    const within = pointerWithin(args);
    return within.length ? within : closestCenter(args);
  };

  function onDragEnd(ev: DragEndEvent) {
    const activeId = String(ev.active.id);
    const overId = ev.over ? String(ev.over.id) : null;
    if (!overId) return;

    // Inbox -> grid
    if (activeId.startsWith("inbox:")) {
      const parts = activeId.split(":");
      const fromProjectId = parts[1];
      const inboxId = parts[2];
      const t = inbox.find((x) => x.id === inboxId);
      if (!t) return;

      if (overId.startsWith("cell:")) {
        const [, pId, laneId, day] = overId.split(":");
        if (pId !== fromProjectId) return;
        addStandaloneTaskWithTitle(pId, laneId, day as DayKey, t.title, { notes: t.notes, checklist: t.checklist });
        setInbox((prev) => prev.filter((x) => x.id !== inboxId));
        return;
      }

      if (overId.startsWith("expday:")) {
        const [, pId, laneId, expId, day] = overId.split(":");
        if (pId !== fromProjectId) return;
        addExperimentSubTaskWithTitle(pId, laneId, expId, day as DayKey, t.title, { notes: t.notes, checklist: t.checklist });
        setInbox((prev) => prev.filter((x) => x.id !== inboxId));
        return;
      }
    }

    // Standalone task -> into experiment
    if (isPrefix(activeId, "item") && isPrefix(overId, "expday")) {
      const [, pId, _fromLaneId, itemId] = splitId(activeId);
      const [, p2Id, targetLaneId, expId, targetDay] = splitId(overId);
      if (pId !== p2Id) return;

      const createdSubId = `st_${crypto.randomUUID()}`;

      setProjects((prev) => {
        const next = structuredClone(prev) as Project[];
        const pIdx = next.findIndex((p) => p.id === pId);
        if (pIdx === -1) return prev;
        const project = next[pIdx];

        let taskTitle: string | null = null;
        let removed = false;
        const newLanes: Lane[] = [];

        for (const lane of project.lanes) {
          const items: LaneItem[] = [];
          for (const it of lane.items) {
            if (!removed && it.id === itemId) {
              if (it.type !== "task") return prev;
              taskTitle = it.title;
              removed = true;
              continue;
            }
            items.push(it);
          }
          if (items.length) newLanes.push({ ...lane, items });
        }

        if (!removed || !taskTitle) return prev;

        const lane2 = newLanes.find((l) => l.id === targetLaneId);
        if (!lane2) return prev;
        const exp = lane2.items.find((it) => it.id === expId);
        if (!exp || exp.type !== "experiment") return prev;
        if (compareDay(targetDay, exp.start) < 0 || compareDay(targetDay, exp.end) > 0) return prev;

        const bucket = exp.subTasks[targetDay] ? exp.subTasks[targetDay].slice() : [];
        bucket.push({ id: createdSubId, title: taskTitle, day: targetDay });

        const updatedExp: LaneItem = { ...exp, subTasks: { ...exp.subTasks, [targetDay]: bucket } };
        const lane2Updated: Lane = { ...lane2, items: lane2.items.map((it) => (it.id === expId ? updatedExp : it)) };

        next[pIdx] = {
          ...project,
          lanes: ensureAtLeastOneLane(newLanes.map((l) => (l.id === targetLaneId ? lane2Updated : l))),
        };
        return next;
      });

      setSelection({ kind: "subtask", projectId: pId, experimentId: expId, subTaskId: createdSubId });
      return;
    }

    // Move whole segments
    if (isPrefix(activeId, "item") && isPrefix(overId, "cell")) {
      const [, pId, _fromLaneId, itemId] = splitId(activeId);
      const [, p2Id, targetLaneId, targetDay] = splitId(overId);
      if (pId !== p2Id) return;

      setProjects((prev) => {
        const next = structuredClone(prev) as Project[];
        const pIdx = next.findIndex((p) => p.id === pId);
        if (pIdx === -1) return prev;
        const project = next[pIdx];

        let found: { laneId: string; item: LaneItem } | null = null;
        for (const l of project.lanes) {
          const it = l.items.find((x) => x.id === itemId);
          if (it) { found = { laneId: l.id, item: it }; break; }
        }
        if (!found) return prev;

        const delta = diffDays(found.item.start, targetDay);
        let moved: LaneItem;
        if (found.item.type === "experiment") {
          moved = { ...found.item, start: addDays(found.item.start, delta), end: addDays(found.item.end, delta), subTasks: shiftExperimentSubtasks(found.item.subTasks, delta) };
        } else {
          moved = { ...found.item, start: addDays(found.item.start, delta), end: addDays(found.item.end, delta) };
        }

        next[pIdx] = placeItemPacked(project, targetLaneId, moved, found.item.id);
        return next;
      });
      return;
    }

    // Move subtask pill
    if (isPrefix(activeId, "subtask") && isPrefix(overId, "expday")) {
      const [, pId, laneId, expId, subTaskId] = splitId(activeId);
      const [, p2Id, lane2Id, exp2Id, targetDay] = splitId(overId);
      if (pId !== p2Id || laneId !== lane2Id || expId !== exp2Id) return;

      setProjects((prev) => {
        const next = structuredClone(prev) as Project[];
        const pIdx = next.findIndex((p) => p.id === pId);
        if (pIdx === -1) return prev;
        const project = next[pIdx];
        const lane = findLane(project, laneId);
        if (!lane) return prev;
        const exp = lane.items.find((it) => it.id === expId);
        if (!exp || exp.type !== "experiment") return prev;
        if (compareDay(targetDay, exp.start) < 0 || compareDay(targetDay, exp.end) > 0) return prev;

        let currentDay: DayKey | null = null;
        let foundTask: ExperimentSubTask | null = null;
        const newSub: Record<DayKey, ExperimentSubTask[]> = {};

        for (const [day, arr] of Object.entries(exp.subTasks)) {
          const kept = arr.filter((t) => t.id !== subTaskId);
          if (kept.length !== arr.length) { currentDay = day; foundTask = arr.find((t) => t.id === subTaskId) ?? null; }
          if (kept.length) newSub[day] = kept;
        }

        if (!foundTask || currentDay === targetDay) return prev;

        const movedTask: ExperimentSubTask = { ...foundTask, day: targetDay };
        const bucket = newSub[targetDay] ? newSub[targetDay].slice() : [];
        bucket.push(movedTask);
        newSub[targetDay] = bucket;

        const updatedExp: LaneItem = { ...exp, subTasks: newSub };
        next[pIdx] = placeItemPacked(project, laneId, updatedExp, exp.id);
        return next;
      });
      return;
    }
  }

  // Flag to prevent the outer container click from clearing selection
  // right after a cell click creates a task
  const skipNextDeselectRef = useRef(false);

  // Aggressively try to focus the title editor input after task creation
  function scheduleEditorFocus() {
    skipNextDeselectRef.current = true;
    let attempts = 0;
    const tryFocus = () => {
      const el = document.querySelector('input[data-title-editor="1"]') as HTMLInputElement | null;
      if (el) {
        el.focus();
        el.select();
        return;
      }
      attempts++;
      if (attempts < 15) requestAnimationFrame(tryFocus);
    };
    // Start trying after React has re-rendered
    requestAnimationFrame(tryFocus);
  }

  function addStandaloneTask(projectId: string, laneId: string, day: DayKey) {
    addStandaloneTaskWithTitle(projectId, laneId, day, "task");
  }

  function addStandaloneTaskWithTitle(projectId: string, laneId: string, day: DayKey, title: string, extra?: { notes?: string; checklist?: CheckItem[] }) {
    const createdId = `it_${crypto.randomUUID()}`;
    const item: LaneItem = { id: createdId, type: "task", title: title.trim() || "task", start: day, end: day, notes: extra?.notes, checklist: extra?.checklist };
    setProjects((prev) => {
      const next = structuredClone(prev) as Project[];
      const pIdx = next.findIndex((p) => p.id === projectId);
      if (pIdx === -1) return prev;
      next[pIdx] = placeItemPacked(next[pIdx], laneId, item);
      return next;
    });
    // Auto-select the new task to open inline editor
    setSelection({ kind: "item", projectId, itemId: createdId });
    // Schedule aggressive focus on the title editor that will appear
    scheduleEditorFocus();
  }

  function addExperimentSubTaskWithTitle(projectId: string, laneId: string, experimentId: string, day: DayKey, title: string, extra?: { notes?: string; checklist?: CheckItem[] }) {
    const createdId = `st_${crypto.randomUUID()}`;
    setProjects((prev) => {
      const next = structuredClone(prev) as Project[];
      const pIdx = next.findIndex((p) => p.id === projectId);
      if (pIdx === -1) return prev;
      const project = next[pIdx];
      const lane = findLane(project, laneId);
      if (!lane) return prev;
      const exp = lane.items.find((it) => it.id === experimentId);
      if (!exp || exp.type !== "experiment") return prev;
      const st: ExperimentSubTask = { id: createdId, title: title.trim() || "task", day, notes: extra?.notes, checklist: extra?.checklist };
      const bucket = exp.subTasks[day] ? exp.subTasks[day].slice() : [];
      bucket.push(st);
      const updatedExp: LaneItem = { ...exp, subTasks: { ...exp.subTasks, [day]: bucket } };
      next[pIdx] = placeItemPacked(project, laneId, updatedExp, exp.id);
      return next;
    });
    setSelection({ kind: "subtask", projectId, experimentId, subTaskId: createdId });
  }

  function addInboxTask(projectId: string, title: string) {
    const t = title.trim();
    if (!t) return;
    setInbox((prev) => [{ id: `ib_${crypto.randomUUID()}`, projectId, title: t }, ...prev]);
  }

  function markInboxDone(id: string) {
    setInbox((prev) => {
      const it = prev.find((x) => x.id === id);
      if (!it) return prev;
      setCompleted((cprev) => [{ ...it }, ...cprev]);
      return prev.filter((x) => x.id !== id);
    });
  }

  function returnFromCompleted(id: string) {
    setCompleted((prev) => {
      const it = prev.find((x) => x.id === id);
      if (!it) return prev;
      setInbox((iprev) => [{ ...it }, ...iprev]);
      return prev.filter((x) => x.id !== id);
    });
  }

  function removeInboxTask(id: string) {
    setInbox((prev) => prev.filter((x) => x.id !== id));
  }

  function addExperimentRange(projectId: string, laneId: string, start: DayKey, end: DayKey) {
    const s = compareDay(start, end) <= 0 ? start : end;
    const e = compareDay(start, end) <= 0 ? end : start;
    const item: LaneItem = { id: `it_${crypto.randomUUID()}`, type: "experiment", title: "", desc: "", start: s, end: e, subTasks: {} };
    setProjects((prev) => {
      const next = structuredClone(prev) as Project[];
      const pIdx = next.findIndex((p) => p.id === projectId);
      if (pIdx === -1) return prev;
      next[pIdx] = placeItemPacked(next[pIdx], laneId, item);
      return next;
    });
  }

  function addExperimentSubTask(projectId: string, laneId: string, experimentId: string, day: DayKey) {
    const createdId = `st_${crypto.randomUUID()}`;
    setProjects((prev) => {
      const next = structuredClone(prev) as Project[];
      const pIdx = next.findIndex((p) => p.id === projectId);
      if (pIdx === -1) return prev;
      const project = next[pIdx];
      const lane = findLane(project, laneId);
      if (!lane) return prev;
      const exp = lane.items.find((it) => it.id === experimentId);
      if (!exp || exp.type !== "experiment") return prev;
      const st: ExperimentSubTask = { id: createdId, title: "task", day };
      const bucket = exp.subTasks[day] ? exp.subTasks[day].slice() : [];
      bucket.push(st);
      const updatedExp: LaneItem = { ...exp, subTasks: { ...exp.subTasks, [day]: bucket } };
      next[pIdx] = placeItemPacked(project, laneId, updatedExp, exp.id);
      return next;
    });
    setSelection({ kind: "subtask", projectId, experimentId, subTaskId: createdId });
    scheduleEditorFocus();
  }

  function updateExperimentSubTaskTitle(projectId: string, experimentId: string, subTaskId: string, title: string) {
    setProjects((prev) => {
      const next = structuredClone(prev) as Project[];
      const pIdx = next.findIndex((p) => p.id === projectId);
      if (pIdx === -1) return prev;
      const project = next[pIdx];
      let updated = false;
      for (const lane of project.lanes) {
        const exp = lane.items.find((it) => it.id === experimentId);
        if (!exp || exp.type !== "experiment") continue;
        const newSub: Record<DayKey, ExperimentSubTask[]> = {};
        for (const [day, arr] of Object.entries(exp.subTasks)) {
          newSub[day] = arr.map((t) => (t.id === subTaskId ? { ...t, title } : t));
          if (arr.some((t) => t.id === subTaskId)) updated = true;
        }
        if (updated) {
          const updatedExp: LaneItem = { ...exp, subTasks: newSub };
          next[pIdx] = placeItemPacked(project, lane.id, updatedExp, exp.id);
          return next;
        }
      }
      return prev;
    });
  }

  function deleteExperimentSubTask(projectId: string, experimentId: string, subTaskId: string) {
    setProjects((prev) => {
      const next = structuredClone(prev) as Project[];
      const pIdx = next.findIndex((p) => p.id === projectId);
      if (pIdx === -1) return prev;
      const project = next[pIdx];
      for (const lane of project.lanes) {
        const exp = lane.items.find((it) => it.id === experimentId);
        if (!exp || exp.type !== "experiment") continue;
        const newSub: Record<DayKey, ExperimentSubTask[]> = {};
        let changed = false;
        for (const [day, arr] of Object.entries(exp.subTasks)) {
          const filtered = arr.filter((t) => t.id !== subTaskId);
          if (filtered.length !== arr.length) changed = true;
          if (filtered.length) newSub[day] = filtered;
        }
        if (changed) {
          const updatedExp: LaneItem = { ...exp, subTasks: newSub };
          next[pIdx] = placeItemPacked(project, lane.id, updatedExp, exp.id);
          return next;
        }
      }
      return prev;
    });
    setSelection((s) => (s && s.kind === "subtask" && s.projectId === projectId && s.subTaskId === subTaskId ? null : s));
  }

  function moveProject(projectId: string, direction: "up" | "down") {
    setProjects((prev) => {
      const idx = prev.findIndex((p) => p.id === projectId);
      if (idx < 0) return prev;
      const next = [...prev];
      const swap = direction === "up" ? idx - 1 : idx + 1;
      if (swap < 0 || swap >= next.length) return prev;
      [next[idx], next[swap]] = [next[swap], next[idx]];
      return next;
    });
  }

  function toggleCascade(projectId: string) {
    const isCascaded = cascadedProjects[projectId];
    console.log('[toggleCascade]', projectId, 'isCascaded:', isCascaded, '-> switching to:', !isCascaded ? 'cascade' : 'greedy');
    
    if (isCascaded) {
      // Switch back to greedy pack (compact)
      setCascadedProjects((prev) => ({ ...prev, [projectId]: false }));
      setProjects((prev) => {
        const pIdx = prev.findIndex((p) => p.id === projectId);
        if (pIdx < 0) return prev;
        const project = prev[pIdx];
        
        // Collect all items (including virtual items from planRecurring)
        const allItems: LaneItem[] = [];
        for (const lane of project.lanes) {
          for (const it of lane.items) {
            allItems.push(it);
          }
        }
        
        // Add planRecurring as virtual task items (one per day)
        const virtualRecurring: LaneItem[] = [];
        for (const r of planRecurring) {
          if (r.projectId !== project.id) continue;
          for (const day of days) {
            const dt = parseDay(day);
            if (dt.getUTCDay() === r.weekday) {
              virtualRecurring.push({
                id: `virt_pr_${r.id}_${day}`,
                type: "task",
                title: `↻ ${r.title}`,
                start: day,
                end: day,
              });
            }
          }
        }
        allItems.push(...virtualRecurring);
        
        // Greedy pack: assign to first available lane
        const newLanes: Lane[] = [];
        for (const item of allItems) {
          let placed = false;
          for (const lane of newLanes) {
            if (!lane.items.some((existing) => overlaps(existing, item))) {
              lane.items.push(item);
              placed = true;
              break;
            }
          }
          if (!placed) {
            newLanes.push({ id: `lane_${crypto.randomUUID()}`, items: [item] });
          }
        }
        
        if (newLanes.length === 0) {
          newLanes.push({ id: `lane_${crypto.randomUUID()}`, items: [] });
        }
        
        // Remove virtual planRecurring items (they render as floating badges, not lane items)
        for (const lane of newLanes) {
          lane.items = lane.items.filter((it) => !it.id.startsWith("virt_pr_"));
        }
        
        const next = [...prev];
        next[pIdx] = { ...project, lanes: newLanes };
        return next;
      });
    } else {
      // Switch to hybrid cascade
      setCascadedProjects((prev) => ({ ...prev, [projectId]: true }));
      setProjects((prev) => {
        const pIdx = prev.findIndex((p) => p.id === projectId);
        if (pIdx < 0) return prev;
        const project = prev[pIdx];
        
        // Collect all items (including virtual items from planRecurring)
        const allItems: LaneItem[] = [];
        for (const lane of project.lanes) {
          for (const it of lane.items) {
            allItems.push(it);
          }
        }
        
        // Add planRecurring as virtual task items (one per day)
        const virtualRecurring: LaneItem[] = [];
        for (const r of planRecurring) {
          if (r.projectId !== project.id) continue;
          for (const day of days) {
            const dt = parseDay(day);
            if (dt.getUTCDay() === r.weekday) {
              virtualRecurring.push({
                id: `virt_pr_${r.id}_${day}`,
                type: "task",
                title: `↻ ${r.title}`,
                start: day,
                end: day,
              });
            }
          }
        }
        allItems.push(...virtualRecurring);
        
        // Sort by start date, then by end date
        allItems.sort((a, b) => {
          const cmpStart = compareDay(a.start, b.start);
          if (cmpStart !== 0) return cmpStart;
          return compareDay(a.end, b.end);
        });
        
        // Pure cascade: each item goes to its chronological index (0, 1, 2, ...)
        // BUT: if item doesn't overlap with ANY earlier item, reset to lane 0 (new substack)
        const itemToLane: Map<LaneItem, number> = new Map();
        let currentLane = 0;
        
        for (let i = 0; i < allItems.length; i++) {
          const item = allItems[i];
          
          // Check if this item overlaps with ANY earlier item
          const overlapsWithEarlier = allItems
            .slice(0, i)
            .some((earlier) => overlaps(earlier, item));
          
          if (overlapsWithEarlier) {
            // Overlaps → increment lane (cascade)
            itemToLane.set(item, currentLane);
            currentLane++;
          } else {
            // No overlap → reset to lane 0 (new substack)
            currentLane = 0;
            itemToLane.set(item, currentLane);
            currentLane++;
          }
        }
        
        // Group by lane index
        const maxLane = Math.max(...Array.from(itemToLane.values()), 0);
        const newLanes: Lane[] = [];
        for (let i = 0; i <= maxLane; i++) {
          const itemsInLane = allItems.filter((it) => itemToLane.get(it) === i);
          if (itemsInLane.length > 0) {
            newLanes.push({ id: `lane_${crypto.randomUUID()}`, items: itemsInLane });
          }
        }
        
        if (newLanes.length === 0) {
          newLanes.push({ id: `lane_${crypto.randomUUID()}`, items: [] });
        }
        
        // Remove virtual planRecurring items (they render as floating badges, not lane items)
        for (const lane of newLanes) {
          lane.items = lane.items.filter((it) => !it.id.startsWith("virt_pr_"));
        }
        
        const next = [...prev];
        next[pIdx] = { ...project, lanes: newLanes };
        return next;
      });
    }
  }

  function copyExperiment(projectId: string, experimentId: string) {
    setProjects((prev) => {
      const pIdx = prev.findIndex((p) => p.id === projectId);
      if (pIdx < 0) return prev;
      const project = prev[pIdx];
      // Find the experiment
      let found: LaneItem | null = null;
      for (const lane of project.lanes) {
        const item = lane.items.find((it) => it.id === experimentId);
        if (item) { found = item; break; }
      }
      if (!found || found.type !== "experiment") return prev;
      // Deep clone with new IDs
      const cloned: LaneItem = {
        ...found,
        id: `it_${crypto.randomUUID()}`,
        subTasks: Object.fromEntries(
          Object.entries((found as any).subTasks ?? {}).map(([day, tasks]: [string, any]) => [
            day,
            tasks.map((st: any) => ({ ...st, id: `st_${crypto.randomUUID()}` })),
          ])
        ),
      };
      // Place into a new lane using placeItemPacked (null = new lane)
      const next = [...prev];
      next[pIdx] = placeItemPacked(project, null, cloned);
      return next;
    });
  }


  function startRange(projectId: string, laneId: string, day: DayKey, pointerId: number) {
    if (resizeExp) return;
    setSelection(null);
    setDragCreate({ projectId, laneId, startDay: day, currentDay: day, pointerId, moved: false });
  }

  function updateRange(day: DayKey) {
    if (resizeExp) return;
    setDragCreate((s) => (s ? { ...s, currentDay: day, moved: true } : s));
  }

  function finishRange(pointerId: number, clickedDay: DayKey, clickedExperimentId: string | null) {
    if (resizeExp) return;
    setDragCreate((s) => {
      if (!s) return s;
      if (s.pointerId !== pointerId) return s;
      if (!s.moved || s.startDay === s.currentDay) {
        if (clickedExperimentId) {
          addExperimentSubTask(s.projectId, s.laneId, clickedExperimentId, clickedDay);
        } else {
          addStandaloneTask(s.projectId, s.laneId, clickedDay);
        }
      } else {
        addExperimentRange(s.projectId, s.laneId, s.startDay, s.currentDay);
      }
      return null;
    });
  }

  function updateExperimentDesc(projectId: string, itemId: string, desc: string) {
    setProjects((prev) => {
      const next = structuredClone(prev) as Project[];
      const pIdx = next.findIndex((p) => p.id === projectId);
      if (pIdx === -1) return prev;
      const project = next[pIdx];
      let found: { laneId: string; item: LaneItem } | null = null;
      for (const l of project.lanes) {
        const it = l.items.find((x) => x.id === itemId);
        if (it) { found = { laneId: l.id, item: it }; break; }
      }
      if (!found || found.item.type !== "experiment") return prev;
      const updated: LaneItem = { ...found.item, desc: (desc ?? "").trim() };
      next[pIdx] = placeItemPacked(project, found.laneId, updated, found.item.id);
      return next;
    });
  }

  function updateItemTitle(projectId: string, itemId: string, title: string) {
    // Find the task's day first (needed for timedEvent sync)
    let taskDay: DayKey | null = null;
    setProjects((prev) => {
      const next = structuredClone(prev) as Project[];
      const pIdx = next.findIndex((p) => p.id === projectId);
      if (pIdx === -1) return prev;
      const project = next[pIdx];
      let found: { laneId: string; item: LaneItem } | null = null;
      for (const l of project.lanes) {
        const it = l.items.find((x) => x.id === itemId);
        if (it) { found = { laneId: l.id, item: it }; break; }
      }
      if (!found || found.item.type !== "task") return prev;
      taskDay = found.item.start;
      const updated: LaneItem = { ...found.item, title };
      next[pIdx] = placeItemPacked(project, found.laneId, updated, found.item.id);
      return next;
    });

    // Auto-sync calendar time if title contains HH:MM-HH:MM
    const evtId = `t:${projectId}:${itemId}`;
    const timeRange = parseTimeRange(title);
    if (timeRange && taskDay) {
      setTimedEvents((prev) => ({
        ...prev,
        [evtId]: { id: evtId, day: taskDay!, startMin: timeRange.startMin, endMin: timeRange.endMin },
      }));
    }
    // If time was removed from title, remove auto-created event
    // (only if it was auto-created, i.e., startMin/endMin match what would have been parsed)
    // We don't remove manually placed events — user may have dragged it
  }

  function deleteItem(projectId: string, itemId: string) {
    setProjects((prev) => {
      const next = structuredClone(prev) as Project[];
      const pIdx = next.findIndex((p) => p.id === projectId);
      if (pIdx === -1) return prev;
      next[pIdx] = deleteItemFromProject(next[pIdx], itemId);
      return next;
    });
    setSelection((s) => (s && s.kind === "item" && s.projectId === projectId && s.itemId === itemId ? null : s));
  }

  function updateExperimentRange(projectId: string, laneId: string, expId: string, patch: { start?: DayKey; end?: DayKey }) {
    setProjects((prev) => {
      const next = structuredClone(prev) as Project[];
      const pIdx = next.findIndex((p) => p.id === projectId);
      if (pIdx === -1) return prev;
      const project = next[pIdx];
      const lane = findLane(project, laneId);
      if (!lane) return prev;
      const exp = lane.items.find((it) => it.id === expId);
      if (!exp || exp.type !== "experiment") return prev;

      const bounds = subTaskBounds(exp);
      let ns = patch.start ?? exp.start;
      let ne = patch.end ?? exp.end;

      if (compareDay(ns, ne) > 0) {
        if (patch.start) ns = ne;
        if (patch.end) ne = ns;
      }

      if (bounds) {
        if (compareDay(ns, bounds.min) > 0) ns = bounds.min;
        if (compareDay(ne, bounds.max) < 0) ne = bounds.max;
      }

      const updated: LaneItem = { ...exp, start: ns, end: ne };
      if (!canPlaceInLane(lane, updated, exp.id)) return prev;

      const newLane = upsertIntoLane(lane, updated, exp.id);
      const newLanes = project.lanes.map((l) => (l.id === laneId ? newLane : l));
      next[pIdx] = { ...project, lanes: newLanes };
      return next;
    });
  }

  function startResize(projectId: string, laneId: string, expId: string, edge: "start" | "end", pointerId: number) {
    setSelection({ kind: "item", projectId, itemId: expId });
    setDragCreate(null);
    setResizeExp({ projectId, laneId, expId, edge, pointerId });
  }

  function updateResize(day: DayKey) {
    setResizeExp((s) => {
      if (!s) return s;
      if (s.edge === "start") updateExperimentRange(s.projectId, s.laneId, s.expId, { start: day });
      else updateExperimentRange(s.projectId, s.laneId, s.expId, { end: day });
      return s;
    });
  }

  function finishResize(pointerId: number) {
    setResizeExp((s) => (s && s.pointerId === pointerId ? null : s));
  }

  function addLane(projectId: string) {
    setProjects((prev) => {
      const next = structuredClone(prev) as Project[];
      const pIdx = next.findIndex((p) => p.id === projectId);
      if (pIdx === -1) return prev;
      next[pIdx].lanes.push({ id: `lane_${crypto.randomUUID()}`, items: [] });
      return next;
    });
  }

  function nextProjectColor(i: number) {
    const palette = ["#f59e0b", "#22c55e", "#3b82f6", "#ef4444", "#a855f7", "#14b8a6", "#f97316", "#84cc16"];
    return palette[i % palette.length];
  }

  function addProject() {
    setProjects((prev) => {
      const next = structuredClone(prev) as Project[];
      const p: Project = {
        id: `p_${crypto.randomUUID()}`,
        name: `Project ${next.length + 1}`,
        color: nextProjectColor(next.length),
        lanes: [{ id: `lane_${crypto.randomUUID()}`, items: [] }],
      };
      next.push(p);
      return next;
    });
  }

  function updateProjectName(projectId: string, name: string) {
    setProjects((prev) => {
      const next = structuredClone(prev) as Project[];
      const idx = next.findIndex((p) => p.id === projectId);
      if (idx === -1) return prev;
      next[idx].name = name;
      return next;
    });
  }

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || el?.isContentEditable) return;
      if (!selection) return;
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        if (selection.kind === "item") deleteItem(selection.projectId, selection.itemId);
        if (selection.kind === "subtask") deleteExperimentSubTask(selection.projectId, selection.experimentId, selection.subTaskId);
      }
      if (e.key === "Escape") { setSelection(null); setResizeExp(null); }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selection]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setDayFocus(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Re-measure plan width after view switches (DOM may not have updated yet on first render)
  useEffect(() => {
    if (viewMode !== "plan") return;
    // Use rAF to let React finish rendering the plan grid before measuring
    const id = requestAnimationFrame(() => {
      const id2 = requestAnimationFrame(() => measurePlanW());
      return id2;
    });
    return () => cancelAnimationFrame(id);
  }, [viewMode, windowLen, days.length]);

  // Listen for title rename events from CalendarView (double-click to edit)
  useEffect(() => {
    const handler = (e: Event) => {
      const { id, title } = (e as CustomEvent<{ id: string; title: string }>).detail;
      // id is a TaskRef id like "t:projId:itemId" or "st:projId:expId:stId"
      if (id.startsWith("t:")) {
        const parts = id.split(":");
        const projectId = parts[1];
        const itemId = parts[2];
        updateItemTitle(projectId, itemId, title);
      } else if (id.startsWith("st:")) {
        const parts = id.split(":");
        const projectId = parts[1];
        const experimentId = parts[2];
        const subTaskId = parts[3];
        updateExperimentSubTaskTitle(projectId, experimentId, subTaskId, title);
      }
    };
    window.addEventListener("cal-rename-task", handler);
    return () => window.removeEventListener("cal-rename-task", handler);
  }, []);

  // Listen for cal-delete-task events from calendar EventBox
  useEffect(() => {
    const handler = (e: Event) => {
      const { projectId, itemId } = (e as CustomEvent).detail;
      if (projectId && itemId) deleteItem(projectId, itemId);
    };
    window.addEventListener("cal-delete-task", handler);
    return () => window.removeEventListener("cal-delete-task", handler);
  }, []);

  useEffect(() => {
    if (!resizeExp) return;
    const pid = resizeExp.pointerId;
    const stop = (e: PointerEvent) => { if (e.pointerId !== pid) return; setResizeExp(null); };
    window.addEventListener("pointerup", stop, true);
    window.addEventListener("pointercancel", stop, true);
    window.addEventListener("blur", () => setResizeExp(null));
    return () => {
      window.removeEventListener("pointerup", stop, true);
      window.removeEventListener("pointercancel", stop, true);
      window.removeEventListener("blur", () => setResizeExp(null));
    };
  }, [resizeExp]);

  const dayAgenda = useMemo(() => {
    if (!dayFocus) return [] as Array<{ project: Project; rows: Array<{ id: string; title: string; kind: "task" | "exp"; meta: any }> }>;
    const out: Array<{ project: Project; rows: Array<{ id: string; title: string; kind: "task" | "exp"; meta: any }> }> = [];

    for (const p of projects) {
      const rows: Array<{ id: string; title: string; kind: "task" | "exp"; meta: any }> = [];
      for (const lane of p.lanes) {
        for (const it of lane.items) {
          if (it.type === "task" && it.start === dayFocus) {
            rows.push({ id: `t:${p.id}:${it.id}`, title: it.title, kind: "task", meta: { projectId: p.id, itemId: it.id } });
          }
          if (it.type === "experiment") {
            const tasks = it.subTasks?.[dayFocus] ?? [];
            for (const st of tasks) {
              rows.push({ id: `st:${p.id}:${it.id}:${st.id}`, title: st.title, kind: "exp", meta: { projectId: p.id, experimentId: it.id, subTaskId: st.id } });
            }
          }
        }
      }
      // Add planRecurring instances for this project on this day
      const dt2 = parseDay(dayFocus);
      for (const r of planRecurring) {
        if (r.projectId === p.id && dt2.getUTCDay() === r.weekday) {
          const tr = parseTimeRange(r.title);
          const timeStr = tr ? ` (${String(Math.floor(tr.startMin/60)).padStart(2,"0")}:${String(tr.startMin%60).padStart(2,"0")}–${String(Math.floor(tr.endMin/60)).padStart(2,"0")}:${String(tr.endMin%60).padStart(2,"0")})` : "";
          rows.push({ id: `pr:${r.id}:${dayFocus}`, title: `↻ ${r.title}${timeStr}`, kind: "task", meta: { isPlanRecurring: true } });
        }
      }
      if (rows.length) out.push({ project: p, rows });
    }

    // Also show calendar-only recurring events (not tied to a project)
    const dtFocus = parseDay(dayFocus);
    const calRecRows: Array<{ id: string; title: string; kind: "task" | "exp"; meta: any }> = [];
    for (const r of recurring) {
      if (dtFocus.getUTCDay() === r.weekday) {
        const timeStr = ` (${String(Math.floor(r.startMin/60)).padStart(2,"0")}:${String(r.startMin%60).padStart(2,"0")}–${String(Math.floor(r.endMin/60)).padStart(2,"0")}:${String(r.endMin%60).padStart(2,"0")})`;
        calRecRows.push({ id: `calrec:${r.id}`, title: `↻ ${r.title}${timeStr}`, kind: "task", meta: { isCalRecurring: true } });
      }
    }
    if (calRecRows.length) {
      // Add under a virtual "Calendar" project entry
      const virtualProject: Project = { id: "__cal__", name: "Calendar", color: "#0ea5e9", lanes: [] };
      out.push({ project: virtualProject, rows: calRecRows });
    }

    return out;
  }, [dayFocus, projects, planRecurring, recurring]);

  const cellW = useMemo(() => {
    if (!planW) return 120;
    const usable = planW;
    const raw = usable / Math.max(1, days.length);
    const min = windowLen === 28 ? 36 : windowLen === 14 ? 60 : 80;
    return Math.floor(Math.max(min, raw));
  }, [planW, days.length, windowLen]);

  if (loadingAuth) {
    return <div style={{ padding: 16 }}>Loading…</div>;
  }

  if (!user) {
    return (
      <div style={{ padding: 16, maxWidth: 360 }}>
        <h2 style={{ marginBottom: 12 }}>Sign in</h2>

        <div style={{ display: "grid", gap: 8 }}>
          <input
            type="email"
            placeholder="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <input
            type="password"
            placeholder="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />

          <button
            onClick={async () => {
              setAuthError(null);
              const { error } = await supabase.auth.signInWithPassword({ email, password });
              if (error) setAuthError(error.message);
            }}
          >
            Sign in
          </button>

          <button
            onClick={async () => {
              setAuthError(null);
              const { error } = await supabase.auth.signUp({ email, password });
              if (error) setAuthError(error.message);
            }}
          >
            Sign up
          </button>

          {authError && <div style={{ color: "red" }}>{authError}</div>}
        </div>
      </div>
    );
  }

  if (loadingCloud) {
    return <div style={{ padding: 16 }}>Loading planner…</div>;
  }

  return (
    <>
      <style>{`
        /* ===== DARK MODE OVERRIDES ===== */
        .dark .dm-surface { background: #1c1c1e !important; }
        .dark .dm-card { background: #2c2c2e !important; border-color: #3a3a3c !important; }
        .dark .dm-btn { background: #2c2c2e !important; border-color: #3a3a3c !important; color: #e5e5e7 !important; }
        .dark .dm-btn:hover { background: #3a3a3c !important; }
        .dark .dm-text { color: #e5e5e7 !important; }
        .dark .dm-text-secondary { color: #a1a1a6 !important; }
        .dark .dm-input { background: #2c2c2e !important; border-color: #3a3a3c !important; color: #e5e5e7 !important; }
        .dark .dm-header-cell { background: #2c2c2e !important; border-color: #3a3a3c !important; }
        .dark .dm-header-cell:hover { background: #3a3a3c !important; }
        .dark .dm-project-header { border-color: #3a3a3c !important; }
        .dark .dm-popover { background: #2c2c2e !important; border-color: #3a3a3c !important; color: #e5e5e7 !important; }
        .dark .dm-popover input, .dark .dm-popover textarea, .dark .dm-popover select { background: #1c1c1e !important; border-color: #3a3a3c !important; color: #e5e5e7 !important; }
        .dark .dm-popover button { background: #3a3a3c !important; border-color: #48484a !important; color: #e5e5e7 !important; }
        .dark .dm-popover button:hover { background: #48484a !important; }
        
        /* ===== PRINT STYLES ===== */
        @media print {
          @page { margin: 10mm; size: portrait; }
          body { background: white !important; }
          * { print-color-adjust: exact !important; -webkit-print-color-adjust: exact !important; }
          
          /* Hide the entire interactive app */
          [data-app-interactive] { display: none !important; }
          
          /* Show the print-only view */
          [data-print-view] { display: block !important; }
        }
      `}</style>
      <div
        data-app-interactive
        className="h-screen overflow-hidden p-6"
        style={({ 
          background: darkMode ? '#1c1c1e' : '#fafafa', 
          color: darkMode ? '#e5e5e7' : '#18181b',
          '--cell-bg': darkMode ? '#2c2c2e' : 'white',
          '--cell-border': darkMode ? '#3a3a3c' : '#e4e4e7',
          '--today-bg': darkMode ? 'rgba(56, 100, 180, 0.25)' : 'rgba(191, 219, 254, 0.6)',
          '--weekend-bg': darkMode ? 'rgba(160, 60, 60, 0.15)' : 'rgba(254, 202, 202, 0.4)',
        } as any)}
        onClick={() => { 
          if (skipNextDeselectRef.current) { skipNextDeselectRef.current = false; return; }
          setSelection(null); setResizeExp(null); 
        }}
      >
      <DndContext sensors={sensors} collisionDetection={collisionDetection} onDragEnd={onDragEnd}>
      <div className="mx-auto flex h-full max-w-[1500px] flex-col">
        {/* Sticky top bar */}
        <div className="sticky top-0 z-50 pb-4" style={{ background: darkMode ? '#1c1c1e' : '#fafafa' }}>
          <div className="flex items-start justify-between gap-4" data-print-hide>
            <div className="flex items-center gap-2">
              {/* View mode toggle */}
              <div className="flex items-center gap-1 rounded-xl border p-1 shadow-sm dm-card" style={{ background: darkMode ? '#2c2c2e' : 'white', borderColor: darkMode ? '#3a3a3c' : '#e4e4e7' }}>
                <button
                  className="rounded-lg px-3 py-1.5 text-sm hover:opacity-80"
                  style={viewMode === "plan" ? { background: darkMode ? '#e5e5e7' : '#18181b', color: darkMode ? '#1c1c1e' : 'white' } : { background: darkMode ? '#2c2c2e' : 'white', color: darkMode ? '#e5e5e7' : '#18181b' }}
                  onClick={() => setViewMode("plan")}
                >
                  Plan
                </button>
                <button
                  className="rounded-lg px-3 py-1.5 text-sm hover:opacity-80"
                  style={viewMode === "calendar" ? { background: darkMode ? '#e5e5e7' : '#18181b', color: darkMode ? '#1c1c1e' : 'white' } : { background: darkMode ? '#2c2c2e' : 'white', color: darkMode ? '#e5e5e7' : '#18181b' }}
                  onClick={() => setViewMode("calendar")}
                >
                  Calendar
                </button>
                <button
                  className="rounded-lg px-3 py-1.5 text-sm hover:opacity-80"
                  style={viewMode === "agenda" ? { background: darkMode ? '#e5e5e7' : '#18181b', color: darkMode ? '#1c1c1e' : 'white' } : { background: darkMode ? '#2c2c2e' : 'white', color: darkMode ? '#e5e5e7' : '#18181b' }}
                  onClick={() => setViewMode("agenda")}
                >
                  Agenda
                </button>
              </div>

              {/* Navigation */}
              <button className="rounded-xl border px-3 py-2 text-sm shadow-sm dm-btn" style={{ background: darkMode ? '#2c2c2e' : 'white', borderColor: darkMode ? '#3a3a3c' : '#e4e4e7', color: darkMode ? '#e5e5e7' : '#18181b' }} onClick={() => setWindowStart((d) => addDays(d, -windowLen))}>◀︎ -{windowLen}</button>
              <button className="rounded-xl border px-3 py-2 text-sm shadow-sm dm-btn" style={{ background: darkMode ? '#2c2c2e' : 'white', borderColor: darkMode ? '#3a3a3c' : '#e4e4e7', color: darkMode ? '#e5e5e7' : '#18181b' }} onClick={() => setWindowStart((d) => addDays(d, -1))}>◀︎ -1</button>
              <button className="rounded-xl border px-3 py-2 text-sm shadow-sm dm-btn" style={{ background: darkMode ? '#2c2c2e' : 'white', borderColor: darkMode ? '#3a3a3c' : '#e4e4e7', color: darkMode ? '#e5e5e7' : '#18181b' }} onClick={() => setWindowStart(() => addDays(todayUTC(), -2))}>Today</button>
              <button className="rounded-xl border px-3 py-2 text-sm shadow-sm dm-btn" style={{ background: darkMode ? '#2c2c2e' : 'white', borderColor: darkMode ? '#3a3a3c' : '#e4e4e7', color: darkMode ? '#e5e5e7' : '#18181b' }} onClick={() => setWindowStart((d) => addDays(d, 1))}>+1 ▶︎</button>
              <button className="rounded-xl border px-3 py-2 text-sm shadow-sm dm-btn" style={{ background: darkMode ? '#2c2c2e' : 'white', borderColor: darkMode ? '#3a3a3c' : '#e4e4e7', color: darkMode ? '#e5e5e7' : '#18181b' }} onClick={() => setWindowStart((d) => addDays(d, windowLen))}>+{windowLen} ▶︎</button>

              {/* Window length toggle */}
              <div className="flex items-center gap-1 rounded-xl border p-1 shadow-sm" style={{ background: darkMode ? '#2c2c2e' : 'white', borderColor: darkMode ? '#3a3a3c' : '#e4e4e7' }}>
                {([7, 14, 28] as const).map((n) => (
                  <button
                    key={n}
                    className="rounded-lg px-3 py-1.5 text-sm hover:opacity-80"
                    style={windowLen === n ? { background: darkMode ? '#e5e5e7' : '#18181b', color: darkMode ? '#1c1c1e' : 'white' } : { background: darkMode ? '#2c2c2e' : 'white', color: darkMode ? '#e5e5e7' : '#18181b' }}
                    onClick={() => setWindowLen(n)}
                  >
                    {n === 28 ? "4 weeks" : `${n} days`}
                  </button>
                ))}
              </div>

              <button className="rounded-xl border px-4 py-2 text-sm font-semibold shadow-sm" style={{ background: darkMode ? '#3b82f6' : '#2563eb', color: 'white', borderColor: darkMode ? '#2563eb' : '#1d4ed8' }} onClick={() => setAddTaskModal(true)}>+ Task</button>
              <button className="rounded-xl border px-3 py-2 text-sm shadow-sm dm-btn" style={{ background: darkMode ? '#2c2c2e' : 'white', borderColor: darkMode ? '#3a3a3c' : '#e4e4e7', color: darkMode ? '#e5e5e7' : '#18181b' }} onClick={() => exportJSON()} title="Export as JSON">Export</button>
              <button className="rounded-xl border px-3 py-2 text-sm shadow-sm dm-btn" style={{ background: darkMode ? '#2c2c2e' : 'white', borderColor: darkMode ? '#3a3a3c' : '#e4e4e7', color: darkMode ? '#e5e5e7' : '#18181b' }} onClick={() => exportICS()} title="Export to Google Calendar / Outlook">ICS</button>
              <button className="rounded-xl border px-3 py-2 text-sm shadow-sm dm-btn" style={{ background: darkMode ? '#2c2c2e' : 'white', borderColor: darkMode ? '#3a3a3c' : '#e4e4e7', color: darkMode ? '#e5e5e7' : '#18181b' }} onClick={() => fileInputRef.current?.click()}>Import</button>
              <input
                ref={fileInputRef}
                type="file"
                accept="application/json"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) importJSON(f);
                  e.currentTarget.value = "";
                }}
              />
              <button className="rounded-xl border px-3 py-2 text-sm shadow-sm dm-btn" style={{ background: darkMode ? '#2c2c2e' : 'white', borderColor: darkMode ? '#3a3a3c' : '#e4e4e7', color: darkMode ? '#e5e5e7' : '#18181b' }} onClick={() => setInboxOpen((v) => !v)}>Inbox</button>
              <button 
                className="rounded-xl border px-3 py-2 text-sm shadow-sm dm-btn"
                style={{ background: darkMode ? '#2c2c2e' : 'white', borderColor: darkMode ? '#3a3a3c' : '#e4e4e7', color: darkMode ? '#e5e5e7' : '#18181b' }}
                onClick={() => setDarkMode((v) => !v)}
                title={darkMode ? "Light mode" : "Dark mode"}
              >
                {darkMode ? "☀️" : "🌙"}
              </button>
              {/* Autosave indicator — plain text */}
              {savedAt && (
                <span className="text-xs" style={{ color: darkMode ? '#636366' : '#a1a1aa' }}>
                  saved {savedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </span>
              )}
              {archivedProjects.length > 0 && (
                <button
                  className="rounded-xl border px-3 py-2 text-sm shadow-sm dm-btn"
                  style={{ background: darkMode ? '#2c2c2e' : 'white', borderColor: darkMode ? '#3a3a3c' : '#e4e4e7', color: darkMode ? '#a1a1a6' : '#71717a' }}
                  onClick={() => setShowArchive((v) => !v)}
                  title="Archived projects"
                >
                  Archive ({archivedProjects.length})
                </button>
              )}
            </div>
          </div>

          {/* Date header strip — now inside plan view scroll container */}
        </div>

        {/* ---- PLAN VIEW ---- */}
        {viewMode === "plan" && (() => {
          // Inject planRecurring as actual lane items (not floating badges)
          const projectsWithRecurring = projects.map((proj) => {
            const recItemsForProject = planRecurringInstances
              .filter((r) => r.projectId === proj.id)
              .map((r): LaneItem => ({
                id: r.id,
                type: "task",
                title: r.title,
                start: r.day,
                end: r.day,
              }));
            
            if (recItemsForProject.length === 0) return proj;
            
            // Pack recurring items into multiple lanes to avoid same-day overlap
            const recLanes: LaneItem[][] = [];
            for (const item of recItemsForProject) {
              let placed = false;
              for (const lane of recLanes) {
                const conflict = lane.some((existing) => existing.start === item.start);
                if (!conflict) {
                  lane.push(item);
                  placed = true;
                  break;
                }
              }
              if (!placed) {
                recLanes.push([item]);
              }
            }
            
            const updatedLanes = [...proj.lanes.filter((l) => !l.id.startsWith("__rec_"))];
            recLanes.forEach((items, idx) => {
              updatedLanes.push({ id: `__rec_${proj.id}_${idx}`, items });
            });
            
            return { ...proj, lanes: updatedLanes };
          });
          
          return (
          <div className="mt-4 flex min-h-0 flex-1 flex-col" data-plan-view>
            <div
              ref={planWrapRef}
              className="min-h-0 flex-1 overflow-auto rounded-2xl border shadow-sm"
              style={{ background: darkMode ? '#2c2c2e' : 'white', borderColor: darkMode ? '#3a3a3c' : '#e4e4e7' }}
            >
              <div>

                  {/* Sticky date header inside scroll container */}
                  <div
                    ref={planHeaderRef}
                    data-date-header
                    className="sticky top-0 z-20 flex"
                    style={{ width: days.length * cellW, background: darkMode ? '#2c2c2e' : 'white' }}
                  >
                    {days.map((d) => {
                      const { weekday, md } = dayLabel(d);
                      const wk = weekday.toLowerCase();
                      const isWeekend = wk.startsWith("sat") || wk.startsWith("sun") || wk.startsWith("so") || wk.startsWith("ne");
                      const isToday = d === todayUTC();
                      return (
                        <div
                          key={d}
                          className="border-b border-r text-center cursor-pointer dm-header-cell"
                          style={{ 
                            width: cellW, minWidth: cellW, maxWidth: cellW, flexShrink: 0, flexGrow: 0,
                            padding: "6px 4px",
                            borderColor: darkMode ? '#3a3a3c' : '#e4e4e7',
                            background: isToday ? (darkMode ? 'rgba(56, 100, 180, 0.25)' : '#eff6ff') : isWeekend ? (darkMode ? 'rgba(160, 60, 60, 0.15)' : 'rgba(254, 226, 226, 0.6)') : (darkMode ? '#2c2c2e' : 'white'),
                            boxSizing: 'border-box',
                          }}
                          onClick={(e) => { e.stopPropagation(); setDayFocus(d); }}
                          title="Click = task list for day"
                        >
                          <div className="text-xs font-medium" style={{ color: isToday ? (darkMode ? '#93bbfd' : '#2563eb') : isWeekend ? (darkMode ? '#f87171' : '#dc2626') : (darkMode ? '#a1a1a6' : '#3f3f46'), fontWeight: isToday ? 700 : 500 }}>{weekday}</div>
                          <div className="text-xs font-medium" style={{ color: isToday ? (darkMode ? '#60a5fa' : '#3b82f6') : isWeekend ? (darkMode ? '#f87171' : '#ef4444') : (darkMode ? '#8e8e93' : '#71717a') }}>
                            {isToday ? <span className="inline-block rounded-full bg-blue-500 text-white px-1.5">{md}</span> : md}
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Archive panel */}
                  {showArchive && archivedProjects.length > 0 && (
                    <div
                      className="fixed right-6 top-24 z-40 w-[340px] rounded-2xl border border-zinc-200 bg-white shadow-xl"
                      onClick={(e) => e.stopPropagation()}
                      onPointerDown={(e) => e.stopPropagation()}
                    >
                      <div className="flex items-center justify-between border-b border-zinc-200 px-3 py-2">
                        <div className="text-sm font-semibold">Archived projects</div>
                        <button
                          className="h-8 w-8 rounded-full border border-zinc-200 bg-white hover:bg-zinc-50"
                          onClick={() => setShowArchive(false)}
                        >
                          ✕
                        </button>
                      </div>
                      <div className="max-h-[60vh] overflow-auto p-2 space-y-2">
                        {archivedProjects.map((ap) => (
                          <div key={ap.id} className="flex items-center gap-2 rounded-lg border border-zinc-200 px-3 py-2">
                            <div className="h-3 w-3 rounded-full flex-shrink-0" style={{ background: ap.color }} />
                            <div className="flex-1 text-sm font-medium truncate">{ap.name}</div>
                            <button
                              className="rounded-lg border border-zinc-200 bg-white px-2 py-1 text-xs hover:bg-zinc-50"
                              onClick={() => {
                                setProjects((prev) => [...prev, ap]);
                                setArchivedProjects((prev) => prev.filter((p) => p.id !== ap.id));
                              }}
                              title="Restore project"
                            >
                              Restore
                            </button>
                            <button
                              className="rounded-lg border border-zinc-200 bg-white px-2 py-1 text-xs hover:bg-zinc-50 text-red-400"
                              onClick={() => setArchivedProjects((prev) => prev.filter((p) => p.id !== ap.id))}
                              title="Delete permanently"
                            >
                              ✕
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Projects + lanes */}
                  {projectsWithRecurring.map((project) => {
                    const isCollapsed = !!collapsedProjects[project.id];
                    return (
                    <div key={project.id}>
                      {/* Project header */}
                      <div
                        className="flex items-center gap-2 border-b px-3 py-2 dm-project-header"
                        style={{ minWidth: days.length * cellW, borderColor: darkMode ? '#3a3a3c' : '#f4f4f5' }}
                      >
                        {/* Reorder buttons — vertical */}
                        <div className="flex flex-col flex-shrink-0 gap-0.5">
                          <button
                            className="h-5 w-5 rounded text-center text-zinc-300 hover:text-zinc-600 hover:bg-zinc-100 leading-none text-[10px]"
                            onClick={(e) => { e.stopPropagation(); moveProject(project.id, "up"); }}
                            title="Move project up"
                          >▲</button>
                          <button
                            className="h-5 w-5 rounded text-center text-zinc-300 hover:text-zinc-600 hover:bg-zinc-100 leading-none text-[10px]"
                            onClick={(e) => { e.stopPropagation(); moveProject(project.id, "down"); }}
                            title="Move project down"
                          >▼</button>
                        </div>
                        <button
                          className="flex-shrink-0 w-4 text-center text-zinc-400 hover:text-zinc-700"
                          style={{ transform: isCollapsed ? "rotate(-90deg)" : "rotate(0deg)", transition: "transform 0.15s", fontSize: 14 }}
                          onClick={(e) => {
                            e.stopPropagation();
                            setCollapsedProjects((prev) => ({ ...prev, [project.id]: !prev[project.id] }));
                          }}
                          title={isCollapsed ? "Expand project" : "Collapse project"}
                        >
                          ▾
                        </button>
                        <button
                          className={"flex-shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold " + (cascadedProjects[project.id] ? "bg-blue-100 text-blue-600" : "text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100")}
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleCascade(project.id);
                          }}
                          title={cascadedProjects[project.id] ? "Switch to compact view" : "Sort lanes into cascade (Gantt)"}
                        >
                          ⚡
                        </button>
                        <button
                          className="text-xs text-zinc-400 hover:text-zinc-700"
                          onClick={(e) => { e.stopPropagation(); setDetailTarget({ kind: "project", projectId: project.id }); }}
                          title="Project notes & checklist"
                        >
                          📝
                        </button>
                        <input
                          type="color"
                          className="h-5 w-5 rounded-full flex-shrink-0 cursor-pointer border-0"
                          style={{ background: project.color }}
                          value={project.color}
                          onChange={(e) => {
                            e.stopPropagation();
                            setProjects((prev) => {
                              const next = [...prev];
                              const idx = next.findIndex((p) => p.id === project.id);
                              if (idx >= 0) next[idx] = { ...next[idx], color: e.target.value };
                              return next;
                            });
                          }}
                          onClick={(e) => e.stopPropagation()}
                          title="Change project color"
                        />
                        <input
                          className="flex-1 bg-transparent text-sm font-semibold outline-none"
                          value={project.name}
                          onChange={(e) => updateProjectName(project.id, e.target.value)}
                          onBlur={(e) => {
                            if (!e.target.value.trim()) updateProjectName(project.id, "Project");
                          }}
                          onClick={(e) => e.stopPropagation()}
                          onPointerDown={(e) => e.stopPropagation()}
                        />
                        {!isCollapsed && (
                          <button
                            className="text-xs text-zinc-400 hover:text-zinc-700"
                            onClick={(e) => { e.stopPropagation(); addLane(project.id); }}
                            title="Add lane"
                          >
                            + lane
                          </button>
                        )}
                        <button
                          className="text-xs text-zinc-400 hover:text-zinc-700"
                          onClick={(e) => { e.stopPropagation(); addProject(); }}
                          title="Add new project"
                        >
                          + project
                        </button>
                        {/* Close / remove project button */}
                        {closeConfirm === project.id ? (
                          <div
                            className="flex items-center gap-1 ml-2"
                            onClick={(e) => e.stopPropagation()}
                            onPointerDown={(e) => e.stopPropagation()}
                          >
                            <span className="text-xs text-zinc-500">Archive content?</span>
                            <button
                              className="rounded-lg border border-zinc-200 bg-white px-2 py-0.5 text-xs hover:bg-zinc-50 text-zinc-700"
                              onClick={(e) => {
                                e.stopPropagation();
                                // Archive: move project to archivedProjects, remove from active
                                setArchivedProjects((prev) => [...prev, project]);
                                setProjects((prev) => prev.filter((p) => p.id !== project.id));
                                setCloseConfirm(null);
                              }}
                            >
                              Archive
                            </button>
                            <button
                              className="rounded-lg border border-zinc-200 bg-white px-2 py-0.5 text-xs hover:bg-zinc-50 text-zinc-700"
                              onClick={(e) => {
                                e.stopPropagation();
                                // Delete without archiving
                                setProjects((prev) => prev.filter((p) => p.id !== project.id));
                                setCloseConfirm(null);
                              }}
                            >
                              Delete
                            </button>
                            <button
                              className="rounded-lg border border-zinc-200 bg-white px-2 py-0.5 text-xs hover:bg-zinc-50 text-zinc-400"
                              onClick={(e) => { e.stopPropagation(); setCloseConfirm(null); }}
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            className="ml-2 flex-shrink-0 text-zinc-300 hover:text-red-400 transition-colors"
                            style={{ fontSize: 16, lineHeight: 1 }}
                            onClick={(e) => { e.stopPropagation(); setCloseConfirm(project.id); }}
                            title="Close project"
                          >
                            ×
                          </button>
                        )}
                      </div>

                      {/* Lanes — only show lanes that have items visible in the current window, plus one empty lane */}
                      {!isCollapsed && (() => {
                        const visibleLanes = project.lanes.filter((lane) =>
                          lane.items.some((it) => !(compareDay(it.end, days[0]) < 0 || compareDay(days[days.length - 1], it.start) < 0))
                        );
                        const emptyLanes = project.lanes.filter((lane) => !visibleLanes.includes(lane));
                        // Always include one empty lane at the end for adding new items
                        const firstEmpty = emptyLanes[0];
                        const lanesToRender = firstEmpty ? [...visibleLanes, firstEmpty] : visibleLanes;
                        return lanesToRender.map((lane) => (
                        <LaneRow
                          key={lane.id}
                          project={project}
                          lane={lane}
                          days={days}
                          cellW={cellW}
                          dragCreate={dragCreate}
                          resizeExp={resizeExp}
                          onStartRange={(day, pid) => startRange(project.id, lane.id, day, pid)}
                          onUpdateRange={updateRange}
                          onFinishRange={(pid, day, expId) => finishRange(pid, day, expId)}
                          onStartResize={(expId, edge, pid) => startResize(project.id, lane.id, expId, edge, pid)}
                          onUpdateResize={updateResize}
                          onFinishResize={finishResize}
                          selection={selection}
                          onSelectItem={(projId, itemId) => setSelection({ kind: "item", projectId: projId, itemId })}
                          onDeleteItem={deleteItem}
                          onUpdateTitle={updateItemTitle}
                          onUpdateDesc={updateExperimentDesc}
                          onClearSelection={() => setSelection(null)}
                          onAddSubTask={(expId, day) => addExperimentSubTask(project.id, lane.id, expId, day)}
                          onSelectSubTask={(expId, stId) => setSelection({ kind: "subtask", projectId: project.id, experimentId: expId, subTaskId: stId })}
                          onUpdateSubTaskTitle={(expId, stId, title) => updateExperimentSubTaskTitle(project.id, expId, stId, title)}
                          onDeleteSubTask={(expId, stId) => deleteExperimentSubTask(project.id, expId, stId)}
                          onCopyExperiment={(expId) => copyExperiment(project.id, expId)}
                          planRecurringInstances={planRecurringInstances}
                          onOpenDetail={(target) => setDetailTarget(target)}
                        />
                      ));
                      })()}
                    </div>
                    );
                  })}

              </div>
            </div>
          </div>
          );
        })()}

        {/* ---- CALENDAR VIEW ---- */}
        {viewMode === "calendar" && (
          <CalendarView
            days={calDays}
            inbox={inboxTasks}
            catalog={taskCatalog}
            events={eventsForCal}
            recurring={recurring}
            onCreateEvent={(taskId, day, startMin) => {
              const t = taskCatalog.find((x) => x.id === taskId);
              if (!t) return;
              setTimedEvents((prev) => ({
                ...prev,
                [taskId]: { id: taskId, day, startMin, endMin: startMin + 60 },
              }));
            }}
            onMoveEvent={(id, patch) => setTimedEvents((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }))}
            onDeleteEvent={(id) => setTimedEvents((prev) => { const n = { ...prev }; delete n[id]; return n; })}
            onAddRecurring={(r) => setRecurring((prev) => [...prev, r])}
            onDeleteRecurring={(rid) => setRecurring((prev) => prev.filter((r) => r.id !== rid))}
            onUpdateRecurring={(rid, patch) => setRecurring((prev) => prev.map((r) => (r.id === rid ? { ...r, ...patch } : r)))}
            recurringModal={recurringModal}
            setRecurringModal={setRecurringModal}
            calendarDaysLen={calendarDaysLen}
            setCalendarDaysLen={setCalendarDaysLen}
            sensors={sensors}
            resizeEvt={resizeEvt}
            setResizeEvt={setResizeEvt}
            planRecurring={planRecurring}
            projects={projects}
            darkMode={darkMode}
            onCreateNewTask={(projectId, title, day, startMin, endMin) => {
              // 1) Create the task in the plan (first lane of the project)
              const proj = projects.find((p) => p.id === projectId);
              if (!proj) return;
              const laneId = proj.lanes[0]?.id;
              if (!laneId) return;
              const createdId = `it_${crypto.randomUUID()}`;
              const catalogId = `t:${projectId}:${createdId}`;
              const item: LaneItem = { id: createdId, type: "task", title, start: day, end: day };
              setProjects((prev) => {
                const next = structuredClone(prev) as Project[];
                const pIdx = next.findIndex((p) => p.id === projectId);
                if (pIdx === -1) return prev;
                next[pIdx] = placeItemPacked(next[pIdx], laneId, item);
                return next;
              });
              // 2) Create the timed event using the catalog-style composite ID
              setTimedEvents((prev) => ({
                ...prev,
                [catalogId]: { id: catalogId, day, startMin, endMin },
              }));
            }}
          />
        )}

        {/* ---- AGENDA VIEW ---- */}
        {viewMode === "agenda" && (
          <AgendaView
            days={days}
            projects={projects}
            planRecurringInstances={planRecurringInstances}
            darkMode={darkMode}
            completedTasks={completedTasks}
            onToggleComplete={(id) => setCompletedTasks(prev => ({ ...prev, [id]: !prev[id] }))}
            onOpenDetail={(target) => setDetailTarget(target)}
          />
        )}

        {/* ---- PLAN RECURRING MODAL ---- */}
        {planRecurringModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 p-4" onClick={() => setPlanRecurringModal(false)}>
            <div className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between mb-3">
                <div className="text-sm font-semibold">Recurring task in planner</div>
                <button className="h-8 w-8 rounded-full border border-zinc-200 bg-white hover:bg-zinc-50" onClick={() => setPlanRecurringModal(false)}>✕</button>
              </div>
              <div className="space-y-3">
                <div>
                  <div className="mb-1 text-xs text-zinc-600">Project</div>
                  <select
                    className="h-9 w-full rounded-lg border border-zinc-200 px-2 text-sm"
                    value={planRecForm.projectId || projects[0]?.id || ""}
                    onChange={(e) => setPlanRecForm((p) => ({ ...p, projectId: e.target.value }))}
                  >
                    {projects.map((pp) => <option key={pp.id} value={pp.id}>{pp.name}</option>)}
                  </select>
                </div>
                <div>
                  <div className="mb-1 text-xs text-zinc-600">Task name</div>
                  <input
                    className="h-9 w-full rounded-lg border border-zinc-200 px-3 text-sm outline-none focus:ring-2 focus:ring-zinc-300"
                    placeholder="e.g. Daily journal, Weekly meeting…"
                    value={planRecForm.title}
                    onChange={(e) => setPlanRecForm((p) => ({ ...p, title: e.target.value }))}
                  />
                </div>
                <div>
                  <div className="mb-1 text-xs text-zinc-600">Weekday</div>
                  <div className="flex gap-1 flex-wrap">
                    {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d, i) => (
                      <button
                        key={i}
                        className={"rounded-lg px-3 py-1.5 text-xs font-medium border " + (planRecForm.weekday === i ? "bg-zinc-900 text-white border-zinc-900" : "bg-white text-zinc-700 border-zinc-200 hover:bg-zinc-50")}
                        onClick={() => setPlanRecForm((p) => ({ ...p, weekday: i }))}
                      >{d}</button>
                    ))}
                  </div>
                </div>
              </div>
              <div className="mt-4 flex items-center justify-between">
                <div className="text-xs text-zinc-400">Will appear as a badge on each matching day</div>
                <button
                  className="h-9 rounded-lg bg-zinc-900 px-4 text-sm font-semibold text-white hover:bg-zinc-800"
                  onClick={() => {
                    const pid = planRecForm.projectId || projects[0]?.id;
                    if (!pid || !planRecForm.title.trim()) return;
                    setPlanRecurring((prev) => [...prev, { id: `pr_${crypto.randomUUID()}`, projectId: pid, title: planRecForm.title.trim(), weekday: planRecForm.weekday }]);
                    setPlanRecForm({ projectId: pid, title: "", weekday: planRecForm.weekday });
                    setPlanRecurringModal(false);
                  }}
                >
                  Add
                </button>
              </div>
              {planRecurring.length > 0 && (
                <div className="mt-3 border-t border-zinc-100 pt-3 space-y-1">
                  <div className="text-xs text-zinc-500 mb-1">Existing recurring tasks:</div>
                  {planRecurring.map((r) => {
                    const proj = projects.find((p) => p.id === r.projectId);
                    const days2 = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
                    return (
                      <div key={r.id} className="flex items-center gap-2 rounded-lg border border-zinc-100 px-2 py-1.5">
                        <div className="h-2.5 w-2.5 rounded-full flex-shrink-0" style={{ background: proj?.color ?? "#64748b" }} />
                        <div className="flex-1 text-xs">{r.title}</div>
                        <div className="text-[10px] text-zinc-400">{days2[r.weekday]}</div>
                        <button className="text-zinc-300 hover:text-red-400 text-sm" onClick={() => setPlanRecurring((prev) => prev.filter((x) => x.id !== r.id))}>✕</button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ---- ADD TASK MODAL ---- */}
        {addTaskModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 p-4" onClick={() => setAddTaskModal(false)}>
            <div className="w-full max-w-md rounded-2xl border bg-white p-4 shadow-xl dm-popover" style={{ background: darkMode ? '#2c2c2e' : 'white', borderColor: darkMode ? '#3a3a3c' : '#e4e4e7' }} onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between mb-3">
                <div className="text-sm font-semibold" style={{ color: darkMode ? '#e5e5e7' : '#18181b' }}>Add task</div>
                <button className="h-8 w-8 rounded-full border hover:bg-zinc-50 dm-btn" style={{ borderColor: darkMode ? '#48484a' : '#e4e4e7' }} onClick={() => setAddTaskModal(false)}>✕</button>
              </div>
              <div className="space-y-3">
                <div>
                  <div className="mb-1 text-xs" style={{ color: darkMode ? '#a1a1a6' : '#71717a' }}>Project</div>
                  <select
                    className="h-9 w-full rounded-lg border px-2 text-sm dm-input"
                    style={{ background: darkMode ? '#1c1c1e' : 'white', borderColor: darkMode ? '#3a3a3c' : '#e4e4e7', color: darkMode ? '#e5e5e7' : '#18181b' }}
                    value={addTaskForm.projectId || projects[0]?.id || ""}
                    onChange={(e) => setAddTaskForm((p) => ({ ...p, projectId: e.target.value }))}
                  >
                    {projects.map((pp) => <option key={pp.id} value={pp.id}>{pp.name}</option>)}
                  </select>
                </div>
                <div>
                  <div className="mb-1 text-xs" style={{ color: darkMode ? '#a1a1a6' : '#71717a' }}>Task name</div>
                  <input
                    autoFocus
                    className="h-9 w-full rounded-lg border px-3 text-sm outline-none focus:ring-2 focus:ring-blue-300 dm-input"
                    style={{ background: darkMode ? '#1c1c1e' : 'white', borderColor: darkMode ? '#3a3a3c' : '#e4e4e7', color: darkMode ? '#e5e5e7' : '#18181b' }}
                    placeholder="e.g. Write report, Team meeting…"
                    value={addTaskForm.title}
                    onChange={(e) => setAddTaskForm((p) => ({ ...p, title: e.target.value }))}
                  />
                </div>
                <div>
                  <div className="mb-1 text-xs" style={{ color: darkMode ? '#a1a1a6' : '#71717a' }}>Notes (optional)</div>
                  <textarea
                    className="h-16 w-full resize-none rounded-lg border p-2 text-sm outline-none focus:ring-2 focus:ring-blue-300 dm-input"
                    style={{ background: darkMode ? '#1c1c1e' : 'white', borderColor: darkMode ? '#3a3a3c' : '#e4e4e7', color: darkMode ? '#e5e5e7' : '#18181b' }}
                    placeholder="Details, links, context…"
                    value={addTaskForm.notes}
                    onChange={(e) => setAddTaskForm((p) => ({ ...p, notes: e.target.value }))}
                  />
                </div>
                <div>
                  <div className="mb-1 text-xs" style={{ color: darkMode ? '#a1a1a6' : '#71717a' }}>Date</div>
                  <input
                    type="date"
                    className="h-9 w-full rounded-lg border px-3 text-sm dm-input"
                    style={{ background: darkMode ? '#1c1c1e' : 'white', borderColor: darkMode ? '#3a3a3c' : '#e4e4e7', color: darkMode ? '#e5e5e7' : '#18181b' }}
                    value={addTaskForm.day}
                    onChange={(e) => setAddTaskForm((p) => ({ ...p, day: e.target.value }))}
                  />
                </div>
                <div>
                  <label className="flex items-center gap-2 text-xs cursor-pointer" style={{ color: darkMode ? '#a1a1a6' : '#71717a' }}>
                    <input type="checkbox" checked={addTaskForm.timeEnabled} onChange={(e) => setAddTaskForm((p) => ({ ...p, timeEnabled: e.target.checked }))} />
                    Schedule time (show in calendar)
                  </label>
                  {addTaskForm.timeEnabled && (
                    <div className="flex gap-2 mt-1">
                      <input type="time" className="h-8 flex-1 rounded-lg border px-2 text-sm dm-input" style={{ background: darkMode ? '#1c1c1e' : 'white', borderColor: darkMode ? '#3a3a3c' : '#e4e4e7', color: darkMode ? '#e5e5e7' : '#18181b' }}
                        value={addTaskForm.startTime} onChange={(e) => setAddTaskForm((p) => ({ ...p, startTime: e.target.value }))} />
                      <span className="text-xs self-center" style={{ color: darkMode ? '#636366' : '#a1a1aa' }}>to</span>
                      <input type="time" className="h-8 flex-1 rounded-lg border px-2 text-sm dm-input" style={{ background: darkMode ? '#1c1c1e' : 'white', borderColor: darkMode ? '#3a3a3c' : '#e4e4e7', color: darkMode ? '#e5e5e7' : '#18181b' }}
                        value={addTaskForm.endTime} onChange={(e) => setAddTaskForm((p) => ({ ...p, endTime: e.target.value }))} />
                    </div>
                  )}
                </div>
                <div>
                  <label className="flex items-center gap-2 text-xs cursor-pointer" style={{ color: darkMode ? '#a1a1a6' : '#71717a' }}>
                    <input type="checkbox" checked={addTaskForm.recurring} onChange={(e) => setAddTaskForm((p) => ({ ...p, recurring: e.target.checked }))} />
                    Repeat weekly
                  </label>
                  {addTaskForm.recurring && (
                    <div className="flex gap-1 flex-wrap mt-1">
                      {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d, i) => (
                        <button
                          key={i}
                          className={"rounded-lg px-3 py-1.5 text-xs font-medium border " + (addTaskForm.recurringWeekday === i ? "bg-zinc-900 text-white border-zinc-900" : "bg-white text-zinc-700 border-zinc-200 hover:bg-zinc-50")}
                          onClick={() => setAddTaskForm((p) => ({ ...p, recurringWeekday: i }))}
                        >{d}</button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              <div className="mt-4 flex justify-end">
                <button
                  className="h-9 rounded-lg px-5 text-sm font-semibold text-white"
                  style={{ background: '#2563eb' }}
                  onClick={() => {
                    const pid = addTaskForm.projectId || projects[0]?.id;
                    if (!pid || !addTaskForm.title.trim()) return;
                    const proj = projects.find((p) => p.id === pid);
                    if (!proj) return;
                    const laneId = proj.lanes[0]?.id;
                    if (!laneId) return;

                    // Create the task in plan
                    const createdId = `it_${crypto.randomUUID()}`;
                    const catalogId = `t:${pid}:${createdId}`;
                    const item: LaneItem = { 
                      id: createdId, type: "task", title: addTaskForm.title.trim(), 
                      start: addTaskForm.day, end: addTaskForm.day,
                      ...(addTaskForm.notes.trim() ? { notes: addTaskForm.notes.trim() } : {}),
                    };
                    setProjects((prev) => {
                      const next = structuredClone(prev) as Project[];
                      const pIdx = next.findIndex((p) => p.id === pid);
                      if (pIdx === -1) return prev;
                      next[pIdx] = placeItemPacked(next[pIdx], laneId, item);
                      return next;
                    });

                    // Optionally schedule in calendar
                    if (addTaskForm.timeEnabled) {
                      const [sh, sm] = addTaskForm.startTime.split(":").map(Number);
                      const [eh, em] = addTaskForm.endTime.split(":").map(Number);
                      const startMin = sh * 60 + sm;
                      const endMin = eh * 60 + em;
                      setTimedEvents((prev) => ({
                        ...prev,
                        [catalogId]: { id: catalogId, day: addTaskForm.day, startMin, endMin: endMin > startMin ? endMin : startMin + 60 },
                      }));
                    }

                    // Optionally add recurring
                    if (addTaskForm.recurring) {
                      setPlanRecurring((prev) => [...prev, { 
                        id: `pr_${crypto.randomUUID()}`, projectId: pid, 
                        title: addTaskForm.title.trim(), weekday: addTaskForm.recurringWeekday 
                      }]);
                    }

                    setAddTaskForm((prev) => ({ ...prev, title: "", notes: "", timeEnabled: false, recurring: false }));
                    setAddTaskModal(false);
                  }}
                >
                  Add task
                </button>
              </div>
            </div>
          </div>
        )}


        {/* ---- GLOBAL INBOX PANEL (all views) ---- */}
        {inboxOpen && (
          <div
            className="fixed right-6 top-24 z-40 w-[340px] rounded-2xl border shadow-xl"
            style={{ background: darkMode ? '#2c2c2e' : 'white', borderColor: darkMode ? '#3a3a3c' : '#e4e4e7', color: darkMode ? '#e5e5e7' : '#18181b' }}
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b px-3 py-2" style={{ borderColor: darkMode ? '#3a3a3c' : '#e4e4e7' }}>
              <div className="text-sm font-semibold">Inbox</div>
              <button
                className="h-8 w-8 rounded-full border"
                style={{ background: darkMode ? '#3a3a3c' : 'white', borderColor: darkMode ? '#48484a' : '#e4e4e7', color: darkMode ? '#e5e5e7' : '#18181b' }}
                onClick={() => setInboxOpen(false)}
                title="Close"
              >✕</button>
            </div>
            <div className="flex flex-wrap gap-1 border-b p-2" style={{ borderColor: darkMode ? '#3a3a3c' : '#e4e4e7' }}>
              <button className={"rounded-lg px-2 py-1 text-xs " + (inboxFilter === "all" ? (darkMode ? "bg-zinc-100 text-zinc-900" : "bg-zinc-900 text-white") : "")} style={inboxFilter !== "all" ? { background: darkMode ? '#3a3a3c' : 'white', borderColor: darkMode ? '#48484a' : '#e4e4e7', color: darkMode ? '#a1a1a6' : '#3f3f46', border: '1px solid' } : {}} onClick={() => setInboxFilter("all")}>All</button>
              {projects.map((pp) => (
                <button key={pp.id} className={"rounded-lg px-2 py-1 text-xs " + (inboxFilter === pp.id ? (darkMode ? "bg-zinc-100 text-zinc-900" : "bg-zinc-900 text-white") : "")} style={inboxFilter !== pp.id ? { background: darkMode ? '#3a3a3c' : 'white', borderColor: darkMode ? '#48484a' : '#e4e4e7', color: darkMode ? '#a1a1a6' : '#3f3f46', border: '1px solid' } : {}} onClick={() => setInboxFilter(pp.id)}>
                  {pp.name.length > 10 ? pp.name.slice(0, 10) + "…" : pp.name}
                </button>
              ))}
              <button className={"rounded-lg px-2 py-1 text-xs " + (inboxFilter === "completed" ? (darkMode ? "bg-zinc-100 text-zinc-900" : "bg-zinc-900 text-white") : "")} style={inboxFilter !== "completed" ? { background: darkMode ? '#3a3a3c' : 'white', borderColor: darkMode ? '#48484a' : '#e4e4e7', color: darkMode ? '#a1a1a6' : '#3f3f46', border: '1px solid' } : {}} onClick={() => setInboxFilter("completed")}>Completed</button>
            </div>
            {inboxFilter !== "completed" && (
              <div className="border-b p-2" style={{ borderColor: darkMode ? '#3a3a3c' : '#e4e4e7' }}>
                <div className="flex gap-2">
                  <select className="h-9 w-[120px] rounded-lg border px-2 text-sm" style={{ background: darkMode ? '#1c1c1e' : 'white', borderColor: darkMode ? '#48484a' : '#e4e4e7', color: darkMode ? '#e5e5e7' : '#18181b' }} value={inboxFilter === "all" ? projects[0]?.id ?? "" : inboxFilter} onChange={(e) => setInboxFilter(e.target.value)}>
                    {projects.map((pp) => <option key={pp.id} value={pp.id}>{pp.name}</option>)}
                  </select>
                  <input
                    className="h-9 flex-1 rounded-lg border px-2 text-sm outline-none"
                    style={{ background: darkMode ? '#1c1c1e' : 'white', borderColor: darkMode ? '#48484a' : '#e4e4e7', color: darkMode ? '#e5e5e7' : '#18181b' }}
                    placeholder="new task…"
                    value={newInboxTitle}
                    onChange={(e) => setNewInboxTitle(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        const pid = inboxFilter === "all" ? projects[0]?.id : inboxFilter;
                        if (!pid || pid === "all" || pid === "completed") return;
                        addInboxTask(pid, newInboxTitle);
                        setNewInboxTitle("");
                      }
                    }}
                  />
                  <button className="h-9 rounded-lg px-3 text-sm font-semibold text-white" style={{ background: darkMode ? '#636366' : '#18181b' }} onClick={() => {
                    const pid = inboxFilter === "all" ? projects[0]?.id : inboxFilter;
                    if (!pid || pid === "all" || pid === "completed") return;
                    addInboxTask(pid, newInboxTitle);
                    setNewInboxTitle("");
                  }}>+</button>
                </div>
              </div>
            )}
            <div className="max-h-[70vh] overflow-auto p-2">
              {inboxFilter === "completed" ? (
                <div className="space-y-2">
                  {completed.length === 0 ? <div className="text-sm" style={{ color: darkMode ? '#8e8e93' : '#71717a' }}>Nothing in completed.</div> : completed.map((t) => (
                    <div key={t.id} className="flex items-center justify-between rounded-lg border px-2 py-1 text-sm" style={{ borderColor: darkMode ? '#48484a' : '#e4e4e7', color: darkMode ? '#e5e5e7' : '#18181b' }}>
                      <div className="truncate">{t.title}</div>
                      <button className="ml-2 rounded-lg border px-2 py-1 text-xs" style={{ background: darkMode ? '#3a3a3c' : 'white', borderColor: darkMode ? '#48484a' : '#e4e4e7', color: darkMode ? '#e5e5e7' : '#18181b' }} onClick={() => returnFromCompleted(t.id)}>Restore</button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="space-y-2">
                  {(() => {
                    const list = inboxFilter === "all" ? inbox : inbox.filter((x) => x.projectId === inboxFilter);
                    if (list.length === 0) return <div className="text-sm" style={{ color: darkMode ? '#8e8e93' : '#71717a' }}>Inbox is empty.</div>;
                    return list.map((t) => {
                      const proj = projects.find((p) => p.id === t.projectId);
                      const color = proj?.color ?? "#64748b";
                      return (
                        <div key={t.id} className="flex items-center gap-2 rounded-lg border px-2 py-1 min-w-0" style={{ borderColor: darkMode ? '#48484a' : '#e4e4e7' }}>
                          <div className="min-w-0 flex-1">
                            <Draggable id={`inbox:${t.projectId}:${t.id}`}>
                              <div className="cursor-grab active:cursor-grabbing rounded-md px-2 py-1 text-sm font-semibold text-white" style={{ background: color }} title="Drag to grid">
                                <div className="break-words whitespace-normal leading-snug">{t.title}</div>
                              </div>
                            </Draggable>
                          </div>
                          <div className="flex flex-shrink-0 gap-1">
                            <button className="h-8 w-8 rounded-lg border text-xs" style={{ background: darkMode ? '#3a3a3c' : 'white', borderColor: darkMode ? '#48484a' : '#e4e4e7', color: darkMode ? '#e5e5e7' : '#18181b' }} onClick={() => setDetailTarget({ kind: "inbox", inboxId: t.id })} title="Detail">⋯</button>
                            <button className="h-8 w-8 rounded-lg border text-xs" style={{ background: darkMode ? '#3a3a3c' : 'white', borderColor: darkMode ? '#48484a' : '#e4e4e7', color: darkMode ? '#e5e5e7' : '#18181b' }} onClick={() => markInboxDone(t.id)} title="Done">✓</button>
                            <button className="h-8 w-8 rounded-lg border text-xs" style={{ background: darkMode ? '#3a3a3c' : 'white', borderColor: darkMode ? '#48484a' : '#e4e4e7', color: darkMode ? '#e5e5e7' : '#18181b' }} onClick={() => removeInboxTask(t.id)} title="Delete">✕</button>
                          </div>
                        </div>
                      );
                    });
                  })()}
                </div>
              )}
            </div>
          </div>
        )}
        {/* Day agenda popover */}
        {dayFocus && (
          <div
            className="fixed inset-0 z-50 flex items-start justify-center bg-black/10 pt-24"
            onClick={() => setDayFocus(null)}
          >
            <div
              className="w-full max-w-sm rounded-2xl border border-zinc-200 bg-white p-4 shadow-xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between">
                <div className="text-sm font-semibold">{dayLabel(dayFocus).weekday} {dayLabel(dayFocus).md}</div>
                <button
                  className="h-8 w-8 rounded-full border border-zinc-200 bg-white hover:bg-zinc-50"
                  onClick={() => setDayFocus(null)}
                >
                  ✕
                </button>
              </div>

              {dayAgenda.length === 0 ? (
                <div className="mt-3 text-sm text-zinc-500">No tasks.</div>
              ) : (
                <div className="mt-3 space-y-3">
                  {dayAgenda.map(({ project, rows }) => (
                    <div key={project.id}>
                      <div className="mb-1 flex items-center gap-2">
                        <div className="h-2.5 w-2.5 rounded-full" style={{ background: project.color }} />
                        <div className="text-xs font-semibold text-zinc-700">{project.name}</div>
                      </div>
                      <div className="space-y-1">
                        {rows.map((row) => (
                          <div key={row.id} className="flex items-center gap-2 rounded-lg border border-zinc-100 px-2 py-1"
                            style={{ opacity: completedTasks[row.id] ? 0.55 : 1 }}
                          >
                            <input
                              type="checkbox"
                              checked={!!completedTasks[row.id]}
                              onChange={() => setCompletedTasks(prev => ({ ...prev, [row.id]: !prev[row.id] }))}
                              style={{ accentColor: project.color, cursor: "pointer", flexShrink: 0, width: 15, height: 15 }}
                            />
                            <div className="flex-1 text-sm" style={{ textDecoration: completedTasks[row.id] ? 'line-through' : 'none', color: completedTasks[row.id] ? '#a1a1aa' : undefined }}>{row.title}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

      </div>
      </DndContext>
    </div>

    {/* ===== DETAIL PANEL (notes + checklist sidebar) ===== */}
    {detailTarget && (
      <DetailPanel
        target={detailTarget}
        projects={projects}
        onClose={() => setDetailTarget(null)}
        onUpdateProjects={(updater) => setProjects(updater)}
        darkMode={darkMode}
        inbox={inbox}
        onUpdateInbox={(updater) => setInbox(updater)}
      />
    )}

    {/* ===== PRINT-ONLY VIEW — hidden on screen, shown when printing ===== */}
    <div data-print-view style={{ display: 'none' }}>
      <PrintView
        projects={projects}
        days={days}
        windowStart={windowStart}
        windowLen={windowLen}
        planRecurring={planRecurring}
        planRecurringInstances={planRecurringInstances}
      />
    </div>
    </>
  );
}
