// Synk mellan Home Assistants att göra listor och Fokus.
// HA skickar alla poster (öppna och klara) från valda listor. Svaret innehåller poster som HA ska bocka av.
// Rader som börjar med "↳" räknas som steg under närmast föregående huvudrad.
import { createClient } from "npm:@supabase/supabase-js@2";

const EMAIL = "calle.landsberg@gmail.com";
const json = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "Content-Type": "application/json" } });
const CHILD = /^[\s⠀]*↳\s*/;
const clean = (s: string) => String(s || "").replace(CHILD, "").trim();

type Item = { uid: string; summary: string; status: string };
type Step = { text: string; done: boolean; ha_uid?: string };

Deno.serve(async (req) => {
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const { data: secret } = await db.rpc("get_app_secret", { p_name: "ha_sync_secret" });
  if (!secret || req.headers.get("x-sync-secret") !== secret) return json({ error: "nej" }, 401);

  const body = await req.json().catch(() => ({}));
  const lists: Record<string, { items: Item[] }> = body.lists || {};
  const { data: users } = await db.auth.admin.listUsers();
  const uid = users?.users?.find((u) => (u.email || "").toLowerCase() === EMAIL)?.id;
  if (!uid) return json({ complete: [], note: "ingen användare" });

  const complete: { entity_id: string; uid: string }[] = [];
  const stats = { nya: 0, uppdaterade: 0, klara: 0 };
  const now = new Date().toISOString();

  for (const [entity, val] of Object.entries(lists)) {
    const items: Item[] = val?.items || [];
    const seen = new Set(items.map((i) => i.uid));
    const { data: existing } = await db.from("tasks").select("*").eq("user_id", uid).eq("ha_entity", entity);
    const byUid = new Map<string, any>();
    const stepOwner = new Map<string, any>();
    for (const t of existing || []) {
      byUid.set(t.ha_uid, t);
      for (const s of (t.steps || []) as Step[]) if (s.ha_uid) stepOwner.set(s.ha_uid, t);
    }

    // Gruppera huvudrader med sina ↳ rader
    const groups: { parent: Item; children: Item[] }[] = [];
    const orphans: Item[] = [];
    let cur: { parent: Item; children: Item[] } | null = null;
    for (const it of items) {
      if (CHILD.test(it.summary || "")) {
        if (stepOwner.has(it.uid)) orphans.push(it);
        else if (cur) cur.children.push(it);
        else orphans.push(it);
      } else {
        cur = { parent: it, children: [] };
        groups.push(cur);
      }
    }

    const touched = new Map<string, any>(); // task id -> task (med uppdaterade steg)
    const getT = (t: any) => { if (!touched.has(t.id)) touched.set(t.id, { ...t, steps: [...(t.steps || [])], _dirty: false }); return touched.get(t.id); };

    for (const g of groups) {
      const p = g.parent;
      let t = byUid.get(p.uid);
      if (!t) {
        if (p.status === "completed") continue;
        const steps: Step[] = g.children.map((c) => ({ text: clean(c.summary), done: c.status === "completed", ha_uid: c.uid }));
        const { data } = await db.from("tasks").insert({ user_id: uid, title: clean(p.summary), status: "inkorg", steps, ha_entity: entity, ha_uid: p.uid }).select().single();
        if (data) { byUid.set(p.uid, data); for (const s of steps) stepOwner.set(s.ha_uid!, data); }
        stats.nya++;
        continue;
      }
      const w = getT(t);
      if (clean(p.summary) !== w.title) { w.title = clean(p.summary); w._dirty = true; }
      if (p.status === "completed" && w.status !== "klar") { w.status = "klar"; w.completed_at = now; w._dirty = true; stats.klara++; }
      else if (p.status !== "completed" && w.status === "klar") complete.push({ entity_id: entity, uid: p.uid });
      for (const c of g.children) syncStep(w, c, entity);
    }
    for (const c of orphans) {
      const owner = stepOwner.get(c.uid);
      if (owner) syncStep(getT(owner), c, entity);
    }

    function syncStep(w: any, c: Item, ent: string) {
      const idx = w.steps.findIndex((s: Step) => s.ha_uid === c.uid);
      const done = c.status === "completed";
      if (idx < 0) { w.steps.push({ text: clean(c.summary), done, ha_uid: c.uid }); w._dirty = true; return; }
      const s = w.steps[idx];
      if (s.text !== clean(c.summary)) { s.text = clean(c.summary); w._dirty = true; }
      if (done && !s.done) { s.done = true; w._dirty = true; }
      else if (!done && (s.done || w.status === "klar")) complete.push({ entity_id: ent, uid: c.uid });
    }

    // Borttaget i HA: släpp steg och stryk öppna uppgifter
    for (const t of existing || []) {
      const w = getT(t);
      const before = w.steps.length;
      w.steps = w.steps.filter((s: Step) => !s.ha_uid || seen.has(s.ha_uid));
      if (w.steps.length !== before) w._dirty = true;
      if (!seen.has(t.ha_uid) && !["klar", "struken"].includes(w.status)) { w.status = "struken"; w._dirty = true; }
    }

    for (const w of touched.values()) {
      if (!w._dirty) continue;
      await db.from("tasks").update({ title: w.title, status: w.status, completed_at: w.completed_at, steps: w.steps }).eq("id", w.id);
      stats.uppdaterade++;
    }
  }

  // Unika poster att bocka av
  const uniq = [...new Map(complete.map((c) => [c.entity_id + c.uid, c])).values()];
  return json({ complete: uniq, ...stats });
});
