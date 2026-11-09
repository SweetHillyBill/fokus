const CACHE = "fokus-v8";
const SHELL = ["./", "index.html", "app.js", "style.css", "manifest.json", "icon-192.png", "icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
// Nätet först för appens egna filer, cache som reserv
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin) return;
  e.respondWith(fetch(e.request.url, { cache: "no-cache", credentials: "same-origin" }).then((r) => { const c = r.clone(); caches.open(CACHE).then((ca) => ca.put(e.request, c)); return r; }).catch(() => caches.match(e.request, { ignoreSearch: true }).then((m) => m || caches.match("index.html"))));
});

self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data.json(); } catch { d = { title: "Fokus", body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "Fokus", {
    body: d.body || "",
    icon: "icon-192.png",
    badge: "icon-192.png",
    tag: d.tag || undefined,
    renotify: true,
    requireInteraction: true,
    vibrate: [200, 100, 200],
    data: { url: d.url || "/" },
    actions: d.actions || [],
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  let url = (e.notification.data && e.notification.data.url) || "/";
  if (e.action === "start") url = "/#idag?start=1";
  const full = new URL(url.replace(/^\//, ""), self.registration.scope).href;
  e.waitUntil((async () => {
    const all = await clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) {
      if ("focus" in c) { await c.focus(); c.postMessage({ url: url.replace(/^\//, "") }); return; }
    }
    await clients.openWindow(full);
  })());
});
