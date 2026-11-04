// =====================================================
// Daily agenda – "what is on this day" + e-mail rendering
// Pure TypeScript without imports: used by the app (preview) and by
// the daily-agenda Edge Function that sends the morning e-mail.
// =====================================================

export type DayKey = string; // YYYY-MM-DD

export type PlanRecurring = {
  id: string;
  projectId: string;
  title: string;
  recurrenceType: "weekly" | "everyN" | "biweekly" | "monthlyDate" | "monthlyLast";
  weekday: number; // 0=Sun .. 6=Sat (used by weekly, biweekly, monthlyLast)
  everyNDays?: number; // used by everyN
  startDate?: DayKey; // anchor date for everyN and biweekly
  monthDay?: number; // 1-31 for monthlyDate
  skippedDates?: DayKey[]; // specific dates where this recurring task is skipped
};

// ---------------------------------------------
// Date helpers (UTC-based DayKeys)
// ---------------------------------------------

export function parseDay(day: DayKey): Date {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function formatDay(date: Date): DayKey {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function addDays(day: DayKey, delta: number): DayKey {
  const dt = parseDay(day);
  dt.setUTCDate(dt.getUTCDate() + delta);
  return formatDay(dt);
}

export function diffDays(from: DayKey, to: DayKey): number {
  const a = parseDay(from).getTime();
  const b = parseDay(to).getTime();
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  return Math.round((b - a) / MS_PER_DAY);
}

// Does a PlanRecurring rule produce an instance on this day?
export function planRecurringMatches(r: PlanRecurring, day: DayKey): boolean {
  if ((r.skippedDates ?? []).includes(day)) return false;
  const dt = parseDay(day);
  const rType = r.recurrenceType || "weekly"; // backward compat
  if (rType === "weekly") {
    return dt.getUTCDay() === r.weekday;
  } else if (rType === "everyN" && r.everyNDays && r.everyNDays > 0 && r.startDate) {
    const diff = diffDays(r.startDate, day);
    return diff >= 0 && diff % r.everyNDays === 0;
  } else if (rType === "biweekly" && r.startDate) {
    // Every 2nd occurrence of this weekday, anchored from startDate
    if (dt.getUTCDay() !== r.weekday) return false;
    const diff = diffDays(r.startDate, day);
    const weeks = Math.floor(diff / 7);
    return diff >= 0 && weeks % 2 === 0;
  } else if (rType === "monthlyDate" && r.monthDay) {
    return dt.getUTCDate() === r.monthDay;
  } else if (rType === "monthlyLast") {
    // Last [weekday] of the month
    if (dt.getUTCDay() !== r.weekday) return false;
    const lastDay = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0));
    return lastDay.getUTCDate() - dt.getUTCDate() < 7; // within last 7 days = last occurrence
  }
  return false;
}

// ---------------------------------------------
// Time-range parser — extracts HH:MM-HH:MM from task title
// Returns null if no valid time range found
// ---------------------------------------------

const TIME_RANGE_RE = /\b(\d{1,2})[:\.·](\d{2})\s*[-–—]\s*(\d{1,2})[:\.·](\d{2})\b/;

export function parseTimeRange(title: string): { startMin: number; endMin: number } | null {
  // Match patterns like 10:00-12:00, 10:00–12:30, 10.00-12.00
  const m = title.match(TIME_RANGE_RE);
  if (!m) return null;
  const startMin = parseInt(m[1]) * 60 + parseInt(m[2]);
  const endMin   = parseInt(m[3]) * 60 + parseInt(m[4]);
  if (startMin >= endMin) return null;
  if (startMin < 0 || endMin > 24 * 60) return null;
  return { startMin, endMin };
}

// ---------------------------------------------
// Building the agenda for one day
// ---------------------------------------------

// Only the parts of the planner state the agenda needs
export type AgendaSource = {
  projects: Array<{
    id: string;
    name: string;
    color: string;
    lanes: Array<{
      items: Array<
        | { id: string; type: "task"; title: string; start: DayKey; end: DayKey }
        | { id: string; type: "experiment"; title: string; desc: string; start: DayKey; end: DayKey; subTasks: Record<DayKey, Array<{ id: string; title: string }>> }
      >;
    }>;
  }>;
  timedEvents?: Record<string, { day: DayKey; startMin: number; endMin: number; remind?: boolean }>;
  recurring?: Array<{ id: string; title: string; color: string; weekday: number; startMin: number; endMin: number }>;
  planRecurring?: PlanRecurring[];
  completedTasks?: Record<string, boolean>;
};

export type TimeRange = { startMin: number; endMin: number };

export type AgendaEntry = {
  id: string;
  title: string;
  kind: "task" | "subtask" | "recurring" | "event";
  time: TimeRange | null;
  done: boolean;
  experiment?: string; // sub-tasks: title of their experiment
};

export type AgendaExperiment = { id: string; title: string; dayIndex: number; totalDays: number };

export type AgendaSection = {
  projectId: string;
  name: string;
  color: string;
  experiments: AgendaExperiment[]; // experiments running on this day
  entries: AgendaEntry[];
};

export type DailyAgenda = {
  day: DayKey;
  schedule: Array<AgendaEntry & { time: TimeRange; color: string; projectName: string }>; // everything with a time, sorted
  sections: AgendaSection[];
  taskCount: number;
  doneCount: number;
};

// Title without its "10:00-12:00" part when that part is already shown as the time
function titleWithoutTime(title: string, time: TimeRange | null): string {
  if (!time) return title;
  const tr = parseTimeRange(title);
  if (!tr || tr.startMin !== time.startMin || tr.endMin !== time.endMin) return title;
  return title.replace(TIME_RANGE_RE, "").replace(/\s{2,}/g, " ").trim() || title;
}

function byTimeThenTitle(a: AgendaEntry, b: AgendaEntry): number {
  if (a.time && b.time) return a.time.startMin - b.time.startMin || a.time.endMin - b.time.endMin;
  if (a.time) return -1;
  if (b.time) return 1;
  return 0; // keep plan order for untimed entries
}

export function buildDailyAgenda(src: AgendaSource, day: DayKey): DailyAgenda {
  const timedEvents = src.timedEvents ?? {};
  const completed = src.completedTasks ?? {};

  // Time of a task on this day, if it was placed in the calendar
  const timeOf = (id: string): TimeRange | null => {
    const ev = timedEvents[id];
    if (!ev || ev.day !== day || (!ev.startMin && !ev.endMin)) return null;
    return { startMin: ev.startMin, endMin: ev.endMin };
  };

  const entry = (id: string, title: string, kind: AgendaEntry["kind"], time: TimeRange | null, extra?: Partial<AgendaEntry>): AgendaEntry => ({
    id,
    title: titleWithoutTime(title, time),
    kind,
    time,
    done: !!completed[id],
    ...extra,
  });

  const sections: AgendaSection[] = [];
  for (const p of src.projects) {
    const experiments: AgendaExperiment[] = [];
    const entries: AgendaEntry[] = [];
    for (const lane of p.lanes) {
      for (const it of lane.items) {
        if (it.type === "task") {
          if (it.start === day) {
            const id = `t:${p.id}:${it.id}`;
            entries.push(entry(id, it.title, "task", timeOf(id)));
          }
        } else {
          const expName = it.desc || it.title || "Experiment"; // the planner labels experiments by their description
          if (it.start <= day && day <= it.end) {
            experiments.push({ id: it.id, title: expName, dayIndex: diffDays(it.start, day) + 1, totalDays: diffDays(it.start, it.end) + 1 });
          }
          for (const st of it.subTasks?.[day] ?? []) {
            const id = `st:${p.id}:${it.id}:${st.id}`;
            entries.push(entry(id, st.title, "subtask", timeOf(id), { experiment: expName }));
          }
        }
      }
    }
    for (const r of src.planRecurring ?? []) {
      if (r.projectId !== p.id || !planRecurringMatches(r, day)) continue;
      const id = `pr:${r.id}:${day}`;
      entries.push(entry(id, r.title, "recurring", timeOf(id) ?? parseTimeRange(r.title)));
    }
    entries.sort(byTimeThenTitle);
    if (experiments.length || entries.length) sections.push({ projectId: p.id, name: p.name, color: p.color, experiments, entries });
  }

  const schedule: DailyAgenda["schedule"] = [];
  for (const s of sections) {
    for (const e of s.entries) {
      if (e.time) schedule.push({ ...e, time: e.time, color: s.color, projectName: s.name });
    }
  }
  // Calendar-only weekly events (not tied to a project)
  const weekday = parseDay(day).getUTCDay();
  for (const r of src.recurring ?? []) {
    if (r.weekday !== weekday) continue;
    const time = { startMin: r.startMin, endMin: r.endMin };
    schedule.push({ ...entry(`calrec:${r.id}`, r.title, "event", time), time, color: r.color, projectName: "" });
  }
  schedule.sort(byTimeThenTitle);

  const all = sections.flatMap((s) => s.entries);
  return { day, schedule, sections, taskCount: all.length, doneCount: all.filter((e) => e.done).length };
}

// ---------------------------------------------
// E-mail rendering (inline styles only – e-mail clients ignore <style>)
// ---------------------------------------------

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function hhmm(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

function timeLabel(t: TimeRange): string {
  return `${hhmm(t.startMin)}–${hhmm(t.endMin)}`;
}

function longDate(day: DayKey, locale: string): string {
  return parseDay(day).toLocaleDateString(locale, { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function renderAgendaEmail(a: DailyAgenda, opts: { locale?: string; appUrl?: string } = {}): { subject: string; html: string; text: string } {
  const locale = opts.locale ?? "en-GB";
  const date = longDate(a.day, locale);
  const shortDate = parseDay(a.day).toLocaleDateString(locale, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  const eventCount = a.schedule.filter((e) => e.kind === "event").length;
  const counts = [a.taskCount ? plural(a.taskCount, "task") : "", eventCount ? plural(eventCount, "event") : ""].filter(Boolean).join(", ");
  const running = a.sections.reduce((n, s) => n + s.experiments.length, 0);
  const subject = `PlantPlan · ${shortDate} · ${counts || (running ? `${plural(running, "experiment")} running` : "nothing planned")}`;

  const MUTED = "#71717a";
  const dot = (color: string) => `<span style="display:inline-block;width:8px;height:8px;border-radius:4px;background:${esc(color)};margin-right:6px;vertical-align:middle"></span>`;
  const check = (done: boolean) => `<span style="display:inline-block;width:16px;color:${done ? "#16a34a" : "#a1a1aa"}">${done ? "&#10003;" : "&#9675;"}</span>`;
  const struck = (e: AgendaEntry, html: string) => (e.done ? `<span style="text-decoration:line-through;color:#a1a1aa">${html}</span>` : html);

  const parts: string[] = [];
  const text: string[] = [date, ""];

  parts.push(
    `<h1 style="margin:0 0 4px;font-size:22px;font-weight:700;color:#18181b">${esc(date.charAt(0).toUpperCase() + date.slice(1))}</h1>`,
    `<p style="margin:0 0 20px;font-size:14px;color:${MUTED}">${counts ? `${counts}${a.doneCount ? ` · ${a.doneCount} done` : ""}` : "Nothing planned for today."}</p>`
  );

  if (a.schedule.length) {
    text.push("SCHEDULE");
    const rows = a.schedule
      .map((e) => {
        text.push(`  ${timeLabel(e.time)}  ${e.title}${e.projectName ? ` (${e.projectName})` : ""}`);
        return `<tr>
          <td style="padding:6px 12px 6px 0;font-size:14px;font-weight:600;color:#18181b;white-space:nowrap;vertical-align:top">${timeLabel(e.time)}</td>
          <td style="padding:6px 0;font-size:14px;color:#18181b;vertical-align:top">${dot(e.color)}${struck(e, esc(e.title))}${e.projectName ? ` <span style="color:${MUTED}">· ${esc(e.projectName)}</span>` : ""}</td>
        </tr>`;
      })
      .join("");
    parts.push(
      `<div style="margin:0 0 24px;padding:12px 16px;background:#eff6ff;border-radius:12px">
        <div style="margin:0 0 4px;font-size:12px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:#2563eb">Schedule</div>
        <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse">${rows}</table>
      </div>`
    );
    text.push("");
  }

  for (const s of a.sections) {
    text.push(s.name.toUpperCase());
    const lines: string[] = [];
    for (const x of s.experiments) {
      const where = x.dayIndex === 1 ? "starts today" : x.dayIndex === x.totalDays ? "last day" : `day ${x.dayIndex} of ${x.totalDays}`;
      text.push(`  Experiment: ${x.title} – ${where}`);
      lines.push(
        `<div style="margin:0 0 8px;padding:8px 12px;border:1px solid #e4e4e7;border-left:4px solid ${esc(s.color)};border-radius:8px;font-size:14px;color:#18181b">
          <strong>${esc(x.title)}</strong> <span style="color:${MUTED}">· ${where}</span>
        </div>`
      );
    }
    for (const e of s.entries) {
      const time = e.time ? `${timeLabel(e.time)} ` : "";
      const rec = e.kind === "recurring" ? "↻ " : "";
      text.push(`  ${e.done ? "[x]" : "[ ]"} ${time}${rec}${e.title}${e.experiment ? ` (${e.experiment})` : ""}`);
      lines.push(
        `<div style="padding:4px 0;font-size:14px;color:#18181b">${check(e.done)}${struck(e, `${time ? `<span style="font-weight:600">${time}</span>` : ""}${rec}${esc(e.title)}`)}${e.experiment ? ` <span style="color:${MUTED}">· ${esc(e.experiment)}</span>` : ""}</div>`
      );
    }
    parts.push(
      `<div style="margin:0 0 20px">
        <div style="margin:0 0 8px;font-size:15px;font-weight:700;color:#18181b">${dot(s.color)}${esc(s.name)}</div>
        ${lines.join("")}
      </div>`
    );
    text.push("");
  }

  const footer = opts.appUrl ? `<a href="${esc(opts.appUrl)}" style="color:#2563eb;text-decoration:none">Open PlantPlan</a>` : "PlantPlan";
  parts.push(`<p style="margin:24px 0 0;padding-top:12px;border-top:1px solid #e4e4e7;font-size:12px;color:#a1a1aa">${footer} · daily agenda</p>`);
  if (opts.appUrl) text.push(opts.appUrl);

  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#f4f4f5">
  <div style="max-width:560px;margin:0 auto;padding:24px 16px;font-family:${FONT}">
    <div style="padding:24px;background:#ffffff;border-radius:16px">${parts.join("\n")}</div>
  </div>
</body></html>`;

  return { subject, html, text: text.join("\n") };
}

// ---------------------------------------------
// Reminders: e-mail shortly before a scheduled task
// ---------------------------------------------

export const REMINDER_LEAD_MIN = 10;

// Scheduled tasks with a reminder whose e-mail time (start − 10 min) falls in [fromMin, toMin)
export function dueReminders(src: AgendaSource, day: DayKey, fromMin: number, toMin: number): DailyAgenda["schedule"] {
  const timed = src.timedEvents ?? {};
  return buildDailyAgenda(src, day).schedule.filter((e) => {
    if (!timed[e.id]?.remind || e.done) return false;
    const at = e.time.startMin - REMINDER_LEAD_MIN;
    return at >= fromMin && at < toMin;
  });
}

export function renderReminderEmail(entries: DailyAgenda["schedule"], opts: { appUrl?: string } = {}): { subject: string; html: string; text: string } {
  const first = entries[0];
  const more = entries.length > 1 ? ` +${entries.length - 1}` : "";
  const subject = `⏰ ${hhmm(first.time.startMin)} ${first.title}${more}`;
  const rows = entries
    .map((e) => `<div style="margin:0 0 10px;padding:10px 14px;border:1px solid #e4e4e7;border-left:4px solid ${esc(e.color)};border-radius:8px">
        <div style="font-size:13px;font-weight:600;color:#2563eb">${timeLabel(e.time)}</div>
        <div style="font-size:16px;font-weight:600;color:#18181b">${esc(e.title)}</div>
        ${e.projectName ? `<div style="font-size:13px;color:#71717a">${esc(e.projectName)}</div>` : ""}
      </div>`)
    .join("");
  const footer = opts.appUrl ? `<a href="${esc(opts.appUrl)}" style="color:#2563eb;text-decoration:none">Open PlantPlan</a>` : "PlantPlan";
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#f4f4f5">
  <div style="max-width:480px;margin:0 auto;padding:24px 16px;font-family:${FONT}">
    <div style="padding:20px;background:#ffffff;border-radius:16px">
      <p style="margin:0 0 12px;font-size:14px;color:#71717a">Starting in ${REMINDER_LEAD_MIN} minutes</p>
      ${rows}
      <p style="margin:16px 0 0;font-size:12px;color:#a1a1aa">${footer} · reminder</p>
    </div>
  </div>
</body></html>`;
  const text = [`Starting in ${REMINDER_LEAD_MIN} minutes`, "", ...entries.map((e) => `${timeLabel(e.time)}  ${e.title}${e.projectName ? ` (${e.projectName})` : ""}`)].join("\n");
  return { subject, html, text };
}
