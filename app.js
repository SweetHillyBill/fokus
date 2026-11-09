import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SB_URL = "https://npdstplyajciefkiahct.supabase.co";
const SB_KEY = "sb_publishable_SO3NyabDSYnTwqcphELq4A_KU8e239b";
const VAPID = "BNCaaeGbLDYpTD3OunhjrS-43bAlDPgOztC1yLZ2metCDIOp6Fm-fxuY4xtmBvb1evXzrhkGDlSFAJcPYC0gq0U";
const sb = createClient(SB_URL, SB_KEY, { auth: { persistSession: true, autoRefreshToken: true } });

const $ = (s, el = document) => el.querySelector(s);
const view = $("#view");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
let user = null;
let weekOffset = (new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Stockholm", weekday: "long" }) === "söndag") ? 1 : 0;

// ---------- Datum ----------
const today = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Stockholm" });
const addDays = (d, n) => { const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const monday = (d) => addDays(d, 1 - (new Date(d + "T12:00:00Z").getUTCDay() || 7));
const dayLabel = (d) => {
  if (d === today()) return "Idag";
  if (d === addDays(today(), 1)) return "Imorgon";
  return new Date(d + "T12:00:00Z").toLocaleDateString("sv-SE", { weekday: "long", day: "numeric", month: "short" });
};
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// ---------- Hjälpare ----------
function toast(msg, ms = 2400) { const t = $("#toast"); t.textContent = msg; t.classList.remove("hidden"); clearTimeout(t._h); t._h = setTimeout(() => t.classList.add("hidden"), ms); }
async function q(p) { const { data, error } = await p; if (error) { toast("Fel: " + error.message); throw error; } return data; }
function sheet(html, onMount) {
  const s = $("#sheet"); s.innerHTML = `<div class="inner">${html}</div>`; s.classList.remove("hidden");
  s.onclick = (e) => { if (e.target === s) closeSheet(); };
  onMount && onMount(s);
}
function closeSheet() { $("#sheet").classList.add("hidden"); $("#sheet").innerHTML = ""; }
async function aiBreakdown(id, extra) {
  const { data, error } = await sb.functions.invoke("coach", { body: { mode: "breakdown", task_id: id, extra } });
  if (error) { let m = error.message; try { const j = await error.context.json(); m = j.error || m; } catch {} throw new Error(m); }
  if (data?.error) throw new Error(data.error);
  return data;
}

// ---------- Router ----------
const routes = { idag, vecka, lista };
async function route() {
  if (!user) return login();
  const r = location.hash.slice(1) || "idag";
  document.querySelectorAll("nav a").forEach((a) => a.classList.toggle("on", a.dataset.r === r));
  try { await (routes[r] || idag)(); } catch (e) { console.error(e); view.innerHTML = `<div class="card">Något gick fel: ${esc(e.message)}</div>`; }
}
window.addEventListener("hashchange", route);

// ---------- Inloggning ----------
function login() {
  $("#nav").classList.add("hidden"); $("#gear").classList.add("hidden");
  view.innerHTML = `<h1>Logga in</h1>
  <div class="card"><label>Mejladress</label><input id="em" type="email" autocomplete="username" value="calle.landsberg@gmail.com">
  <label>Lösenord</label><input id="pw" type="password" autocomplete="current-password">
  <button id="in" class="big" style="margin-top:14px">Logga in</button></div>`;
  $("#in").onclick = async () => {
    const { error } = await sb.auth.signInWithPassword({ email: $("#em").value.trim(), password: $("#pw").value });
    if (error) toast("Fel mejladress eller lösenord");
  };
}

// ---------- Uppgiftsrad ----------
function row(t, opts = {}) {
  const steps = t.steps || [];
  const done = steps.filter((s) => s.done).length;
  const isDone = t.status === "klar";
  return `<div class="item ${isDone ? "done" : ""}" data-id="${t.id}">
    <button class="check ${isDone ? "on" : ""}" data-act="done" aria-label="Klar"></button>
    <div class="grow" data-act="open">
      <div class="title">${esc(t.title)}</div>
      ${(() => { const m = [steps.length ? `${done}/${steps.length} steg` : "", opts.showDay && t.scheduled_for ? dayLabel(t.scheduled_for) : ""].filter(Boolean).join(" · "); return m ? `<div class="meta">${m}</div>` : ""; })()}
    </div>
  </div>`;
}
function bindRows(root = view) {
  root.querySelectorAll(".item").forEach((el) => {
    const id = el.dataset.id;
    el.querySelector("[data-act=done]").onclick = (e) => { e.stopPropagation(); toggleDone(id); };
    el.querySelector("[data-act=open]").onclick = () => openTask(id);
  });
}
function addBox(placeholder, onAdd) {
  return { html: `<div class="add"><input placeholder="${placeholder}" enterkeyhint="done"><button aria-label="Lägg till">+</button></div>`, bind: (el) => {
    const inp = el.querySelector("input"); const go = async () => { const v = inp.value.trim(); if (!v) return; inp.value = ""; await onAdd(v); };
    el.querySelector("button").onclick = go; inp.onkeydown = (e) => { if (e.key === "Enter") go(); };
  } };
}
async function toggleDone(id) {
  const t = await q(sb.from("tasks").select("status").eq("id", id).single());
  const klar = t.status !== "klar";
  await q(sb.from("tasks").update({ status: klar ? "klar" : "planerad", completed_at: klar ? new Date().toISOString() : null }).eq("id", id));
  if (klar) { toast("Klart! 👏"); if (navigator.vibrate) navigator.vibrate(40); }
  route();
}
const newTask = (title, day) => q(sb.from("tasks").insert({ title, scheduled_for: day || null, status: day ? "planerad" : "inkorg" }));

// ---------- IDAG ----------
async function idag() {
  const d = today();
  const [mine, old] = await Promise.all([
    q(sb.from("tasks").select("*").eq("scheduled_for", d).neq("status", "struken").order("status").order("created_at")),
    q(sb.from("tasks").select("*").lt("scheduled_for", d).in("status", ["planerad", "pagar", "inkorg"]).order("scheduled_for")),
  ]);
  const open = mine.filter((t) => t.status !== "klar"), done = mine.filter((t) => t.status === "klar");
  const add = addBox("Lägg till för idag…", (v) => newTask(v, d).then(route));
  view.innerHTML = `<h1>${cap(new Date().toLocaleDateString("sv-SE", { weekday: "long", day: "numeric", month: "long" }))}</h1>
    <div id="add">${add.html}</div>
    <div class="card list">${open.map((t) => row(t)).join("") || `<p class="empty">Inget planerat. Lägg till något ovan, eller hämta från Lista.</p>`}</div>
    ${old.length ? `<h2>Kvar sedan tidigare</h2><div class="card list">${old.map((t) => row(t, { showDay: true })).join("")}</div>
      <button id="mv" class="sec">Flytta alla till idag</button>` : ""}
    ${done.length ? `<h2>Klart idag (${done.length})</h2><div class="card list">${done.map((t) => row(t)).join("")}</div>` : ""}`;
  add.bind($("#add")); bindRows();
  const mv = $("#mv"); if (mv) mv.onclick = async () => { await q(sb.from("tasks").update({ scheduled_for: d }).in("id", old.map((t) => t.id))); route(); };
}

// ---------- VECKA ----------
async function vecka() {
  const start = addDays(monday(today()), weekOffset * 7), end = addDays(start, 6);
  const ts = await q(sb.from("tasks").select("*").gte("scheduled_for", start).lte("scheduled_for", end).neq("status", "struken").order("created_at"));
  const wk = (() => { const d = new Date(start + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + 3); const y = new Date(Date.UTC(d.getUTCFullYear(), 0, 4)); return 1 + Math.round(((d - y) / 864e5 - 3 + ((y.getUTCDay() + 6) % 7)) / 7); })();
  view.innerHTML = `<div class="row between"><button class="ghost" id="pv">‹</button><h1 style="margin:0">Vecka ${wk}</h1><button class="ghost" id="nx">›</button></div>
    ${Array.from({ length: 7 }, (_, i) => addDays(start, i)).map((d) => {
      const l = ts.filter((t) => t.scheduled_for === d);
      return `<div class="day ${d === today() ? "now" : ""}"><div class="row between"><h2>${cap(dayLabel(d))}</h2><button class="ghost small" data-add="${d}">+ Lägg till</button></div>
      ${l.length ? `<div class="card list">${l.map((t) => row(t)).join("")}</div>` : `<p class="empty small">Tomt</p>`}</div>`;
    }).join("")}`;
  bindRows();
  $("#pv").onclick = () => { weekOffset--; route(); };
  $("#nx").onclick = () => { weekOffset++; route(); };
  view.querySelectorAll("[data-add]").forEach((b) => b.onclick = () => pickOrNew(b.dataset.add));
}
async function pickOrNew(day) {
  const inbox = await q(sb.from("tasks").select("*").in("status", ["inkorg", "planerad"]).is("scheduled_for", null).order("created_at").limit(30));
  const add = addBox("Ny uppgift…", async (v) => { await newTask(v, day); closeSheet(); route(); });
  sheet(`<h2 style="margin-top:0">${cap(dayLabel(day))}</h2><div id="sa">${add.html}</div>
    ${inbox.length ? `<h2>Eller hämta från Lista</h2><div class="card list">${inbox.map((t) => `<div class="item" data-pick="${t.id}"><div class="grow"><div class="title">${esc(t.title)}</div></div><span class="muted">＋</span></div>`).join("")}</div>` : ""}`, (s) => {
    add.bind($("#sa", s)); $("#sa input", s).focus();
    s.querySelectorAll("[data-pick]").forEach((el) => el.onclick = async () => { await q(sb.from("tasks").update({ scheduled_for: day, status: "planerad" }).eq("id", el.dataset.pick)); closeSheet(); route(); });
  });
}

// ---------- LISTA ----------
async function lista() {
  const [all, klara] = await Promise.all([
    q(sb.from("tasks").select("*").in("status", ["inkorg", "planerad", "pagar"]).order("created_at")),
    q(sb.from("tasks").select("*").eq("status", "klar").order("completed_at", { ascending: false }).limit(100)),
  ]);
  const byDay = {};
  klara.forEach((t) => { const d = new Date(t.completed_at).toLocaleDateString("sv-SE", { timeZone: "Europe/Stockholm" }); (byDay[d] ||= []).push(t); });
  const unplanned = all.filter((t) => !t.scheduled_for), planned = all.filter((t) => t.scheduled_for).sort((a, b) => a.scheduled_for.localeCompare(b.scheduled_for));
  const add = addBox("Ny uppgift…", (v) => newTask(v).then(route));
  view.innerHTML = `<h1>Att göra</h1><div id="add">${add.html}</div>
    <h2>Ej planerat (${unplanned.length})</h2>
    <div class="card list">${unplanned.map((t) => row(t)).join("") || `<p class="empty">Allt är planerat.</p>`}</div>
    ${planned.length ? `<h2>Planerat (${planned.length})</h2><div class="card list">${planned.map((t) => row(t, { showDay: true })).join("")}</div>` : ""}
    <h2>Slutfört (${klara.length})</h2>
    ${Object.entries(byDay).map(([d, l]) => `<div class="meta" style="margin:10px 0 4px">${cap(dayLabel(d))}</div><div class="card list">${l.map((t) => row(t)).join("")}</div>`).join("") || `<p class="empty">Inget slutfört än.</p>`}`;
  add.bind($("#add")); bindRows();
}

// ---------- UPPGIFT: detalj och nedbrytning ----------
async function openTask(id) {
  const t = await q(sb.from("tasks").select("*").eq("id", id).single());
  const [parent, children] = await Promise.all([
    t.parent_id ? q(sb.from("tasks").select("id,title").eq("id", t.parent_id).maybeSingle()) : null,
    q(sb.from("tasks").select("*").eq("parent_id", id).neq("status", "struken").order("created_at")),
  ]);
  const steps = t.steps || [];
  const d = today();
  const dayBtns = [["Idag", d], ["Imorgon", addDays(d, 1)], ["Ingen dag", ""]];
  sheet(`
    ${parent ? `<button class="ghost small" id="par">‹ Del av: ${esc(parent.title)}</button>` : ""}
    <input id="ti" class="titlein" value="${esc(t.title)}">
    <label>Dag</label>
    <div class="seg">${dayBtns.map(([l, v]) => `<button data-day="${v}" class="${(t.scheduled_for || "") === v ? "on" : ""}">${l}</button>`).join("")}</div>
    <input id="dt" type="date" value="${t.scheduled_for || ""}" style="margin-top:8px">
    <div class="row between" style="margin-top:18px"><h2 style="margin:0">Steg</h2><button id="ai" class="sec small">✨ Bryt ner</button></div>
    <div id="steps">${steps.map((s, i) => `<div class="step"><input type="checkbox" data-i="${i}" ${s.done ? "checked" : ""}><span class="grow ${s.done ? "struck" : ""}">${esc(s.text)}</span><button class="ghost small" data-up="${i}" title="Gör till egen uppgift">↗</button><button class="ghost small" data-rm="${i}">✕</button></div>`).join("") || `<p class="empty small">Inga steg än. Tryck på Bryt ner, eller skriv egna nedan.</p>`}</div>
    <div class="add" id="ns"><input placeholder="Lägg till steg…" enterkeyhint="done"><button>+</button></div>
    ${steps.length ? `<p class="muted small">↗ gör ett steg till en egen uppgift som du kan planera på en dag och bryta ner vidare.</p>` : ""}
    ${children.length ? `<h2>Deluppgifter</h2><div class="card list" id="kids">${children.map((c) => row(c, { showDay: true })).join("")}</div>` : ""}
    <div class="row" style="margin-top:20px"><button id="dn" class="grow">${t.status === "klar" ? "Ångra klar" : "✓ Klar"}</button><button id="rm" class="danger">Ta bort</button></div>`, (s) => {
    const save = async (patch) => { await q(sb.from("tasks").update(patch).eq("id", id)); };
    const reopen = async () => { await openTask(id); route(); };
    $("#ti", s).onchange = async (e) => { await save({ title: e.target.value.trim() || t.title }); route(); };
    s.querySelectorAll("[data-day]").forEach((b) => b.onclick = async () => { const v = b.dataset.day || null; await save({ scheduled_for: v, status: v ? "planerad" : "inkorg" }); reopen(); });
    $("#dt", s).onchange = async (e) => { const v = e.target.value || null; await save({ scheduled_for: v, status: v ? "planerad" : "inkorg" }); reopen(); };
    s.querySelectorAll("[data-i]").forEach((cb) => cb.onchange = async () => { const st = steps.slice(); st[cb.dataset.i] = { ...st[cb.dataset.i], done: cb.checked }; await save({ steps: st }); reopen(); });
    s.querySelectorAll("[data-rm]").forEach((b) => b.onclick = async () => { const st = steps.slice(); st.splice(+b.dataset.rm, 1); await save({ steps: st }); reopen(); });
    s.querySelectorAll("[data-up]").forEach((b) => b.onclick = async () => {
      const i = +b.dataset.up; const st = steps.slice(); const [step] = st.splice(i, 1);
      await q(sb.from("tasks").insert({ title: step.text, parent_id: id, status: "inkorg" }));
      await save({ steps: st }); toast("Nu en egen deluppgift"); reopen();
    });
    const ns = $("#ns", s); const addStep = async () => { const v = ns.querySelector("input").value.trim(); if (!v) return; await save({ steps: [...steps, { text: v, done: false }] }); reopen(); };
    ns.querySelector("button").onclick = addStep; ns.querySelector("input").onkeydown = (e) => { if (e.key === "Enter") addStep(); };
    $("#ai", s).onclick = async (e) => {
      e.target.disabled = true; e.target.textContent = "Tänker…";
      try {
        const old = steps.slice();
        const r = await aiBreakdown(id);
        // behåll egna steg som inte finns i förslaget
        const ai = (r.steps || []).map((x) => ({ text: x, done: false }));
        await save({ steps: [...old.filter((o) => o.done), ...ai] });
        reopen();
      } catch (er) { toast(er.message, 5000); e.target.disabled = false; e.target.textContent = "✨ Bryt ner"; }
    };
    if (children.length) bindRows($("#kids", s));
    const par = $("#par", s); if (par) par.onclick = () => openTask(parent.id);
    $("#dn", s).onclick = async () => { closeSheet(); await toggleDone(id); };
    $("#rm", s).onclick = async () => { await save({ status: "struken" }); closeSheet(); toast("Borttagen"); route(); };
  });
}

// ---------- Inställningar (kugghjulet) ----------
$("#gear").onclick = () => {
  const perm = "Notification" in window ? Notification.permission : "saknas";
  sheet(`<h2 style="margin-top:0">Inställningar</h2>
    <p class="small muted">Notiser: ${perm === "granted" ? "på ✓" : "av"}. Du får en notis 06:45 vardagar med dagens att göra, och söndag 10:00 en påminnelse om att planera veckan.</p>
    <div class="row"><button id="pu" class="grow">Slå på notiser</button><button id="tp" class="sec">Testa</button></div>
    <button id="lo" class="danger" style="margin-top:20px">Logga ut</button>`, (s) => {
    $("#pu", s).onclick = enablePush;
    $("#tp", s).onclick = async () => { const { data } = await sb.functions.invoke("coach", { body: { mode: "test_push" } }); toast(data?.sent ? "Skickad, kolla mobilen" : "Slå på notiser först"); };
    $("#lo", s).onclick = async () => { closeSheet(); await sb.auth.signOut(); };
  });
};
function b64ToU8(b) { const p = "=".repeat((4 - (b.length % 4)) % 4); const r = atob((b + p).replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from([...r].map((c) => c.charCodeAt(0))); }
async function enablePush() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return toast("Notiser stöds inte här. Installera appen i Chrome.", 5000);
  if (await Notification.requestPermission() !== "granted") return toast("Notiser nekades.", 4000);
  const reg = await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(VAPID) });
  const j = sub.toJSON();
  await q(sb.from("push_subscriptions").upsert({ endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth }, { onConflict: "endpoint" }));
  toast("Notiser påslagna ✓"); closeSheet();
}

// ---------- Start ----------
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");
navigator.serviceWorker?.addEventListener("message", (e) => { if (e.data?.url) location.hash = "#" + (e.data.url.split("#")[1] || "idag").split("?")[0]; });
async function onSession(session) {
  const was = user?.id;
  user = session?.user || null;
  if (user && was !== user.id) {
    $("#nav").classList.remove("hidden"); $("#gear").classList.remove("hidden");
    route();
  } else if (!user) route();
}
sb.auth.onAuthStateChange((_ev, session) => { setTimeout(() => onSession(session), 0); });
