import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SB_URL = "https://npdstplyajciefkiahct.supabase.co";
const SB_KEY = "sb_publishable_SO3NyabDSYnTwqcphELq4A_KU8e239b";
const VAPID = "BNCaaeGbLDYpTD3OunhjrS-43bAlDPgOztC1yLZ2metCDIOp6Fm-fxuY4xtmBvb1evXzrhkGDlSFAJcPYC0gq0U";
const sb = createClient(SB_URL, SB_KEY, { auth: { persistSession: true, autoRefreshToken: true } });

const $ = (s, el = document) => el.querySelector(s);
const view = $("#view");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
let user = null;
let settings = null;

// ---------- Hjälpare ----------
function today() { return new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Stockholm" }); }
function addDays(d, n) { const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }
function toast(msg, ms = 2600) { const t = $("#toast"); t.textContent = msg; t.classList.remove("hidden"); clearTimeout(t._h); t._h = setTimeout(() => t.classList.add("hidden"), ms); }
function celebrate(e = "🎉") { const d = document.createElement("div"); d.className = "confetti"; d.textContent = e; document.body.append(d); setTimeout(() => d.remove(), 1300); if (navigator.vibrate) navigator.vibrate([40, 40, 80]); }
async function coach(mode, payload = {}) {
  const { data, error } = await sb.functions.invoke("coach", { body: { mode, ...payload } });
  if (error) { let m = error.message; try { const j = await error.context.json(); m = j.error || m; } catch {} throw new Error(m); }
  if (data?.error) throw new Error(data.error);
  return data;
}
async function q(p) { const { data, error } = await p; if (error) { toast("Fel: " + error.message); throw error; } return data; }
function sheet(html, onMount) {
  const s = $("#sheet"); s.innerHTML = `<div class="inner">${html}</div>`; s.classList.remove("hidden");
  s.onclick = (e) => { if (e.target === s) closeSheet(); };
  onMount && onMount(s);
}
function closeSheet() { $("#sheet").classList.add("hidden"); $("#sheet").innerHTML = ""; }
function busy(btn, on, txt) { if (!btn) return; if (on) { btn._t = btn.textContent; btn.textContent = txt || "Tänker…"; btn.disabled = true; } else { btn.textContent = btn._t; btn.disabled = false; } }

// ---------- Klocka och synlig tid ----------
function tickClock() {
  const now = new Date();
  const hm = now.toLocaleTimeString("sv-SE", { timeZone: "Europe/Stockholm", hour: "2-digit", minute: "2-digit" });
  const end = new Date(now); end.setHours(17, 0, 0, 0);
  const left = Math.round((end - now) / 60000);
  const txt = left > 0 ? `${Math.floor(left / 60)} h ${left % 60} min kvar till 17` : "Arbetsdagen är slut";
  $("#clock").innerHTML = `<b>${hm}</b><br>${txt}`;
}
setInterval(tickClock, 20000); tickClock();

// ---------- Router ----------
const routes = { idag, fokus, coach: coachView, vecka, mer, uppgifter, projekt, parkering, klart, rutiner, kvall, installningar, monster };
async function route() {
  if (!user) return login();
  const r = (location.hash.slice(1).split("?")[0]) || "idag";
  document.querySelectorAll("nav a").forEach((a) => a.classList.toggle("on", a.dataset.r === r || (a.dataset.r === "mer" && !["idag", "fokus", "coach", "vecka"].includes(r))));
  $("#fab").classList.toggle("hidden", ["fokus", "coach"].includes(r));
  try { await (routes[r] || idag)(); } catch (e) { console.error(e); view.innerHTML = `<div class="card">Något gick fel: ${esc(e.message)}</div>`; }
  window.scrollTo(0, 0);
}
window.addEventListener("hashchange", route);

// ---------- Inloggning ----------
function login() {
  $("#nav").classList.add("hidden"); $("#fab").classList.add("hidden");
  view.innerHTML = `<h1>Välkommen till Fokus</h1>
  <div class="card"><label>Mejladress</label><input id="em" type="email" autocomplete="username" value="calle.landsberg@gmail.com">
  <label>Lösenord</label><input id="pw" type="password" autocomplete="current-password">
  <div class="row" style="margin-top:14px"><button id="in" class="grow">Logga in</button><button id="up" class="sec">Skapa konto</button></div>
  <p class="small muted">Första gången: skapa konto, bekräfta via mejlet, logga sedan in här.</p></div>`;
  $("#in").onclick = async () => {
    const { error } = await sb.auth.signInWithPassword({ email: $("#em").value.trim(), password: $("#pw").value });
    if (error) toast(error.message === "Email not confirmed" ? "Bekräfta mejlet först" : "Fel mejladress eller lösenord");
  };
  $("#up").onclick = async () => {
    const { error } = await sb.auth.signUp({ email: $("#em").value.trim(), password: $("#pw").value, options: { emailRedirectTo: location.href.split("#")[0] } });
    toast(error ? error.message : "Kolla mejlen och bekräfta, logga sedan in.", 5000);
  };
}

async function loadSettings() {
  let s = await q(sb.from("settings").select("*").maybeSingle());
  if (!s) s = await q(sb.from("settings").insert({}).select().single());
  settings = s;
}

// ---------- IDAG ----------
async function idag() {
  const d = today();
  const [plan, top, planned, inbox, doneToday] = await Promise.all([
    q(sb.from("day_plans").select("*").eq("date", d).maybeSingle()),
    q(sb.from("tasks").select("*").eq("is_top3", true).neq("status", "struken").order("sort")),
    q(sb.from("tasks").select("*").eq("scheduled_for", d).eq("is_top3", false).in("status", ["planerad", "pagar", "inkorg"])),
    q(sb.from("tasks").select("id", { count: "exact" }).eq("status", "inkorg")),
    q(sb.from("tasks").select("id,title").eq("status", "klar").gte("completed_at", d + "T00:00:00")),
  ]);
  const p = plan?.plan || {};
  const openTop = top.filter((t) => t.status !== "klar");
  view.innerHTML = `
  <h1>${new Date().toLocaleDateString("sv-SE", { weekday: "long", day: "numeric", month: "long" })}</h1>
  ${plan ? `<div class="pep">${esc(plan.message || "Tre saker idag. En i taget.")}</div>` : `<div class="card"><p>Ingen dagsplan än. Den kommer automatiskt 06:45 på vardagar, eller gör den nu.</p><button id="mk" class="big">Gör dagens plan</button></div>`}
  <h2>Dagens tre ${doneToday.length ? `<span class="tag">✓ ${doneToday.length} klara idag</span>` : ""}</h2>
  ${top.length ? top.map(taskCard).join("") : `<p class="muted">Inga valda än.</p>`}
  ${openTop.length ? `<button id="go" class="big" style="margin-top:8px">▶ Starta ${esc(openTop[0].title)}</button>` : ""}
  ${(p.blocks || []).length ? `<h2>Tidsrutor</h2><div class="card">${p.blocks.map((b) => `<div class="block"><b>${esc(b.time)}</b><div>${esc(b.title)} <span class="muted small">${b.minutes} min</span></div></div>`).join("")}</div>` : ""}
  ${(p.can_wait || []).length ? `<h2>Får vänta</h2><p class="muted small">${p.can_wait.map(esc).join(" · ")}</p>` : ""}
  ${planned.length ? `<h2>Också planerat idag</h2>${planned.map(taskCard).join("")}` : ""}
  <div class="row wrap" style="margin-top:16px">
    <a class="btn sec" style="background:var(--soft);color:var(--ink);text-decoration:none" href="#uppgifter">Alla uppgifter${inbox.length ? ` (${inbox.length} i inkorgen)` : ""}</a>
    ${plan ? `<button id="mk" class="sec">Gör om planen</button>` : ""}
  </div>`;
  bindTaskCards();
  const mk = $("#mk"); if (mk) mk.onclick = async () => { busy(mk, true, "Planerar…"); try { await coach("plan_day"); route(); } catch (e) { toast(e.message, 5000); busy(mk, false); } };
  const go = $("#go"); if (go) go.onclick = () => startTask(openTop[0].id);
  const pm = new URLSearchParams(location.hash.split("?")[1]);
  if (pm.get("start") && openTop[0]) startTask(openTop[0].id);
}

function taskCard(t) {
  const done = t.status === "klar";
  return `<div class="card ${t.status === "pagar" ? "hl" : ""}" data-id="${t.id}">
    <div class="task">
      <button class="check ${done ? "on" : ""}" data-act="done" aria-label="Klar"></button>
      <div class="grow">
        <div class="title" style="${done ? "text-decoration:line-through;opacity:.6" : ""}">${esc(t.title)}</div>
        ${t.first_step && !done ? `<div class="step">Första steget: ${esc(t.first_step)}</div>` : ""}
        <div class="small muted" style="margin-top:4px">${t.estimate_min ? `<span class="tag">⏱ ${t.estimate_min} min</span>` : ""}${t.due_date ? `<span class="tag ${t.due_date <= today() ? "warn" : ""}">📅 ${t.due_date}</span>` : ""}${t.status === "pagar" ? `<span class="tag">pågår</span>` : ""}</div>
      </div>
      ${done ? "" : `<button class="ghost" data-act="menu">⋯</button>`}
    </div></div>`;
}
function bindTaskCards() {
  view.querySelectorAll("[data-id]").forEach((c) => {
    const id = c.dataset.id;
    c.querySelector("[data-act=done]")?.addEventListener("click", (e) => { e.stopPropagation(); completeTask(id); });
    c.querySelector("[data-act=menu]")?.addEventListener("click", (e) => { e.stopPropagation(); taskMenu(id); });
    c.addEventListener("click", () => taskMenu(id));
  });
}
async function completeTask(id) {
  const t = await q(sb.from("tasks").select("*").eq("id", id).single());
  if (t.status === "klar") { await q(sb.from("tasks").update({ status: "planerad", completed_at: null }).eq("id", id)); return route(); }
  await q(sb.from("tasks").update({ status: "klar", completed_at: new Date().toISOString() }).eq("id", id));
  celebrate(["🎉", "💪", "🔥", "⭐", "🙌"][Math.floor(Math.random() * 5)]);
  toast(["Klart! Bra jobbat.", "En sak mindre i huvudet.", "Det där räknas. Snyggt!", "Klart är bättre än perfekt. 👏"][Math.floor(Math.random() * 4)]);
  route();
}
async function taskMenu(id) {
  const t = await q(sb.from("tasks").select("*").eq("id", id).single());
  const projects = await q(sb.from("projects").select("id,name").in("status", ["aktiv", "pausad"]));
  sheet(`<h2 style="margin-top:0">${esc(t.title)}</h2>
    <button id="st" class="big">▶ Starta fokuspass</button>
    <div class="row" style="margin-top:8px"><button id="bd" class="sec grow">🪄 Bryt ner</button><button id="tp" class="sec grow">${t.is_top3 ? "Ta bort från topp 3" : "Lägg i topp 3"}</button></div>
    ${t.steps?.length ? `<h2>Steg</h2>${t.steps.map((s, i) => `<label class="row" style="color:var(--ink);font-size:15px"><input type="checkbox" data-i="${i}" ${s.done ? "checked" : ""} style="width:auto"> ${esc(s.text)}</label>`).join("")}` : ""}
    <label>Titel</label><input id="ti" value="${esc(t.title)}">
    <label>Första steget (under fem minuter)</label><input id="fs" value="${esc(t.first_step)}">
    <label>Klart när…</label><input id="dd" value="${esc(t.done_definition)}" placeholder="Hur vet du att det är klart?">
    <div class="row"><div class="grow"><label>Planerad dag</label><input id="sf" type="date" value="${t.scheduled_for || ""}"></div><div class="grow"><label>Deadline</label><input id="du" type="date" value="${t.due_date || ""}"></div></div>
    <div class="row"><div class="grow"><label>Prioritet</label><select id="pr"><option value="1" ${t.priority == 1 ? "selected" : ""}>Hög</option><option value="2" ${t.priority == 2 ? "selected" : ""}>Normal</option><option value="3" ${t.priority == 3 ? "selected" : ""}>Låg</option></select></div>
    <div class="grow"><label>Energi som krävs</label><select id="en"><option value="lag" ${t.energy == "lag" ? "selected" : ""}>Låg</option><option value="medel" ${t.energy == "medel" ? "selected" : ""}>Medel</option><option value="hog" ${t.energy == "hog" ? "selected" : ""}>Hög</option></select></div></div>
    <div class="row"><div class="grow"><label>Din uppskattning (min)</label><input id="es" type="number" value="${t.estimate_min || ""}"></div><div class="grow"><label>Projekt</label><select id="pj"><option value="">Inget</option>${projects.map((p) => `<option value="${p.id}" ${p.id === t.project_id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select></div></div>
    <p class="small muted" id="est"></p>
    <div class="row" style="margin-top:14px"><button id="sv" class="grow">Spara</button><button id="ri" class="danger">Stryk</button></div>`, (s) => {
    const es = $("#es", s); const upd = () => { $("#est", s).textContent = es.value ? `Räkna med cirka ${Math.round(es.value * 1.5)} min (din uppskattning plus 50 procent).` : ""; }; es.oninput = upd; upd();
    $("#st", s).onclick = () => { closeSheet(); startTask(id); };
    $("#tp", s).onclick = async () => { await q(sb.from("tasks").update({ is_top3: !t.is_top3, scheduled_for: today() }).eq("id", id)); closeSheet(); route(); };
    $("#bd", s).onclick = async (e) => { busy(e.target, true); try { const r = await coach("breakdown", { task_id: id }); toast(r.pep || "Nedbrutet!"); closeSheet(); taskMenu(id); } catch (er) { toast(er.message, 5000); busy(e.target, false); } };
    s.querySelectorAll("[data-i]").forEach((cb) => cb.onchange = async () => { const steps = t.steps.slice(); steps[cb.dataset.i].done = cb.checked; await q(sb.from("tasks").update({ steps }).eq("id", id)); if (cb.checked) celebrate("✓"); });
    $("#sv", s).onclick = async () => {
      await q(sb.from("tasks").update({ title: $("#ti", s).value, first_step: $("#fs", s).value, done_definition: $("#dd", s).value, scheduled_for: $("#sf", s).value || null, due_date: $("#du", s).value || null, priority: +$("#pr", s).value, energy: $("#en", s).value, estimate_min: +$("#es", s).value || null, project_id: $("#pj", s).value || null, status: $("#sf", s).value && t.status === "inkorg" ? "planerad" : t.status }).eq("id", id));
      closeSheet(); route();
    };
    $("#ri", s).onclick = async () => { await q(sb.from("tasks").update({ status: "struken", is_top3: false }).eq("id", id)); closeSheet(); toast("Struken. Ibland är det rätt beslut."); route(); };
  });
}

// ---------- FOKUS ----------
let timer = null;
function startTask(id) { localStorage.setItem("fokus_task", id); location.hash = "#fokus"; if (location.hash === "#fokus") route(); }
async function fokus() {
  const id = localStorage.getItem("fokus_task");
  let t = id ? await q(sb.from("tasks").select("*").eq("id", id).maybeSingle()) : null;
  if (!t || t.status === "klar") {
    const cand = await q(sb.from("tasks").select("*").in("status", ["pagar", "planerad"]).order("is_top3", { ascending: false }).order("priority").limit(1));
    t = cand[0];
  }
  const run = JSON.parse(localStorage.getItem("fokus_run") || "null");
  if (!t) { view.innerHTML = `<h1>Fokus</h1><div class="card">Inget att fokusera på just nu. Lägg till en uppgift med plusknappen eller gör dagens plan.</div>`; return; }
  if (t.status !== "pagar") await sb.from("tasks").update({ status: "pagar" }).eq("id", t.id);
  view.innerHTML = `
    <div class="small muted">Du håller på med</div>
    <h1>${esc(t.title)}</h1>
    ${t.done_definition ? `<div class="small muted">Klart när: ${esc(t.done_definition)}</div>` : `<button id="dd" class="ghost">+ Bestäm vad "klart" betyder</button>`}
    <div class="pep" style="margin-top:12px">👉 ${esc(t.first_step || "Vad är det allra minsta första steget? Tryck på Bryt ner.")}</div>
    <div class="ring"><svg width="240" height="240"><circle cx="120" cy="120" r="108" stroke="var(--line)" stroke-width="14" fill="none"/><circle id="arc" cx="120" cy="120" r="108" stroke="var(--accent)" stroke-width="14" fill="none" stroke-linecap="round" stroke-dasharray="678.6" stroke-dashoffset="0"/></svg>
      <div class="t"><b id="tm">25:00</b><span class="small muted" id="tl">redo</span></div></div>
    <div class="seg" id="len">${[5, 15, 25, 45].map((m) => `<button data-m="${m}" class="${m === 25 ? "on" : ""}">${m} min</button>`).join("")}</div>
    <div class="row" style="margin-top:12px"><button id="go" class="big">▶ Kör</button></div>
    <div class="row" style="margin-top:8px"><button id="dn" class="sec grow">✓ Klar</button><button id="bd" class="sec grow">🪄 Bryt ner</button><button id="sw" class="sec grow">Byt</button></div>
    ${t.steps?.length ? `<h2>Steg</h2><div class="card">${t.steps.map((s, i) => `<label class="row" style="color:var(--ink);font-size:15px;margin:6px 0"><input type="checkbox" data-i="${i}" ${s.done ? "checked" : ""} style="width:auto"> ${esc(s.text)}</label>`).join("")}</div>` : ""}
    <h2>Kom du på något annat?</h2>
    <div class="row"><input id="pk" placeholder="Parkera det här, fortsätt sedan"><button id="pkb" class="sec">Parkera</button></div>`;
  let mins = 25;
  $("#len").querySelectorAll("button").forEach((b) => b.onclick = () => { mins = +b.dataset.m; $("#len").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b)); if (!JSON.parse(localStorage.getItem("fokus_run") || "null")) $("#tm").textContent = `${mins}:00`; });
  const draw = () => {
    const r = JSON.parse(localStorage.getItem("fokus_run") || "null");
    if (!r) return;
    const left = Math.max(0, r.end - Date.now());
    const tot = r.min * 60000;
    $("#tm") && ($("#tm").textContent = `${Math.floor(left / 60000)}:${String(Math.floor(left / 1000) % 60).padStart(2, "0")}`);
    $("#arc") && $("#arc").setAttribute("stroke-dashoffset", String(678.6 * (1 - left / tot)));
    $("#tl") && ($("#tl").textContent = left ? "kör" : "klart!");
    if (!left) finishRun(t, true);
  };
  clearInterval(timer); timer = setInterval(draw, 1000);
  if (run && run.task === t.id) { $("#go").textContent = "■ Avbryt passet"; draw(); }
  $("#go").onclick = async () => {
    const r = JSON.parse(localStorage.getItem("fokus_run") || "null");
    if (r) { await finishRun(t, false); return route(); }
    const end = Date.now() + mins * 60000;
    const sess = await q(sb.from("focus_sessions").insert({ task_id: t.id, planned_min: mins }).select().single());
    const rem = await q(sb.from("reminders").insert({ due_at: new Date(end).toISOString(), title: "⏰ Passet är slut", body: `${t.title}: bra jobbat! Klar, eller ett pass till?`, url: "/#fokus", tag: "timer" }).select().single());
    localStorage.setItem("fokus_run", JSON.stringify({ task: t.id, end, min: mins, sess: sess.id, rem: rem.id }));
    $("#go").textContent = "■ Avbryt passet"; draw();
    if (navigator.wakeLock) try { await navigator.wakeLock.request("screen"); } catch {}
  };
  $("#dn").onclick = async () => { await finishRun(t, true, true); localStorage.removeItem("fokus_task"); await completeTask(t.id); };
  $("#bd").onclick = async (e) => { busy(e.target, true); try { await coach("breakdown", { task_id: t.id }); route(); } catch (er) { toast(er.message, 5000); busy(e.target, false); } };
  $("#sw").onclick = async () => {
    const list = await q(sb.from("tasks").select("id,title").in("status", ["planerad", "pagar", "inkorg"]).neq("id", t.id).order("is_top3", { ascending: false }).limit(20));
    sheet(`<h2 style="margin-top:0">Byt till</h2><p class="small muted">Okej att byta, men fråga dig: är det här viktigare än det du höll på med?</p><div class="list">${list.map((x) => `<a href="#" data-s="${x.id}">${esc(x.title)}<span>›</span></a>`).join("")}</div>`, (s) => s.querySelectorAll("[data-s]").forEach((a) => a.onclick = async (e) => { e.preventDefault(); await sb.from("tasks").update({ status: "planerad" }).eq("id", t.id); closeSheet(); startTask(a.dataset.s); }));
  };
  const dd = $("#dd"); if (dd) dd.onclick = async () => { const v = prompt("Klart när…"); if (v) { await q(sb.from("tasks").update({ done_definition: v }).eq("id", t.id)); route(); } };
  view.querySelectorAll("[data-i]").forEach((cb) => cb.onchange = async () => { const steps = t.steps.slice(); steps[cb.dataset.i].done = cb.checked; await q(sb.from("tasks").update({ steps }).eq("id", t.id)); if (cb.checked) celebrate("✓"); });
  $("#pkb").onclick = async () => { const v = $("#pk").value.trim(); if (!v) return; await q(sb.from("ideas").insert({ text: v })); $("#pk").value = ""; toast("Parkerat. Tillbaka till " + t.title + " 💪"); };
}
async function finishRun(t, natural, silent) {
  const r = JSON.parse(localStorage.getItem("fokus_run") || "null");
  if (!r) return;
  localStorage.removeItem("fokus_run");
  clearInterval(timer);
  const spent = Math.round((Math.min(Date.now(), r.end) - (r.end - r.min * 60000)) / 60000);
  await sb.from("focus_sessions").update({ ended_at: new Date().toISOString(), completed: natural }).eq("id", r.sess);
  if (!natural || Date.now() < r.end) await sb.from("reminders").delete().eq("id", r.rem).is("sent_at", null);
  await sb.from("tasks").update({ actual_min: (t.actual_min || 0) + spent }).eq("id", t.id);
  if (natural && !silent) {
    celebrate("⏰");
    sheet(`<h2 style="margin-top:0">Passet är klart! 🙌</h2><p>${spent} minuter på ${esc(t.title)}. Hur går det?</p>
      <button id="a1" class="big">✓ Uppgiften är klar</button>
      <div class="row" style="margin-top:8px"><button id="a2" class="sec grow">Ett pass till</button><button id="a3" class="sec grow">Paus 5 min</button></div>`, (s) => {
      $("#a1", s).onclick = async () => { closeSheet(); localStorage.removeItem("fokus_task"); await completeTask(t.id); };
      $("#a2", s).onclick = () => { closeSheet(); route(); };
      $("#a3", s).onclick = async () => { await q(sb.from("reminders").insert({ due_at: new Date(Date.now() + 5 * 60000).toISOString(), title: "Pausen är slut", body: `Tillbaka till ${t.title}?`, url: "/#fokus" })); closeSheet(); toast("Jag påminner dig om fem minuter."); };
    });
  }
}

// ---------- FÅNGA ----------
$("#fab").onclick = () => {
  sheet(`<h2 style="margin-top:0">Fånga</h2>
    <div class="row"><textarea id="cap" placeholder="Skriv eller tala in…" style="min-height:70px"></textarea></div>
    <div class="row" style="margin-top:8px"><button id="mic" class="sec">🎤 Tala</button><span class="small muted grow" id="micst"></span></div>
    <div class="row" style="margin-top:10px"><button id="ct" class="grow">Uppgift</button><button id="ci" class="sec grow">Parkera idé</button><button id="cc" class="sec grow">Fråga coach</button></div>
    <label class="row" style="color:var(--ink)"><input type="checkbox" id="td" style="width:auto"> Gör det idag</label>`, (s) => {
    const cap = $("#cap", s); cap.focus();
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) $("#mic", s).classList.add("hidden");
    $("#mic", s).onclick = () => { const r = new SR(); r.lang = "sv-SE"; r.interimResults = true; $("#micst", s).textContent = "Lyssnar…"; r.onresult = (e) => { cap.value = [...e.results].map((x) => x[0].transcript).join(" "); }; r.onend = () => $("#micst", s).textContent = ""; r.start(); };
    $("#ct", s).onclick = async () => { const v = cap.value.trim(); if (!v) return; const td = $("#td", s).checked; await q(sb.from("tasks").insert({ title: v, status: td ? "planerad" : "inkorg", scheduled_for: td ? today() : null })); closeSheet(); toast("Tillagd ✓"); route(); };
    $("#ci", s).onclick = async () => { const v = cap.value.trim(); if (!v) return; await q(sb.from("ideas").insert({ text: v })); closeSheet(); toast("Parkerad. Den finns kvar när det är dags."); };
    $("#cc", s).onclick = () => { const v = cap.value.trim(); closeSheet(); sessionStorage.setItem("coach_q", v); location.hash = "#coach"; };
  });
};

// ---------- COACH ----------
async function coachView() {
  const msgs = await q(sb.from("coach_messages").select("*").order("created_at", { ascending: false }).limit(30));
  msgs.reverse();
  view.innerHTML = `<h1>Coach</h1>
    <div id="chat">${msgs.length ? msgs.map((m) => `<div class="bubble ${m.role === "user" ? "u" : "a"}">${esc(m.content)}</div>`).join("") : `<div class="pep">Hej Calle! Fastnat, för mycket på en gång, eller vill du bara prata igenom dagen? Skriv till mig. Jag kan också lägga in uppgifter, påminnelser och parkera idéer åt dig.</div>`}</div>
    <div class="row wrap small" style="margin:8px 0">${["Jag kommer inte igång", "Vad ska jag göra nu?", "Jag har fått en ny idé", "Hjälp mig prioritera"].map((x) => `<button class="sec" data-q="${x}" style="padding:8px 10px;min-height:0">${x}</button>`).join("")}</div>
    <div class="row"><textarea id="msg" placeholder="Skriv…" style="min-height:52px"></textarea><button id="snd">➤</button></div>`;
  const send = async (txt) => {
    txt = (txt ?? $("#msg").value).trim(); if (!txt) return;
    $("#msg").value = "";
    $("#chat").insertAdjacentHTML("beforeend", `<div class="bubble u">${esc(txt)}</div><div class="bubble a" id="wait">…</div>`);
    window.scrollTo(0, document.body.scrollHeight);
    try {
      const r = await coach("chat", { message: txt });
      $("#wait").outerHTML = `<div class="bubble a">${esc(r.reply)}${r.actions?.length ? `<div class="small muted" style="margin-top:6px">${r.actions.map((a) => "✓ " + esc(a)).join("<br>")}</div>` : ""}</div>`;
    } catch (e) { $("#wait").outerHTML = `<div class="bubble a">Kunde inte nå coachen: ${esc(e.message)}</div>`; }
    window.scrollTo(0, document.body.scrollHeight);
  };
  $("#snd").onclick = () => send();
  view.querySelectorAll("[data-q]").forEach((b) => b.onclick = () => send(b.dataset.q));
  const pre = sessionStorage.getItem("coach_q"); if (pre) { sessionStorage.removeItem("coach_q"); send(pre); }
  window.scrollTo(0, document.body.scrollHeight);
}

// ---------- VECKA ----------
async function vecka() {
  const wp = (await q(sb.from("week_plans").select("*").order("week_start", { ascending: false }).limit(1)))[0];
  const p = wp?.plan || {};
  view.innerHTML = `<h1>Veckan</h1>
  ${wp ? `<div class="small muted">Vecka från ${wp.week_start} ${wp.approved ? "· ✓ godkänd" : "· utkast"}</div>
    <div class="pep">${esc(wp.message)}</div>
    ${(p.last_week || []).length ? `<h2>🎉 Klart förra veckan</h2><div class="card">${p.last_week.map((x) => "✓ " + esc(x)).join("<br>")}</div>` : ""}
    <h2>Veckans fokus</h2>${(p.focus || []).map((f, i) => `<div class="card"><div class="title">${i + 1}. ${esc(f.title)}</div><div class="step">${esc(f.why || "")}</div>${f.done_when ? `<div class="small" style="margin-top:4px">Klart när: ${esc(f.done_when)}</div>` : ""}</div>`).join("")}
    ${(p.almost_done || []).length ? `<h2>Nästan klart, ta i mål</h2><div class="card">${p.almost_done.map(esc).join("<br>")}</div>` : ""}
    ${(p.pause_suggestions || []).length ? `<h2>Förslag att pausa</h2><div class="card">${p.pause_suggestions.map(esc).join("<br>")}</div>` : ""}
    <h2>Dag för dag</h2>${(p.days || []).map((d) => `<div class="card"><div class="title">${new Date(d.date + "T12:00").toLocaleDateString("sv-SE", { weekday: "long", day: "numeric", month: "short" })}</div><div class="step">${(d.items || []).map(esc).join("<br>")}</div></div>`).join("")}
    ${(p.questions || []).length ? `<h2>Frågor till dig</h2><div class="card">${p.questions.map(esc).join("<br>")}</div>` : ""}
    ${wp.approved ? "" : `<label>Vill du ändra något?</label><textarea id="ch" placeholder="Till exempel: torsdag är jag borta, flytta fokus på bokföringen till måndag"></textarea>
    <div class="row" style="margin-top:8px"><button id="ap" class="grow">✓ Godkänn veckan</button><button id="cg" class="sec">Ändra</button></div>`}` : `<div class="card"><p>Ingen veckoplan än. Varje söndag 10:00 gör jag ett utkast och skickar en notis.</p></div>`}
  <button id="nw" class="sec big" style="margin-top:16px">Gör veckoplan nu</button>`;
  const nw = $("#nw"); nw.onclick = async () => { busy(nw, true, "Planerar veckan…"); try { await coach("plan_week"); route(); } catch (e) { toast(e.message, 5000); busy(nw, false); } };
  const ap = $("#ap"); if (ap) ap.onclick = async () => { busy(ap, true); await coach("approve_week", { id: wp.id, approve: true }); celebrate("🗓️"); toast("Veckan är satt. En dag i taget."); route(); };
  const cg = $("#cg"); if (cg) cg.onclick = async () => { busy(cg, true, "Ändrar…"); try { await coach("approve_week", { id: wp.id, change: $("#ch").value }); route(); } catch (e) { toast(e.message, 5000); busy(cg, false); } };
}

// ---------- MER ----------
async function mer() {
  view.innerHTML = `<h1>Mer</h1><div class="card list" style="padding:0">
    ${[["uppgifter", "📋 Alla uppgifter"], ["projekt", "📁 Projekt"], ["parkering", "🅿️ Parkerade idéer"], ["kvall", "🌙 Kvällsavstämning"], ["klart", "🏆 Klartlogg"], ["rutiner", "🔁 Rutiner"], ["monster", "🧭 Mönster och insikter"], ["installningar", "⚙️ Inställningar och notiser"]].map(([h, t]) => `<a href="#${h}">${t}<span>›</span></a>`).join("")}
  </div>`;
}

async function uppgifter() {
  const all = await q(sb.from("tasks").select("*").in("status", ["inkorg", "planerad", "pagar"]).order("priority").order("created_at"));
  const groups = { pagar: "Pågår", planerad: "Planerat", inkorg: "Inkorg" };
  view.innerHTML = `<h1>Uppgifter</h1>
    <div class="row"><input id="nt" placeholder="Ny uppgift…"><button id="ad">+</button></div>
    ${Object.entries(groups).map(([k, n]) => { const l = all.filter((t) => t.status === k); return l.length ? `<h2>${n} (${l.length})</h2>${l.map(taskCard).join("")}` : ""; }).join("") || `<p class="muted center">Tomt. Skönt!</p>`}
    ${all.length > 3 ? `<button id="pri" class="sec big" style="margin-top:12px">🧭 Hjälp mig prioritera</button>` : ""}`;
  bindTaskCards();
  $("#ad").onclick = async () => { const v = $("#nt").value.trim(); if (!v) return; await q(sb.from("tasks").insert({ title: v })); route(); };
  const pri = $("#pri"); if (pri) pri.onclick = () => { sessionStorage.setItem("coach_q", "Hjälp mig prioritera mina uppgifter. Välj dagens tre och säg vad som får vänta."); location.hash = "#coach"; };
}

async function projekt() {
  const ps = await q(sb.from("projects").select("*").order("updated_at", { ascending: false }));
  const active = ps.filter((p) => p.status === "aktiv");
  const max = settings?.max_active_projects ?? 3;
  const st = { aktiv: "Aktiva", pausad: "Pausade", parkerad: "Parkerade", klar: "Klara", nedlagd: "Nedlagda" };
  view.innerHTML = `<h1>Projekt</h1>
    <div class="pep">${active.length}/${max} aktiva ${active.length >= max ? "· taket är nått, avsluta eller pausa något innan du startar nytt" : "· plats för " + (max - active.length) + " till"}</div>
    <div class="row"><input id="np" placeholder="Nytt projekt…"><button id="ad">+</button></div>
    ${Object.entries(st).map(([k, n]) => { const l = ps.filter((p) => p.status === k); return l.length ? `<h2>${n}</h2>${l.map((p) => `<div class="card" data-p="${p.id}"><div class="row between"><div class="title">${esc(p.name)}</div>${p.progress >= 80 && k === "aktiv" ? `<span class="tag warn">nästan klart!</span>` : ""}</div>
      <div class="bar" style="margin:8px 0"><i style="width:${p.progress}%"></i></div>
      <div class="small muted">${p.next_step ? "Nästa: " + esc(p.next_step) : "Inget nästa steg"}${p.done_definition ? " · Klart när: " + esc(p.done_definition) : ""}</div></div>`).join("")}` : ""; }).join("")}`;
  $("#ad").onclick = async () => { const v = $("#np").value.trim(); if (!v) return; const status = active.length < max ? "aktiv" : "parkerad"; await q(sb.from("projects").insert({ name: v, status })); toast(status === "aktiv" ? "Projektet är aktivt" : `Parkerat, du har redan ${max} aktiva`); route(); };
  view.querySelectorAll("[data-p]").forEach((c) => c.onclick = () => projMenu(ps.find((p) => p.id === c.dataset.p), active.length, max));
}
function projMenu(p, nActive, max) {
  sheet(`<h2 style="margin-top:0">${esc(p.name)}</h2>
    <label>Klart när…</label><input id="dd" value="${esc(p.done_definition)}">
    <label>Nästa steg</label><input id="ns" value="${esc(p.next_step)}">
    <label>Hur långt har du kommit? <b id="pv">${p.progress}%</b></label><input id="pg" type="range" min="0" max="100" step="5" value="${p.progress}">
    <label>Deadline</label><input id="dl" type="date" value="${p.deadline || ""}">
    <label>Anteckningar</label><textarea id="no">${esc(p.notes)}</textarea>
    <button id="sv" class="big" style="margin-top:12px">Spara</button>
    <h2>Medvetet beslut</h2>
    <div class="row wrap">${p.status !== "aktiv" ? `<button class="sec" data-s="aktiv">Aktivera</button>` : ""}<button class="sec" data-s="klar">🏁 Klart</button><button class="sec" data-s="pausad">Pausa</button><button class="sec" data-s="parkerad">Parkera</button><button class="danger" data-s="nedlagd">Lägg ned</button></div>`, (s) => {
    $("#pg", s).oninput = (e) => $("#pv", s).textContent = e.target.value + "%";
    $("#sv", s).onclick = async () => { await q(sb.from("projects").update({ done_definition: $("#dd", s).value, next_step: $("#ns", s).value, progress: +$("#pg", s).value, deadline: $("#dl", s).value || null, notes: $("#no", s).value, updated_at: new Date().toISOString() }).eq("id", p.id)); closeSheet(); route(); };
    s.querySelectorAll("[data-s]").forEach((b) => b.onclick = async () => {
      const ns = b.dataset.s;
      if (ns === "aktiv" && nActive >= max) return toast(`Du har redan ${max} aktiva. Pausa eller avsluta ett först.`, 4000);
      await q(sb.from("projects").update({ status: ns, closed_at: ["klar", "nedlagd"].includes(ns) ? new Date().toISOString() : null, progress: ns === "klar" ? 100 : p.progress, updated_at: new Date().toISOString() }).eq("id", p.id));
      closeSheet();
      if (ns === "klar") { celebrate("🏁"); toast("Projekt i mål! Det här är stort."); }
      else if (ns === "nedlagd") toast("Att lägga ned medvetet är också att avsluta. Bra beslut.");
      route();
    });
  });
}

async function parkering() {
  const ids = await q(sb.from("ideas").select("*").eq("status", "parkerad").order("created_at", { ascending: false }));
  view.innerHTML = `<h1>Parkerade idéer</h1><p class="muted small">Här ligger idéer tryggt tills det är dags. Gå igenom dem på söndagens veckoplanering.</p>
    <div class="row"><input id="ni" placeholder="Ny idé…"><button id="ad">+</button></div>
    ${ids.map((i) => `<div class="card"><div>${esc(i.text)}</div><div class="small muted">${new Date(i.created_at).toLocaleDateString("sv-SE")}</div>
    <div class="row" style="margin-top:8px"><button class="sec" data-t="${i.id}">→ Uppgift</button><button class="sec" data-pr="${i.id}">→ Projekt</button><button class="danger" data-x="${i.id}">Släng</button></div></div>`).join("") || `<p class="center muted">Inga parkerade idéer.</p>`}`;
  $("#ad").onclick = async () => { const v = $("#ni").value.trim(); if (!v) return; await q(sb.from("ideas").insert({ text: v })); route(); };
  view.querySelectorAll("[data-t]").forEach((b) => b.onclick = async () => { const i = ids.find((x) => x.id === b.dataset.t); await q(sb.from("tasks").insert({ title: i.text })); await q(sb.from("ideas").update({ status: "omvandlad" }).eq("id", i.id)); toast("Nu är det en uppgift"); route(); });
  view.querySelectorAll("[data-pr]").forEach((b) => b.onclick = async () => { const i = ids.find((x) => x.id === b.dataset.pr); const n = (await q(sb.from("projects").select("id").eq("status", "aktiv"))).length; const max = settings?.max_active_projects ?? 3; await q(sb.from("projects").insert({ name: i.text, status: n < max ? "aktiv" : "parkerad" })); await q(sb.from("ideas").update({ status: "omvandlad" }).eq("id", i.id)); toast(n < max ? "Nytt aktivt projekt" : "Blev ett parkerat projekt, taket är nått"); route(); });
  view.querySelectorAll("[data-x]").forEach((b) => b.onclick = async () => { await q(sb.from("ideas").update({ status: "slangd" }).eq("id", b.dataset.x)); route(); });
}

async function kvall() {
  const d = today();
  const [r, done] = await Promise.all([q(sb.from("reflections").select("*").eq("date", d).maybeSingle()), q(sb.from("tasks").select("title").eq("status", "klar").gte("completed_at", d + "T00:00:00"))]);
  view.innerHTML = `<h1>Kvällsavstämning</h1>
    <div class="card"><b>Klart idag (${done.length})</b><div class="step">${done.map((t) => "✓ " + esc(t.title)).join("<br>") || "Inget avbockat, och det är okej. Vad hände i stället?"}</div></div>
    ${r?.coach_reply ? `<div class="pep">${esc(r.coach_reply)}</div>` : ""}
    <label>Vad gick bra?</label><textarea id="wg">${esc(r?.went_well || "")}</textarea>
    <label>Vad var svårt?</label><textarea id="hd">${esc(r?.hard || "")}</textarea>
    <label>Energi</label><div class="row stars" id="en">${[1, 2, 3, 4, 5].map((n) => `<button data-v="${n}" class="${r?.energy === n ? "on" : ""}">${n}</button>`).join("")}</div>
    <label>Fokus</label><div class="row stars" id="fo">${[1, 2, 3, 4, 5].map((n) => `<button data-v="${n}" class="${r?.focus === n ? "on" : ""}">${n}</button>`).join("")}</div>
    <button id="sv" class="big" style="margin-top:16px">Runda av dagen</button>`;
  let en = r?.energy, fo = r?.focus;
  const pick = (id, set) => $(id).querySelectorAll("button").forEach((b) => b.onclick = () => { set(+b.dataset.v); $(id).querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b)); });
  pick("#en", (v) => en = v); pick("#fo", (v) => fo = v);
  $("#sv").onclick = async (e) => { busy(e.target, true); try { await coach("reflect", { went_well: $("#wg").value, hard: $("#hd").value, energy: en, focus: fo }); celebrate("🌙"); route(); } catch (er) { toast(er.message, 5000); busy(e.target, false); } };
}

async function klart() {
  const [ts, ps, ss] = await Promise.all([
    q(sb.from("tasks").select("title,completed_at,actual_min").eq("status", "klar").order("completed_at", { ascending: false }).limit(200)),
    q(sb.from("projects").select("name,closed_at").eq("status", "klar").order("closed_at", { ascending: false })),
    q(sb.from("focus_sessions").select("planned_min,completed,started_at").gte("started_at", addDays(today(), -7))),
  ]);
  const byDay = {}; ts.forEach((t) => { const d = new Date(t.completed_at).toLocaleDateString("sv-SE", { timeZone: "Europe/Stockholm" }); (byDay[d] ||= []).push(t); });
  let streak = 0; for (let d = today(); byDay[d]; d = addDays(d, -1)) streak++;
  const focusMin = ss.filter((s) => s.completed).reduce((a, s) => a + s.planned_min, 0);
  view.innerHTML = `<h1>Klartlogg 🏆</h1>
    <div class="row"><div class="card grow center" style="padding:12px"><b style="font-size:28px">${ts.length}</b><div class="small muted">klara totalt</div></div>
    <div class="card grow center" style="padding:12px"><b style="font-size:28px">${streak}</b><div class="small muted">dagar i rad</div></div>
    <div class="card grow center" style="padding:12px"><b style="font-size:28px">${Math.round(focusMin / 60 * 10) / 10}</b><div class="small muted">fokustimmar, 7 dgr</div></div></div>
    ${ps.length ? `<h2>🏁 Avslutade projekt</h2><div class="card">${ps.map((p) => `${esc(p.name)} <span class="small muted">${(p.closed_at || "").slice(0, 10)}</span>`).join("<br>")}</div>` : ""}
    ${Object.entries(byDay).map(([d, l]) => `<h2>${new Date(d + "T12:00").toLocaleDateString("sv-SE", { weekday: "long", day: "numeric", month: "short" })} <span class="tag">${l.length}</span></h2><div class="card">${l.map((t) => "✓ " + esc(t.title)).join("<br>")}</div>`).join("") || `<p class="center muted">Här samlas allt du gör klart.</p>`}`;
}

async function rutiner() {
  const rs = await q(sb.from("routines").select("*").order("next_due"));
  const fn = { dag: "Varje dag", vecka: "Varje vecka", manad: "Varje månad", ar: "Varje år" };
  view.innerHTML = `<h1>Rutiner</h1><p class="small muted">Återkommande saker får en notis 07:30 den dag de ska göras.</p>
    ${rs.map((r) => `<div class="card" data-r="${r.id}"><div class="row between"><div class="title">${esc(r.title)}</div><span class="tag ${r.next_due && r.next_due <= today() ? "warn" : ""}">${r.next_due || "?"}</span></div><div class="small muted">${fn[r.freq]}${r.day_of_month ? ", den " + r.day_of_month + ":e" : ""}</div>
    ${(r.checklist || []).map((c, i) => `<label class="row" style="color:var(--ink);font-size:15px;margin:4px 0"><input type="checkbox" style="width:auto"> ${esc(c)}</label>`).join("")}
    <div class="row" style="margin-top:6px"><button class="ghost" data-e="${r.id}">Ändra</button><button class="danger" data-x="${r.id}">Ta bort</button></div></div>`).join("")}
    <button id="nr" class="big" style="margin-top:12px">+ Ny rutin</button>`;
  $("#nr").onclick = () => routineSheet();
  view.querySelectorAll("[data-e]").forEach((b) => b.onclick = () => routineSheet(rs.find((r) => r.id === b.dataset.e)));
  view.querySelectorAll("[data-x]").forEach((b) => b.onclick = async () => { if (confirm("Ta bort rutinen?")) { await q(sb.from("routines").delete().eq("id", b.dataset.x)); route(); } });
}
function routineSheet(r = {}) {
  sheet(`<h2 style="margin-top:0">${r.id ? "Ändra rutin" : "Ny rutin"}</h2>
    <label>Namn</label><input id="ti" value="${esc(r.title || "")}" placeholder="Till exempel: Skicka underlag till Ludvig">
    <div class="row"><div class="grow"><label>Hur ofta</label><select id="fr">${[["dag", "Varje dag"], ["vecka", "Varje vecka"], ["manad", "Varje månad"], ["ar", "Varje år"]].map(([v, t]) => `<option value="${v}" ${r.freq === v ? "selected" : ""}>${t}</option>`).join("")}</select></div>
    <div class="grow"><label>Dag i månaden</label><input id="dm" type="number" min="1" max="28" value="${r.day_of_month || ""}"></div></div>
    <label>Nästa gång</label><input id="nd" type="date" value="${r.next_due || today()}">
    <label>Checklista (en rad per punkt)</label><textarea id="cl">${esc((r.checklist || []).join("\n"))}</textarea>
    <button id="sv" class="big" style="margin-top:12px">Spara</button>`, (s) => {
    $("#sv", s).onclick = async () => {
      const row = { title: $("#ti", s).value, freq: $("#fr", s).value, day_of_month: +$("#dm", s).value || null, next_due: $("#nd", s).value, checklist: $("#cl", s).value.split("\n").map((x) => x.trim()).filter(Boolean) };
      if (!row.title) return;
      await q(r.id ? sb.from("routines").update(row).eq("id", r.id) : sb.from("routines").insert(row));
      closeSheet(); route();
    };
  });
}

async function monster() {
  const is = await q(sb.from("insights").select("*").order("created_at", { ascending: false }));
  const ss = await q(sb.from("focus_sessions").select("started_at,completed,planned_min").order("started_at", { ascending: false }).limit(300));
  const byHour = {}; ss.filter((s) => s.completed).forEach((s) => { const h = +new Date(s.started_at).toLocaleTimeString("sv-SE", { timeZone: "Europe/Stockholm", hour: "2-digit" }); byHour[h] = (byHour[h] || 0) + s.planned_min; });
  const maxv = Math.max(1, ...Object.values(byHour));
  view.innerHTML = `<h1>Mönster</h1>
    <h2>När du fokuserar bäst</h2><div class="card">${Object.keys(byHour).length ? Array.from({ length: 16 }, (_, i) => i + 6).map((h) => `<div class="row small"><span style="width:40px">${h}:00</span><div class="bar grow"><i style="width:${(byHour[h] || 0) / maxv * 100}%"></i></div></div>`).join("") : "Kör några fokuspass så syns det här."}</div>
    <h2>Insikter</h2>${is.map((i) => `<div class="card">${esc(i.text)}<div class="small muted">${new Date(i.created_at).toLocaleDateString("sv-SE")}</div></div>`).join("") || `<p class="muted">Coachen sparar insikter från kvällsavstämningar och samtal här.</p>`}`;
}

async function installningar() {
  const s = settings;
  const perm = "Notification" in window ? Notification.permission : "saknas";
  view.innerHTML = `<h1>Inställningar</h1>
    <div class="card"><b>Notiser</b><p class="small muted">Status: ${perm === "granted" ? "på ✓" : perm === "denied" ? "blockerade i webbläsaren" : "inte påslagna"}</p>
    <div class="row"><button id="pu" class="grow">Slå på notiser</button><button id="tp" class="sec">Testa</button></div>
    <p class="small muted">Tips: installera appen först (menyn i Chrome, Lägg till på startskärmen). Ställ in notiskategorin som "Pop up" i Androids appinställningar för att få dem över skärmen.</p></div>
    <div class="card">
      <label>Dagsplan (vardagar)</label><input id="dp" type="time" value="${(s.day_plan_time || "06:45").slice(0, 5)}">
      <label class="row" style="color:var(--ink)"><input id="we" type="checkbox" style="width:auto" ${s.day_plan_weekends ? "checked" : ""}> Dagsplan även på helger</label>
      <label>Veckoplanering (söndagar)</label><input id="wp" type="time" value="${(s.week_plan_time || "10:00").slice(0, 5)}">
      <label>Kvällsavstämning</label><input id="ev" type="time" value="${(s.evening_time || "20:30").slice(0, 5)}">
      <label>Max aktiva projekt</label><input id="mx" type="number" min="1" max="10" value="${s.max_active_projects}">
      <label>När ger medicinen bäst fokus?</label><input id="fw" value="${esc(s.focus_window || "")}" placeholder="Till exempel 08 till 12">
      <label>Om mig (det coachen ska veta)</label><textarea id="am" placeholder="Till exempel: morgnar går till djuren, eftermiddagar är energin låg…">${esc(s.about_me || "")}</textarea>
      <button id="sv" class="big" style="margin-top:12px">Spara</button></div>
    <button id="lo" class="danger">Logga ut</button>`;
  $("#pu").onclick = enablePush;
  $("#tp").onclick = async (e) => { busy(e.target, true, "Skickar…"); try { const r = await coach("test_push"); toast(r.sent ? "Skickad, kolla mobilen" : "Ingen enhet registrerad, slå på notiser först"); } catch (er) { toast(er.message, 5000); } busy(e.target, false); };
  $("#sv").onclick = async () => {
    settings = await q(sb.from("settings").update({ day_plan_time: $("#dp").value, day_plan_weekends: $("#we").checked, week_plan_time: $("#wp").value, evening_time: $("#ev").value, max_active_projects: +$("#mx").value || 3, focus_window: $("#fw").value, about_me: $("#am").value, updated_at: new Date().toISOString() }).eq("user_id", user.id).select().single());
    toast("Sparat ✓");
  };
  $("#lo").onclick = async () => { await sb.auth.signOut(); };
}

// ---------- Push ----------
function b64ToU8(b) { const p = "=".repeat((4 - (b.length % 4)) % 4); const r = atob((b + p).replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from([...r].map((c) => c.charCodeAt(0))); }
async function enablePush() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return toast("Den här webbläsaren stöder inte notiser. Installera appen i Chrome.", 5000);
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return toast("Notiser nekades. Ändra i webbläsarens inställningar.", 5000);
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(VAPID) });
  const j = sub.toJSON();
  await q(sb.from("push_subscriptions").upsert({ endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth }, { onConflict: "endpoint" }));
  toast("Notiser påslagna ✓");
  route();
}

// ---------- Start ----------
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");
navigator.serviceWorker?.addEventListener("message", (e) => { if (e.data?.url) location.hash = e.data.url.replace(/^\/?/, "").replace(/^#?/, "#"); });
sb.auth.onAuthStateChange(async (_ev, session) => {
  const was = user?.id;
  user = session?.user || null;
  if (user && was !== user.id) {
    await loadSettings();
    $("#nav").classList.remove("hidden"); $("#fab").classList.remove("hidden");
    route();
  } else if (!user) route();
});
