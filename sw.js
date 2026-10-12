const CACHE = "meal-stick-v30";
const ASSETS = [
  "./",
  "./index.html",
  "./app.css",
  "./app.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
];
self.addEventListener("install", (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) =>
        Promise.all(
          ASSETS.map((a) =>
            fetch(a, { cache: "no-store" })
              .then((r) => c.put(a, r))
              .catch(() => {})
          )
        )
      )
      .then(() => self.skipWaiting())
  );
});
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener("message", (e) => {
  if (e.data === "skipWaiting") self.skipWaiting();
});
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  // network first, bypassing the browser HTTP cache (GitHub Pages sends max-age=600); cache is the offline fallback
  e.respondWith(
    fetch(e.request, { cache: "no-store" })
      .then((r) => {
        if (r.ok) {
          const c = r.clone();
          caches.open(CACHE).then((cc) => cc.put(e.request, c));
        }
        return r;
      })
      .catch(() =>
        caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match("./index.html"))
      )
  );
});

// ---- Web Push (sent by the Firebase function)
self.addEventListener("push", (e) => {
  let d = {};
  try {
    d = e.data ? e.data.json() : {};
  } catch {
    d = { notification: { title: "Їжа та стіки", body: e.data ? e.data.text() : "" } };
  }
  const n = d.notification || {},
    data = d.data || {};
  const title = n.title || data.title || "Їжа та стіки";
  const opts = {
    body: n.body || data.body || "",
    icon: n.icon || "./icons/icon-192.png",
    badge: n.badge || "./icons/icon-192.png",
    tag: n.tag || "mst-" + (data.kind || "x"),
    renotify: true,
    data: { url: (d.fcmOptions && d.fcmOptions.link) || self.registration.scope, kind: data.kind || "" },
  };
  e.waitUntil(self.registration.showNotification(title, opts));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || self.registration.scope;
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((cs) => {
      for (const c of cs) {
        if ("focus" in c) return c.focus();
      }
      return self.clients.openWindow(url);
    })
  );
});
