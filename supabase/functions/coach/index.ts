import { createClient } from "npm:@supabase/supabase-js@2";
import {
  ALLOWED_EMAIL, COACH_SYSTEM, MODEL_FAST, MODEL_SMART, addDays, admin, buildContext,
  claude, cors, json, localParts, makeDayPlan, makeWeekPlan, parseJson, sendPush,
} from "../_shared/core.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const authHeader = req.headers.get("Authorization") || "";
    const userClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ error: "Inte inloggad" }, 401);
    if ((user.email || "").toLowerCase() !== ALLOWED_EMAIL) return json({ error: "Den här appen är privat." }, 403);

    const db = admin();
    const uid = user.id;
    const body = await req.json().catch(() => ({}));
    const mode = body.mode as string;
    const { date: today } = localParts("Europe/Stockholm");

    // Se till att inställningar finns
    await db.from("settings").upsert({ user_id: uid }, { onConflict: "user_id", ignoreDuplicates: true });

    if (mode === "breakdown") {
      const { data: t } = await db.from("tasks").select("*").eq("id", body.task_id).eq("user_id", uid).single();
      if (!t) return json({ error: "Uppgiften finns inte" }, 404);
      const prompt = `Uppgift: "${t.title}"${t.done_definition ? `. Klart när: ${t.done_definition}` : ""}${body.extra ? `. Calle säger: ${body.extra}` : ""}.
Bryt ner den för någon med adhd som har svårt att komma igång. Första steget ska ta under fem minuter och vara fysiskt konkret. Högst sju steg totalt. Uppskatta realistisk tid och lägg på 50 procent. Föreslå en tydlig definition av klart om den saknas, och en om/så plan.
Svara ENDAST med JSON: {"first_step":"...","steps":["..."],"estimate_min":30,"done_definition":"...","if_then":"När ..., då ...","pep":"en kort peppande mening"}`;
      const out = parseJson(await claude(MODEL_FAST, COACH_SYSTEM, [{ role: "user", content: prompt }], 800));
      await db.from("tasks").update({
        first_step: out.first_step, steps: (out.steps || []).map((s: string) => ({ text: s, done: false })),
        estimate_min: out.estimate_min, done_definition: t.done_definition || out.done_definition,
      }).eq("id", t.id);
      return json(out);
    }

    if (mode === "chat") {
      const msg = String(body.message || "").slice(0, 4000);
      if (!msg) return json({ error: "Tomt meddelande" }, 400);
      const ctx = await buildContext(db, uid, today);
      const { data: hist } = await db.from("coach_messages").select("role,content").eq("user_id", uid).order("created_at", { ascending: false }).limit(16);
      const history = (hist || []).reverse();
      const sys = `${COACH_SYSTEM}

Du har tillgång till Calles data nedan och kan AGERA genom att returnera åtgärder. Gör det när det hjälper, utan att fråga om det är uppenbart (lägga till uppgift, parkera idé, sätta påminnelse, bocka av). Fråga först vid större ändringar (lägga ned projekt). När Calle vill starta något nytt: parkera det och påminn om det pågående, om inte taket för aktiva projekt tillåter.

${ctx.text}

Svara ENDAST med JSON:
{"reply":"ditt svar till Calle, kort och peppande","actions":[
 {"type":"add_task","title":"...","project_id":null,"scheduled_for":null,"due_date":null,"first_step":"...","priority":2},
 {"type":"park_idea","text":"..."},
 {"type":"reminder","in_min":15,"title":"...","body":"..."},
 {"type":"complete_task","task_id":"..."},
 {"type":"start_task","task_id":"..."},
 {"type":"set_top3","task_ids":["..."]},
 {"type":"add_project","name":"...","done_definition":"...","next_step":"..."},
 {"type":"update_project","project_id":"...","status":"aktiv|pausad|parkerad|klar|nedlagd","next_step":"...","progress":50},
 {"type":"insight","text":"mönster som verkar fungera eller inte fungera för Calle"}
]}
Ta bara med de åtgärder som behövs; tom lista är vanligt.`;
      const text = await claude(MODEL_SMART, sys, [...history, { role: "user", content: msg }], 1500);
      let out: any;
      try { out = parseJson(text); } catch { out = { reply: text, actions: [] }; }
      const done = await runActions(db, uid, today, out.actions || [], ctx.settings);
      await db.from("coach_messages").insert([
        { user_id: uid, role: "user", content: msg },
        { user_id: uid, role: "assistant", content: out.reply || "" },
      ]);
      return json({ reply: out.reply, actions: done });
    }

    if (mode === "plan_day") {
      const plan = await makeDayPlan(db, uid, body.date || today);
      return json(plan);
    }

    if (mode === "plan_week") {
      const plan = await makeWeekPlan(db, uid, today);
      return json(plan);
    }

    if (mode === "approve_week") {
      const { data: wp } = await db.from("week_plans").select("*").eq("id", body.id).eq("user_id", uid).single();
      if (!wp) return json({ error: "Hittar inte veckoplanen" }, 404);
      const change = String(body.change || "").trim();
      let plan = wp.plan;
      if (change) {
        const ctx = await buildContext(db, uid, today);
        const prompt = `${ctx.text}\n\nNUVARANDE VECKOPLAN: ${JSON.stringify(plan)}\nCalle vill ändra: ${change}\nUppdatera planen och svara ENDAST med JSON i samma format.`;
        plan = parseJson(await claude(MODEL_SMART, COACH_SYSTEM, [{ role: "user", content: prompt }], 2500));
      }
      await db.from("week_plans").update({ plan, message: plan.message || wp.message, approved: !change || !!body.approve }).eq("id", wp.id);
      return json({ plan, approved: !change || !!body.approve });
    }

    if (mode === "reflect") {
      const r = {
        user_id: uid, date: today, went_well: String(body.went_well || ""), hard: String(body.hard || ""),
        energy: body.energy || null, focus: body.focus || null,
      };
      const ctx = await buildContext(db, uid, today);
      const prompt = `${ctx.text}

KVÄLLSAVSTÄMNING idag: bra: "${r.went_well}". Svårt: "${r.hard}". Energi ${r.energy}/5, fokus ${r.focus}/5.
Ge en kort varm återkoppling: fira det som blev gjort (titta på uppgifter klara idag), normalisera det som var svårt utan skuld, och föreslå vad som flyttas till imorgon. Om du ser ett mönster (tid, energi, knep), formulera det som insikt.
Svara ENDAST med JSON: {"reply":"max fyra meningar","move_to_tomorrow":["task id"],"insight":"eller null"}`;
      const out = parseJson(await claude(MODEL_SMART, COACH_SYSTEM, [{ role: "user", content: prompt }], 900));
      await db.from("reflections").upsert({ ...r, coach_reply: out.reply }, { onConflict: "user_id,date" });
      for (const id of out.move_to_tomorrow || []) {
        if (/^[0-9a-f-]{36}$/.test(id)) await db.from("tasks").update({ scheduled_for: addDays(today, 1), is_top3: false }).eq("id", id).eq("user_id", uid).neq("status", "klar");
      }
      if (out.insight) await db.from("insights").insert({ user_id: uid, text: out.insight });
      return json(out);
    }

    if (mode === "test_push") {
      const n = await sendPush(db, uid, { title: "Fokus", body: "Det fungerar! Så här ser dina notiser ut. 💪", url: "/", tag: "test" });
      return json({ sent: n });
    }

    return json({ error: "Okänt läge" }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: (e as Error).message }, 500);
  }
});

async function runActions(db: any, uid: string, today: string, actions: any[], settings: any) {
  const done: string[] = [];
  const isId = (x: any) => typeof x === "string" && /^[0-9a-f-]{36}$/.test(x);
  for (const a of actions.slice(0, 10)) {
    try {
      switch (a.type) {
        case "add_task":
          await db.from("tasks").insert({
            user_id: uid, title: a.title, first_step: a.first_step || "", priority: a.priority || 2,
            project_id: isId(a.project_id) ? a.project_id : null,
            scheduled_for: a.scheduled_for || null, due_date: a.due_date || null,
            status: a.scheduled_for ? "planerad" : "inkorg",
          });
          done.push(`Lade till uppgift: ${a.title}`);
          break;
        case "park_idea":
          await db.from("ideas").insert({ user_id: uid, text: a.text });
          done.push(`Parkerade idé: ${a.text}`);
          break;
        case "reminder": {
          const due = a.at ? new Date(a.at) : new Date(Date.now() + (Number(a.in_min) || 15) * 60000);
          await db.from("reminders").insert({ user_id: uid, due_at: due.toISOString(), title: a.title || "Påminnelse", body: a.body || "" });
          done.push(`Påminnelse ${due.toLocaleTimeString("sv-SE", { timeZone: "Europe/Stockholm", hour: "2-digit", minute: "2-digit" })}: ${a.title}`);
          break;
        }
        case "complete_task":
          if (isId(a.task_id)) {
            await db.from("tasks").update({ status: "klar", completed_at: new Date().toISOString() }).eq("id", a.task_id).eq("user_id", uid);
            done.push("Bockade av en uppgift 🎉");
          }
          break;
        case "start_task":
          if (isId(a.task_id)) {
            await db.from("tasks").update({ status: "pagar" }).eq("id", a.task_id).eq("user_id", uid);
            done.push("Satte uppgiften som pågående");
          }
          break;
        case "set_top3":
          await db.from("tasks").update({ is_top3: false }).eq("user_id", uid).eq("is_top3", true);
          for (const id of (a.task_ids || []).slice(0, 3)) if (isId(id)) await db.from("tasks").update({ is_top3: true, scheduled_for: today }).eq("id", id).eq("user_id", uid);
          done.push("Uppdaterade dagens tre");
          break;
        case "add_project": {
          const { count } = await db.from("projects").select("id", { count: "exact", head: true }).eq("user_id", uid).eq("status", "aktiv");
          const max = settings?.max_active_projects ?? 3;
          const status = (count ?? 0) < max ? "aktiv" : "parkerad";
          await db.from("projects").insert({ user_id: uid, name: a.name, done_definition: a.done_definition || "", next_step: a.next_step || "", status });
          done.push(status === "aktiv" ? `Nytt projekt: ${a.name}` : `Projektet ${a.name} parkerades, taket på ${max} aktiva är nått`);
          break;
        }
        case "update_project":
          if (isId(a.project_id)) {
            const upd: any = { updated_at: new Date().toISOString() };
            for (const k of ["status", "next_step", "progress", "done_definition"]) if (a[k] !== undefined) upd[k] = a[k];
            if (upd.status === "klar" || upd.status === "nedlagd") upd.closed_at = new Date().toISOString();
            await db.from("projects").update(upd).eq("id", a.project_id).eq("user_id", uid);
            done.push("Uppdaterade ett projekt");
          }
          break;
        case "insight":
          await db.from("insights").insert({ user_id: uid, text: a.text });
          break;
      }
    } catch (e) { console.error("åtgärd", a.type, e); }
  }
  return done;
}
