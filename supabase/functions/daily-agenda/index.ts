// =====================================================
// daily-agenda – sends the morning agenda e-mail via Resend
//
// Called every hour by pg_cron (see supabase/daily-agenda-cron.sql);
// sends only when it is AGENDA_HOUR in AGENDA_TIMEZONE, so the e-mail
// keeps its local time across summer/winter time changes.
// POST ?force=1 sends right away (for testing).
//
// Secrets (supabase/functions/.env -> `supabase secrets set --env-file`):
//   RESEND_API_KEY, AGENDA_EMAIL_TO, CRON_SECRET,
//   AGENDA_TIMEZONE (default Europe/Prague), AGENDA_HOUR (default 6),
//   APP_URL (optional link in the footer), AGENDA_USER_ID (optional,
//   otherwise the planner account with the AGENDA_EMAIL_TO address)
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase.
// =====================================================

import { createClient } from "npm:@supabase/supabase-js@2";
import { buildDailyAgenda, renderAgendaEmail } from "../_shared/dailyAgenda.ts";
import type { AgendaSource } from "../_shared/dailyAgenda.ts";

function env(name: string, fallback?: string): string {
  const v = Deno.env.get(name) ?? fallback;
  if (!v) throw new Error(`Missing secret ${name}`);
  return v;
}

// Local date (YYYY-MM-DD) and hour in the given time zone
function localNow(timeZone: string): { day: string; hour: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date())
      .map((p) => [p.type, p.value])
  );
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  try {
    if (req.headers.get("x-cron-secret") !== env("CRON_SECRET")) return json({ error: "unauthorized" }, 401);

    const force = new URL(req.url).searchParams.get("force") === "1";
    const now = localNow(env("AGENDA_TIMEZONE", "Europe/Prague"));
    if (!force && now.hour !== Number(env("AGENDA_HOUR", "6"))) return json({ skipped: "not the sending hour", localHour: now.hour });

    const to = env("AGENDA_EMAIL_TO");
    const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

    let userId = Deno.env.get("AGENDA_USER_ID");
    if (!userId) {
      const { data, error } = await db.auth.admin.listUsers({ perPage: 1000 });
      if (error) throw error;
      userId = data.users.find((u) => u.email?.toLowerCase() === to.toLowerCase())?.id;
      if (!userId) return json({ error: `no planner account with e-mail ${to} (set AGENDA_USER_ID)` }, 404);
    }

    const { data: row, error } = await db.from("planner_states").select("state").eq("user_id", userId).maybeSingle();
    if (error) throw error;
    if (!row?.state) return json({ error: "no saved planner data for this account" }, 404);

    const agenda = buildDailyAgenda(row.state as AgendaSource, now.day);
    const mail = renderAgendaEmail(agenda, { appUrl: Deno.env.get("APP_URL") });

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${env("RESEND_API_KEY")}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: "PlantPlan <onboarding@resend.dev>", to: [to], subject: mail.subject, html: mail.html, text: mail.text }),
    });
    if (!res.ok) return json({ error: "resend failed", status: res.status, detail: await res.text() }, 502);

    return json({ sent: true, day: now.day, subject: mail.subject });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
