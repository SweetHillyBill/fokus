import { createClient } from "npm:@supabase/supabase-js@2";
import { ALLOWED_EMAIL, COACH_SYSTEM, MODEL_FAST, MODEL_SMART, admin, buildContext, claude, claudeTool, cors, json, localParts, parseJson, sendPush } from "./core.ts";

const SVARA = {
  name: "svara",
  description: "Svara Calle och utför åtgärder i appen.",
  input_schema: {
    type: "object",
    required: ["reply", "actions"],
    properties: {
      reply: { type: "string", description: "Kort svar till Calle på svenska, högst fem meningar, utan bindestreck och utan kod." },
      actions: {
        type: "array",
        items: {
          type: "object",
          required: ["type"],
          properties: {
            type: { type: "string", enum: ["add_task", "park_idea", "reminder", "complete_task", "set_today", "insight"] },
            title: { type: "string", description: "Titel för add_task eller rubrik för reminder" },
            scheduled_for: { type: "string", description: "Dag YYYY-MM-DD för add_task" },
            due_date: { type: "string", description: "Deadline YYYY-MM-DD" },
            steps: { type: "array", items: { type: "string" }, description: "Konkreta steg eller tidsblock för add_task" },
            text: { type: "string", description: "Text för park_idea eller insight" },
            in_min: { type: "number", description: "Minuter till påminnelsen" },
            body: { type: "string" },
            task_id: { type: "string" },
            task_ids: { type: "array", items: { type: "string" } },
          },
        },
      },
    },
  },
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const userClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: req.headers.get("Authorization") || "" } } });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ error: "Inte inloggad" }, 401);
    if ((user.email || "").toLowerCase() !== ALLOWED_EMAIL) return json({ error: "Den här appen är privat." }, 403);
    const db = admin();
    const uid = user.id;
    const body = await req.json().catch(() => ({}));
    const { date: today } = localParts("Europe/Stockholm");
    await db.from("settings").upsert({ user_id: uid }, { onConflict: "user_id", ignoreDuplicates: true });

    if (body.mode === "breakdown") {
      const { data: t } = await db.from("tasks").select("*").eq("id", body.task_id).eq("user_id", uid).single();
      if (!t) return json({ error: "Uppgiften finns inte" }, 404);
      const how = body.style === "tid"
        ? "Dela upp den i TIDSBLOCK i stället för moment. Varje steg börjar med tiden, till exempel \"15 min: ...\" eller \"25 min: ...\". Block på 10 till 25 minuter, högst sex block. Första blocket är kort (5 till 10 minuter) och börjar med något fysiskt och litet. Lägg in korta pauser som egna steg om det är fler än två block i rad. Målet för varje block är att jobba tiden, inte att bli klar."
        : "Bryt ner den i moment. Första steget ska ta under fem minuter och vara fysiskt konkret. Högst sju steg totalt.";
      const prompt = `Uppgift: "${t.title}"${t.done_definition ? `. Klart när: ${t.done_definition}` : ""}${body.extra ? `. Calle säger: ${body.extra}` : ""}.
För någon med adhd som har svårt att komma igång. ${how} Föreslå en tydlig definition av klart om den saknas.
Svara ENDAST med JSON: {"first_step":"...","steps":["..."],"estimate_min":30,"done_definition":"...","pep":"en kort peppande mening"}`;
      const out = parseJson(await claude(MODEL_FAST, COACH_SYSTEM, [{ role: "user", content: prompt }], 1200));
      await db.from("tasks").update({
        first_step: out.first_step,
        steps: [...(t.steps || []).filter((s: any) => s.done || s.ha_uid), ...(out.steps || []).map((s: string) => ({ text: s, done: false }))],
        estimate_min: out.estimate_min, done_definition: t.done_definition || out.done_definition,
      }).eq("id", t.id);
      return json(out);
    }

    if (body.mode === "chat") {
      const msg = String(body.message || "").slice(0, 4000);
      if (!msg) return json({ error: "Tomt meddelande" }, 400);
      const ctx = await buildContext(db, uid, today);
      const { data: hist } = await db.from("coach_messages").select("role,content").eq("user_id", uid).order("created_at", { ascending: false }).limit(16);
      const history = (hist || []).reverse().filter((m: any) => m.content && !m.content.startsWith('{"reply"'));
      while (history.length && history[0].role !== "user") history.shift();
      const sys = `${COACH_SYSTEM}

Svara ALLTID genom att anropa verktyget "svara", aldrig med vanlig text. Du har tillgång till Calles data nedan och kan AGERA genom åtgärder i verktyget. Gör det när det hjälper, utan att fråga om det är uppenbart (lägga till uppgift, parkera idé, sätta påminnelse, bocka av). När Calle ber dig planera in något, till exempel kontorspass, lägger du in uppgifterna på rätt dagar med add_task, scheduled_for och steps i stället för att bara föreslå. Skriv inte ut hela listan i svaret när du redan har lagt in den. set_today lägger valda uppgifter på idag.

${ctx.text}`;
      const out: any = await claudeTool(MODEL_SMART, sys, [...history, { role: "user", content: msg }], SVARA, 4000);
      const done = await runActions(db, uid, today, out.actions || []);
      await db.from("coach_messages").insert([{ user_id: uid, role: "user", content: msg }, { user_id: uid, role: "assistant", content: out.reply || "" }]);
      return json({ reply: out.reply, actions: done });
    }

    if (body.mode === "test_push") {
      const n = await sendPush(db, uid, { title: "Fokus", body: "Det fungerar! Så här ser dina notiser ut. 💪", url: "/", tag: "test" });
      return json({ sent: n });
    }
    return json({ error: "Okänt läge" }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: (e as Error).message }, 500);
  }
});

async function runActions(db: any, uid: string, today: string, actions: any[]) {
  const done: string[] = [];
  const isId = (x: any) => typeof x === "string" && /^[0-9a-f-]{36}$/.test(x);
  const isDay = (x: any) => typeof x === "string" && /^\d{4}-\d{2}-\d{2}$/.test(x);
  for (const a of actions.slice(0, 12)) {
    try {
      if (a.type === "add_task" && a.title) {
        const day = isDay(a.scheduled_for) ? a.scheduled_for : null;
        await db.from("tasks").insert({
          user_id: uid, title: a.title, first_step: a.first_step || "", scheduled_for: day,
          due_date: isDay(a.due_date) ? a.due_date : null, status: day ? "planerad" : "inkorg",
          steps: Array.isArray(a.steps) ? a.steps.map((x: any) => ({ text: String(x), done: false })) : [],
        });
        done.push(`Lade in: ${a.title}${day ? " (" + day + ")" : ""}`);
      } else if (a.type === "park_idea" && a.text) {
        await db.from("ideas").insert({ user_id: uid, text: a.text });
        done.push(`Parkerade: ${a.text}`);
      } else if (a.type === "reminder") {
        const due = new Date(Date.now() + (Number(a.in_min) || 15) * 60000);
        await db.from("reminders").insert({ user_id: uid, due_at: due.toISOString(), title: a.title || "Påminnelse", body: a.body || "" });
        done.push(`Påminnelse ${due.toLocaleTimeString("sv-SE", { timeZone: "Europe/Stockholm", hour: "2-digit", minute: "2-digit" })}: ${a.title || ""}`);
      } else if (a.type === "complete_task" && isId(a.task_id)) {
        await db.from("tasks").update({ status: "klar", completed_at: new Date().toISOString() }).eq("id", a.task_id).eq("user_id", uid);
        done.push("Bockade av en uppgift 🎉");
      } else if (a.type === "set_today") {
        for (const id of (a.task_ids || []).slice(0, 5)) if (isId(id)) await db.from("tasks").update({ scheduled_for: today, status: "planerad" }).eq("id", id).eq("user_id", uid);
        done.push("Lade uppgifter på idag");
      } else if (a.type === "insight" && a.text) {
        await db.from("insights").insert({ user_id: uid, text: a.text });
      }
    } catch (e) { console.error("åtgärd", a.type, e); }
  }
  return done;
}
