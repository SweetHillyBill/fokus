// Gemensam logik för coach och tick
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

export const ALLOWED_EMAIL = "calle.landsberg@gmail.com";
export const MODEL_SMART = "claude-sonnet-5-5";
export const MODEL_FAST = "claude-haiku-5-5";

export const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

export function admin(): SupabaseClient {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
}

// ---------- Tid ----------
export function localParts(tz: string, d = new Date()) {
  const f = new Intl.DateTimeFormat("sv-SE", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(d)) p[x.type] = x.value;
  const date = `${p.year}-${p.month}-${p.day}`;
  const hm = `${p.hour === "24" ? "00" : p.hour}:${p.minute}`;
  const wd = new Date(date + "T12:00:00Z").getUTCDay() || 7;
  return { date, hm, weekday: wd };
}

export function addDays(date: string, n: number) {
  const d = new Date(date + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function weekStart(date: string) {
  const d = new Date(date + "T12:00:00Z");
  const wd = d.getUTCDay() || 7;
  return addDays(date, 1 - wd);
}

const DAGAR = ["", "måndag", "tisdag", "onsdag", "torsdag", "fredag", "lördag", "söndag"];
export function dayName(date: string) {
  const wd = new Date(date + "T12:00:00Z").getUTCDay() || 7;
  return DAGAR[wd];
}

// ---------- Claude ----------
export async function claude(model: string, system: string, messages: { role: string; content: string }[], maxTokens = 1500) {
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) throw new Error("ANTHROPIC_API_KEY saknas i Supabase (Edge Function Secrets).");
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages }),
  });
  if (!r.ok) throw new Error(`Claude svarade ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j = await r.json();
  return (j.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
}

export function parseJson(text: string): any {
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = m ? m[1] : text;
  const s = raw.indexOf("{");
  const e = raw.lastIndexOf("}");
  if (s < 0 || e < 0) throw new Error("Inget JSON i svaret");
  return JSON.parse(raw.slice(s, e + 1));
}

// ---------- Grundinstruktion ----------
export const COACH_SYSTEM = `Du är Fokus, Calles personliga coach för adhd. Du är expert på adhd hos vuxna och bygger på aktuell forskning: KBT för vuxna med adhd (Safren, Solanto, Ramsay), om/så planer (implementation intentions), externa hjälpmedel, tidshantering och känsloreglering. Calle vet oftast vad som ska göras; svårigheten är att göra det. Du är den yttre struktur hjärnan inte ger av sig själv.

OM CALLE: Driver Hytternäs gård i Mellösa (skog, dikor, gårdsbutik, burgerevent, konsultuppdrag) och har många parallella projekt. Medicineras för adhd. Svårast: komma igång, avsluta, prioritera och hålla fast vid en sak i stället för att starta nya.

TON: Coach och pepp. Varm, rak och kort. Aldrig skuld eller förebråelser: en miss är data, inte ett karaktärsfel. Fira avslutade saker, även små. Svara alltid på svenska. Använd aldrig bindestreck i dina svenska texter (skriv "om/så plan", "fem minuter", skriv ihop eller skriv om). Max en fråga i taget.

ARBETSSÄTT:
1. Komma igång: bryt ner till ett första steg under fem minuter som är fysiskt och konkret ("öppna Fortnox", inte "fixa bokföringen"). Föreslå en tidsruta (15 eller 25 minuter). Formulera om/så planer: "När X, då gör jag Y."
2. En sak i taget: högst så många aktiva projekt som inställningen säger (standard tre). Nya idéer bekräftas och parkeras, sedan tillbaka till det pågående.
3. Avsluta: definiera "klart" innan start. Lyft när något är nästan klart. Föreslå att avsluta, pausa eller lägga ned medvetet i stället för att låta det glida.
4. Prioritera: högst tre saker per dag utifrån deadline, konsekvens om det inte görs, och energi. Säg vad som får vänta.
5. Synlig tid: lägg på 50 procent på Calles tidsuppskattningar. Lita på kalender och påminnelser, inte minnet.
6. Följ upp, justera och lär av mönster.

GRÄNSER: Inga råd om medicin eller dosering; hänvisa till vården. Märker du att Calle mår dåligt på riktigt, prioritera det före produktivitet och föreslå att han pratar med någon han litar på eller vården (1177).`;

// ---------- Kontext ----------
export async function buildContext(db: SupabaseClient, userId: string, today: string) {
  const [settings, projects, tasks, ideas, plan, refl, insights, routines] = await Promise.all([
    db.from("settings").select("*").eq("user_id", userId).maybeSingle(),
    db.from("projects").select("id,name,status,done_definition,next_step,deadline,progress").eq("user_id", userId).in("status", ["aktiv", "pausad", "parkerad"]).order("updated_at", { ascending: false }).limit(30),
    db.from("tasks").select("id,title,status,priority,energy,estimate_min,due_date,scheduled_for,is_top3,first_step,project_id,completed_at").eq("user_id", userId).or(`status.in.(inkorg,planerad,pagar),completed_at.gte.${addDays(today, -7)}`).order("priority").limit(80),
    db.from("ideas").select("text,created_at").eq("user_id", userId).eq("status", "parkerad").order("created_at", { ascending: false }).limit(15),
    db.from("day_plans").select("plan,message").eq("user_id", userId).eq("date", today).maybeSingle(),
    db.from("reflections").select("date,went_well,hard,energy,focus").eq("user_id", userId).order("date", { ascending: false }).limit(5),
    db.from("insights").select("text").eq("user_id", userId).order("created_at", { ascending: false }).limit(15),
    db.from("routines").select("title,next_due,freq").eq("user_id", userId).eq("active", true),
  ]);
  const s = settings.data || {};
  const cal = await calendarText(today, 7);
  const txt = `IDAG: ${dayName(today)} ${today}
INSTÄLLNINGAR: max aktiva projekt ${s.max_active_projects ?? 3}. Bästa fokustid (medicin): ${s.focus_window || "okänd, fråga gärna"}.
OM MIG (Calles egna ord): ${s.about_me || "-"}

PROJEKT (${(projects.data || []).length}):
${(projects.data || []).map((p: any) => `- [${p.status}] ${p.name} (id ${p.id}) klart när: ${p.done_definition || "ej definierat"}; nästa: ${p.next_step || "-"}; ${p.progress}%${p.deadline ? "; deadline " + p.deadline : ""}`).join("\n") || "inga"}

UPPGIFTER:
${(tasks.data || []).map((t: any) => `- [${t.status}${t.is_top3 ? ",topp3" : ""}] ${t.title} (id ${t.id}) prio ${t.priority}, energi ${t.energy}${t.estimate_min ? ", " + t.estimate_min + " min" : ""}${t.due_date ? ", deadline " + t.due_date : ""}${t.scheduled_for ? ", planerad " + t.scheduled_for : ""}${t.completed_at ? ", klar " + t.completed_at.slice(0, 10) : ""}`).join("\n") || "inga"}

PARKERADE IDÉER: ${(ideas.data || []).map((i: any) => i.text).join(" | ") || "inga"}
RUTINER: ${(routines.data || []).map((r: any) => `${r.title} (nästa ${r.next_due || "?"})`).join(", ") || "inga"}
DAGENS PLAN: ${plan.data ? JSON.stringify(plan.data.plan) : "ingen än"}
SENASTE KVÄLLSAVSTÄMNINGAR: ${(refl.data || []).map((r: any) => `${r.date}: bra "${r.went_well}", svårt "${r.hard}", energi ${r.energy}, fokus ${r.focus}`).join(" | ") || "inga"}
MÖNSTER SOM FUNGERAR/INTE FUNGERAR: ${(insights.data || []).map((i: any) => i.text).join(" | ") || "inga än"}
KALENDER (7 dagar): ${cal}`;
  return { text: txt, settings: s };
}

// ---------- Kalender via hemlig iCal adress (valfri) ----------
export async function calendarText(fromDate: string, days: number): Promise<string> {
  const url = Deno.env.get("GCAL_ICS_URL");
  if (!url) return "ej kopplad";
  try {
    const ICAL = (await import("npm:ical.js@2.1.0")).default;
    const r = await fetch(url);
    if (!r.ok) return "kunde inte hämtas";
    const comp = new ICAL.Component(ICAL.parse(await r.text()));
    const start = new Date(fromDate + "T00:00:00Z").getTime() - 2 * 3600e3;
    const end = start + days * 86400e3;
    const out: { t: number; s: string }[] = [];
    for (const ve of comp.getAllSubcomponents("vevent")) {
      const ev = new ICAL.Event(ve);
      if (ev.isRecurring()) {
        const it = ev.iterator();
        let next; let n = 0;
        while ((next = it.next()) && n < 500) {
          n++;
          const t = next.toJSDate().getTime();
          if (t > end) break;
          if (t >= start) out.push({ t, s: fmtEv(next.toJSDate(), ev.summary, next.isDate) });
        }
      } else {
        const t = ev.startDate.toJSDate().getTime();
        if (t >= start && t <= end) out.push({ t, s: fmtEv(ev.startDate.toJSDate(), ev.summary, ev.startDate.isDate) });
      }
    }
    out.sort((a, b) => a.t - b.t);
    return out.slice(0, 60).map((o) => o.s).join("; ") || "inga händelser";
  } catch (e) {
    return "fel vid läsning: " + (e as Error).message;
  }
}
function fmtEv(d: Date, summary: string, allDay: boolean) {
  const f = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm", weekday: "short", day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" });
  return allDay ? `${d.toISOString().slice(0, 10)} heldag: ${summary}` : `${f.format(d)}: ${summary}`;
}

// ---------- Push ----------
let vapidReady = false;
export async function sendPush(db: SupabaseClient, userId: string, payload: { title: string; body: string; url?: string; tag?: string; actions?: { action: string; title: string }[] }) {
  if (!vapidReady) {
    const [{ data: pub }, { data: priv }] = await Promise.all([
      db.rpc("get_app_secret", { p_name: "vapid_public" }),
      db.rpc("get_app_secret", { p_name: "vapid_private" }),
    ]);
    webpush.setVapidDetails("mailto:" + ALLOWED_EMAIL, pub as string, priv as string);
    vapidReady = true;
  }
  const { data: subs } = await db.from("push_subscriptions").select("*").eq("user_id", userId);
  let sent = 0;
  for (const s of subs || []) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify(payload),
        { TTL: 3600, urgency: "high" },
      );
      sent++;
    } catch (e: any) {
      if (e?.statusCode === 404 || e?.statusCode === 410) {
        await db.from("push_subscriptions").delete().eq("id", s.id);
      } else console.error("push fel", e?.statusCode, e?.body);
    }
  }
  return sent;
}

// ---------- Planering ----------
export async function makeDayPlan(db: SupabaseClient, userId: string, today: string) {
  const ctx = await buildContext(db, userId, today);
  const prompt = `${ctx.text}

UPPDRAG: Gör dagens plan för ${dayName(today)} ${today}. Välj högst tre viktigaste uppgifter (använd befintliga uppgifters id när de finns; du får föreslå en ny om något uppenbart saknas, då utan id). Ta hänsyn till kalendern, deadlines, veckans fokus och energi. Lägg de tyngsta i bästa fokustiden om den är känd. Ge varje uppgift ett första steg under fem minuter och en om/så plan. Lägg till 50 procent på tidsuppskattningar. Föreslå tidsrutor.
Svara ENDAST med JSON:
{"message":"kort peppande hälsning, max två meningar","top3":[{"task_id":"uuid eller null","title":"...","first_step":"...","if_then":"När ..., då ...","minutes":25}],"blocks":[{"time":"08:00","minutes":25,"title":"..."}],"can_wait":["..."],"notification":"en rad till pushnotisen, max 110 tecken"}`;
  const text = await claude(MODEL_SMART, COACH_SYSTEM, [{ role: "user", content: prompt }], 1800);
  const plan = parseJson(text);
  // markera topp3
  await db.from("tasks").update({ is_top3: false }).eq("user_id", userId).eq("is_top3", true).neq("status", "klar");
  for (const t of plan.top3 || []) {
    if (t.task_id && /^[0-9a-f-]{36}$/.test(t.task_id)) {
      await db.from("tasks").update({ is_top3: true, scheduled_for: today, first_step: t.first_step, status: "planerad" }).eq("id", t.task_id).eq("user_id", userId).neq("status", "klar");
    } else {
      const { data } = await db.from("tasks").insert({ user_id: userId, title: t.title, first_step: t.first_step, is_top3: true, scheduled_for: today, status: "planerad", estimate_min: t.minutes }).select("id").single();
      if (data) t.task_id = data.id;
    }
  }
  await db.from("day_plans").upsert({ user_id: userId, date: today, plan, message: plan.message || "" }, { onConflict: "user_id,date" });
  return plan;
}

export async function makeWeekPlan(db: SupabaseClient, userId: string, today: string) {
  const ws = addDays(weekStart(today), (new Date(today + "T12:00:00Z").getUTCDay() || 7) === 7 ? 7 : 0);
  const ctx = await buildContext(db, userId, today);
  const prompt = `${ctx.text}

UPPDRAG: Förbered veckoplanen för veckan som börjar ${ws}. Gå igenom kalendern, deadlines, projekt och uppgifter. Föreslå högst tre fokusområden för veckan. Kontrollera taket för aktiva projekt: föreslå vad som ska pausas eller parkeras om det är för många. Lyft projekt som är nästan klara. Fördela viktiga uppgifter på veckans dagar med hänsyn till kalendern. Ge en kort genomgång av förra veckan (vad blev klart) och fira det.
Svara ENDAST med JSON:
{"message":"peppande sammanfattning, max tre meningar","last_week":["klart..."],"focus":[{"title":"...","why":"...","done_when":"..."}],"days":[{"date":"YYYY-MM-DD","items":["..."]}],"pause_suggestions":["..."],"almost_done":["..."],"questions":["högst två frågor till Calle"],"notification":"en rad till pushnotisen, max 110 tecken"}`;
  const text = await claude(MODEL_SMART, COACH_SYSTEM, [{ role: "user", content: prompt }], 2500);
  const plan = parseJson(text);
  await db.from("week_plans").upsert({ user_id: userId, week_start: ws, plan, message: plan.message || "", approved: false }, { onConflict: "user_id,week_start" });
  return { ...plan, week_start: ws };
}
