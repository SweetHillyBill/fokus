// Körs varje minut av pg_cron. Skyddas med hemlig header.
import { addDays, admin, json, localParts, makeDayPlan, makeWeekPlan, sendPush } from "../_shared/core.ts";

Deno.serve(async (req) => {
  const db = admin();
  const { data: secret } = await db.rpc("get_app_secret", { p_name: "cron_secret" });
  if (!secret || req.headers.get("x-cron-secret") !== secret) return json({ error: "nej" }, 401);
  const log: string[] = [];

  // 1. Påminnelser som förfallit
  const { data: due } = await db.from("reminders").select("*").is("sent_at", null).lte("due_at", new Date().toISOString()).limit(50);
  for (const r of due || []) {
    await db.from("reminders").update({ sent_at: new Date().toISOString() }).eq("id", r.id);
    await sendPush(db, r.user_id, { title: r.title, body: r.body || "", url: r.url || "/", tag: r.tag || r.id });
    log.push("påminnelse " + r.id);
  }

  // 2. Schemalagda jobb per användare
  const { data: users } = await db.from("settings").select("*");
  for (const s of users || []) {
    const { date, hm, weekday } = localParts(s.timezone || "Europe/Stockholm");
    const once = async (job: string, key: string) => {
      const { error } = await db.from("job_log").insert({ user_id: s.user_id, job, key });
      return !error; // false om redan gjort
    };
    const at = (t: string) => hm >= String(t).slice(0, 5);
    const within = (t: string, mins: number) => {
      const [h, m] = String(t).slice(0, 5).split(":").map(Number);
      const [ch, cm] = hm.split(":").map(Number);
      const diff = ch * 60 + cm - (h * 60 + m);
      return diff >= 0 && diff <= mins;
    };

    try {
      // Dagsplan vardagar (och helg om valt)
      const dayOk = weekday <= 5 || s.day_plan_weekends;
      if (dayOk && within(s.day_plan_time, 90) && await once("dagsplan", date)) {
        let plan: any;
        try { plan = await makeDayPlan(db, s.user_id, date); }
        catch (e) { await db.from("job_log").delete().eq("user_id", s.user_id).eq("job", "dagsplan").eq("key", date); throw e; }
        await sendPush(db, s.user_id, {
          title: "☀️ Dagens plan",
          body: plan.notification || (plan.top3 || []).map((t: any) => t.title).join(" · "),
          url: "/#idag", tag: "dagsplan",
          actions: [{ action: "start", title: "Starta första" }, { action: "open", title: "Visa" }],
        });
        log.push("dagsplan");
      }

      // Veckoplan söndag
      if (weekday === 7 && within(s.week_plan_time, 120) && await once("veckoplan", date)) {
        let plan: any;
        try { plan = await makeWeekPlan(db, s.user_id, date); }
        catch (e) { await db.from("job_log").delete().eq("user_id", s.user_id).eq("job", "veckoplan").eq("key", date); throw e; }
        await sendPush(db, s.user_id, {
          title: "🗓️ Dags att planera veckan",
          body: plan.notification || "Utkastet är klart. Fem minuter så är veckan på plats.",
          url: "/#vecka", tag: "veckoplan",
        });
        log.push("veckoplan");
      }

      // Lunchkoll: inget klart idag än
      if (weekday <= 5 && within("13:00", 30) && await once("lunchkoll", date)) {
        const { count } = await db.from("tasks").select("id", { count: "exact", head: true })
          .eq("user_id", s.user_id).eq("status", "klar").gte("completed_at", date + "T00:00:00+01:00");
        const { data: top } = await db.from("tasks").select("title,first_step").eq("user_id", s.user_id).eq("is_top3", true).neq("status", "klar").limit(1);
        if (!count && top && top.length) {
          await sendPush(db, s.user_id, {
            title: "Halva dagen kvar 💪",
            body: `Bara första steget: ${top[0].first_step || top[0].title}. Fem minuter räcker.`,
            url: "/#idag", tag: "lunchkoll",
          });
        }
      }

      // Kvällsavstämning
      if (within(s.evening_time, 60) && await once("kvall", date)) {
        const { count } = await db.from("tasks").select("id", { count: "exact", head: true })
          .eq("user_id", s.user_id).eq("status", "klar").gte("completed_at", date + "T00:00:00+01:00");
        await sendPush(db, s.user_id, {
          title: "🌙 Kvällsavstämning",
          body: count ? `Du fick ${count} saker klara idag. Två minuter för att runda av?` : "Två minuter för att runda av dagen. Ingen skuld, bara läget.",
          url: "/#kvall", tag: "kvall",
        });
      }

      // Rutiner
      if (at("07:30")) {
        const { data: rts } = await db.from("routines").select("*").eq("user_id", s.user_id).eq("active", true).lte("next_due", date);
        for (const r of rts || []) {
          if (!(await once("rutin_" + r.id, date))) continue;
          await sendPush(db, s.user_id, { title: "🔁 " + r.title, body: "Dags idag. Öppna checklistan.", url: "/#rutiner", tag: "rutin" + r.id });
          await db.from("routines").update({ next_due: nextDue(r, date) }).eq("id", r.id);
        }
      }
    } catch (e) {
      console.error("jobb fel", s.user_id, e);
      log.push("fel: " + (e as Error).message);
    }
  }
  return json({ ok: true, log });
});

function nextDue(r: any, date: string) {
  if (r.freq === "dag") return addDays(date, 1);
  if (r.freq === "vecka") return addDays(date, 7);
  const d = new Date(date + "T12:00:00Z");
  if (r.freq === "ar") { d.setUTCFullYear(d.getUTCFullYear() + 1); return d.toISOString().slice(0, 10); }
  d.setUTCMonth(d.getUTCMonth() + 1);
  if (r.day_of_month) d.setUTCDate(Math.min(r.day_of_month, 28));
  return d.toISOString().slice(0, 10);
}
