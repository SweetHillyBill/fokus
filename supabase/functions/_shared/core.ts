// Gemensam kod för coach. Driftsätts som ./core.ts bredvid coach/index.ts.
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
  return new Response(JSON.stringify(data), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

export function admin(): SupabaseClient {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
}

export function localParts(tz: string, d = new Date()) {
  const f = new Intl.DateTimeFormat("sv-SE", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
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

const DAGAR = ["", "måndag", "tisdag", "onsdag", "torsdag", "fredag", "lördag", "söndag"];
export function dayName(date: string) {
  const wd = new Date(date + "T12:00:00Z").getUTCDay() || 7;
  return DAGAR[wd];
}

async function apiKey() {
  let key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) { const { data } = await admin().rpc("get_app_secret", { p_name: "anthropic_key" }); key = data as string; }
  if (!key) throw new Error("API nyckeln för Claude saknas.");
  return key;
}

export async function claude(model: string, system: string, messages: { role: string; content: string }[], maxTokens = 1500) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": await apiKey(), "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages }),
  });
  if (!r.ok) throw new Error(`Claude svarade ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j = await r.json();
  return (j.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
}

export async function claudeTool(model: string, system: string, messages: { role: string; content: string }[], tool: any, maxTokens = 4000) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": await apiKey(), "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages, tools: [tool], tool_choice: { type: "auto" } }),
  });
  if (!r.ok) throw new Error(`Claude svarade ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j = await r.json();
  const use = (j.content || []).find((c: any) => c.type === "tool_use");
  if (use) return use.input;
  const text = (j.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("").trim();
  return { reply: text || "Jag tappade tråden, försök igen.", actions: [] };
}

export function parseJson(text: string): any {
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = m ? m[1] : text;
  const s = raw.indexOf("{");
  const e = raw.lastIndexOf("}");
  if (s < 0 || e < 0) throw new Error("Inget JSON i svaret");
  return JSON.parse(raw.slice(s, e + 1));
}

export const COACH_SYSTEM = `Du är Fokus, Calles personliga coach för adhd. Du är expert på adhd hos vuxna och bygger på aktuell forskning: KBT för vuxna med adhd (Safren, Solanto, Ramsay), om/så planer (implementation intentions), externa hjälpmedel, tidshantering och känsloreglering. Calle vet oftast vad som ska göras; svårigheten är att göra det. Du är den yttre struktur hjärnan inte ger av sig själv.

OM CALLE: Driver Hytternäs gård i Mellösa (skog, dikor, gårdsbutik, burgerevent, konsultuppdrag) och har många parallella projekt. Medicineras för adhd. Svårast: komma igång, avsluta, prioritera och hålla fast vid en sak i stället för att starta nya.

TON: Coach och pepp. Varm, rak och kort. Aldrig skuld eller förebråelser: en miss är data, inte ett karaktärsfel. Fira avslutade saker, även små. Svara alltid på svenska. Använd aldrig bindestreck i dina svenska texter (skriv "om/så plan", "fem minuter", skriv ihop eller skriv om). Max en fråga i taget.

ARBETSSÄTT:
1. Komma igång: bryt ner till ett första steg under fem minuter som är fysiskt och konkret ("öppna Fortnox", inte "fixa bokföringen"). Föreslå en tidsruta (15 eller 25 minuter). Formulera om/så planer: "När X, då gör jag Y."
2. En sak i taget: nya idéer bekräftas och parkeras, sedan tillbaka till det pågående.
3. Avsluta: definiera "klart" innan start. Lyft när något är nästan klart. Föreslå att avsluta, pausa eller lägga ned medvetet i stället för att låta det glida.
4. Prioritera: högst tre saker per dag utifrån deadline, konsekvens om det inte görs, och energi. Säg vad som får vänta.
5. Synlig tid: lägg på 50 procent på Calles tidsuppskattningar. Lita på kalender och påminnelser, inte minnet.
6. Följ upp, justera och lär av mönster.

KONTOR OCH ADMINISTRATION (det absolut svåraste för Calle, ge det extra stöd):
- Föreslå fasta kontorspass på samma dagar och tid varje vecka. Korta pass: 25 minuter, högst två i rad med paus emellan. Fråga eller ta hänsyn till när Calle jobbar ute.
- Samla adminuppgifter i passen i stället för att sprida ut dem. Börja passet med det lättaste för att komma igång.
- Varje pass blir en uppgift på rätt dag med en konkret lista i stegen: vad som ska göras, i vilken ordning och när det är klart.
- Dela upp diffusa uppgifter i tid i stället för moment: "25 min: sortera kvitton i högen" i stället för "gör bokföringen". Det räcker att jobba tiden, inte att bli klar.
- Förbered startsträckan: steg ett är alltid fysiskt och litet ("sätt dig vid datorn och öppna Fortnox").
- Föreslå en liten belöning efter passet och fira att det blev gjort.
- Känd återkommande admin: underlag till redovisningsbyrån Ludvig and Company den 12:e varje månad (Gmail etiketten "Till Ludvig" och Fortnox).

GRÄNSER: Inga råd om medicin eller dosering; hänvisa till vården. Märker du att Calle mår dåligt på riktigt, prioritera det före produktivitet och föreslå att han pratar med någon han litar på eller vården (1177).`;

export async function buildContext(db: SupabaseClient, userId: string, today: string) {
  const [settings, tasks, ideas, insights] = await Promise.all([
    db.from("settings").select("*").eq("user_id", userId).maybeSingle(),
    db.from("tasks").select("id,title,status,due_date,scheduled_for,completed_at,steps").eq("user_id", userId).or(`status.in.(inkorg,planerad,pagar),completed_at.gte.${addDays(today, -7)}`).order("scheduled_for", { nullsFirst: false }).limit(80),
    db.from("ideas").select("text").eq("user_id", userId).eq("status", "parkerad").order("created_at", { ascending: false }).limit(15),
    db.from("insights").select("text").eq("user_id", userId).order("created_at", { ascending: false }).limit(15),
  ]);
  const s = settings.data || {};
  const week = Array.from({ length: 7 }, (_, i) => addDays(today, i)).map((d) => `${dayName(d)} ${d}`).join(", ");
  const txt = `IDAG: ${dayName(today)} ${today}. KOMMANDE DAGAR: ${week}.
BÄSTA FOKUSTID (medicin): ${s.focus_window || "okänd"}. OM CALLE: ${s.about_me || "-"}

UPPGIFTER (status, dag, antal steg):
${(tasks.data || []).map((t: any) => `- [${t.status}] ${t.title} (id ${t.id})${t.scheduled_for ? ", dag " + t.scheduled_for : ", ej planerad"}${t.due_date ? ", deadline " + t.due_date : ""}${(t.steps || []).length ? ", " + t.steps.length + " steg" : ""}${t.completed_at ? ", klar " + t.completed_at.slice(0, 10) : ""}`).join("\n") || "inga"}

PARKERADE IDÉER: ${(ideas.data || []).map((i: any) => i.text).join(" | ") || "inga"}
MÖNSTER: ${(insights.data || []).map((i: any) => i.text).join(" | ") || "inga än"}`;
  return { text: txt, settings: s };
}

let vapidReady = false;
export async function sendPush(db: SupabaseClient, userId: string, payload: { title: string; body: string; url?: string; tag?: string }) {
  if (!vapidReady) {
    const [{ data: pub }, { data: priv }] = await Promise.all([db.rpc("get_app_secret", { p_name: "vapid_public" }), db.rpc("get_app_secret", { p_name: "vapid_private" })]);
    webpush.setVapidDetails("mailto:" + ALLOWED_EMAIL, pub as string, priv as string);
    vapidReady = true;
  }
  const { data: subs } = await db.from("push_subscriptions").select("*").eq("user_id", userId);
  let sent = 0;
  for (const s of subs || []) {
    try { await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), { TTL: 3600, urgency: "high" }); sent++; }
    catch (e: any) { if (e?.statusCode === 404 || e?.statusCode === 410) await db.from("push_subscriptions").delete().eq("id", s.id); }
  }
  return sent;
}
