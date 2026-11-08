// Körs varje minut av pg_cron. Enkel version: dagens lista 06:45 vardagar, veckoplanering söndag 10:00.
import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const json = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "Content-Type": "application/json" } });

function local(tz: string) {
  const f = new Intl.DateTimeFormat("sv-SE", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(new Date())) p[x.type] = x.value;
  const date = `${p.year}-${p.month}-${p.day}`;
  const mins = (p.hour === "24" ? 0 : +p.hour) * 60 + +p.minute;
  return { date, mins, weekday: new Date(date + "T12:00:00Z").getUTCDay() || 7 };
}
const toMin = (t: string) => { const [h, m] = String(t).slice(0, 5).split(":").map(Number); return h * 60 + m; };

Deno.serve(async (req) => {
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const { data: secret } = await db.rpc("get_app_secret", { p_name: "cron_secret" });
  if (!secret || req.headers.get("x-cron-secret") !== secret) return json({ error: "nej" }, 401);

  let ready = false;
  const push = async (uid: string, payload: Record<string, unknown>) => {
    if (!ready) {
      const [{ data: pub }, { data: priv }] = await Promise.all([db.rpc("get_app_secret", { p_name: "vapid_public" }), db.rpc("get_app_secret", { p_name: "vapid_private" })]);
      webpush.setVapidDetails("mailto:calle.landsberg@gmail.com", pub as string, priv as string);
      ready = true;
    }
    const { data: subs } = await db.from("push_subscriptions").select("*").eq("user_id", uid);
    for (const s of subs || []) {
      try { await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), { TTL: 3600, urgency: "high" }); }
      catch (e: any) { if (e?.statusCode === 404 || e?.statusCode === 410) await db.from("push_subscriptions").delete().eq("id", s.id); }
    }
  };
  const log: string[] = [];

  // Påminnelser
  const { data: due } = await db.from("reminders").select("*").is("sent_at", null).lte("due_at", new Date().toISOString()).limit(50);
  for (const r of due || []) {
    await db.from("reminders").update({ sent_at: new Date().toISOString() }).eq("id", r.id);
    await push(r.user_id, { title: r.title, body: r.body || "", url: r.url || "/#idag", tag: r.id });
  }

  const { data: users } = await db.from("settings").select("*");
  for (const s of users || []) {
    try {
      const { date, mins, weekday } = local(s.timezone || "Europe/Stockholm");
      const once = async (job: string) => !(await db.from("job_log").insert({ user_id: s.user_id, job, key: date })).error;
      const inWindow = (t: string, w: number) => mins - toMin(t) >= 0 && mins - toMin(t) <= w;

      if ((weekday <= 5 || s.day_plan_weekends) && inWindow(s.day_plan_time || "06:45", 60) && await once("dagslista")) {
        const { data: ts } = await db.from("tasks").select("title").eq("user_id", s.user_id).lte("scheduled_for", date).in("status", ["planerad", "pagar", "inkorg"]).order("created_at").limit(10);
        const n = ts?.length || 0;
        await push(s.user_id, {
          title: n ? `☀️ Idag: ${n} att göra` : "☀️ God morgon",
          body: n ? (ts || []).slice(0, 4).map((t) => "• " + t.title).join("\n") + (n > 4 ? `\n…och ${n - 4} till` : "") : "Inget planerat idag. Välj en eller två saker från listan.",
          url: "/#idag", tag: "dagslista",
        });
        log.push("dagslista");
      }

      if (weekday === 7 && inWindow(s.week_plan_time || "10:00", 60) && await once("veckoplan")) {
        await push(s.user_id, { title: "🗓️ Planera veckan", body: "Tio minuter: lägg ut veckans saker på dagarna.", url: "/#vecka", tag: "veckoplan" });
        log.push("veckoplan");
      }
    } catch (e) { log.push("fel: " + (e as Error).message); }
  }
  return json({ ok: true, log });
});
