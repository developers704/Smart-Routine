const CACHE = "routine-v16";
const PRECACHE = [
  "/",
  "/index.html",
  "/styles.css",
  "/app.js",
  "/alarms.js",
  "/native.js",
  "/install.js",
  "/push.js",
  "/routine-alarms.js",
  "/copy.js",
  "/map-tab.js",
  "/manifest.webmanifest",
  "/icons/icon.svg",
  "/icons/icon-180.png",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/shared/alarm-plan.js",
  "/shared/defaults.js",
  "/shared/time.js",
  "/shared/tz.js",
  "/shared/scheduler.js",
  "/shared/travel.js",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith("/api/")) return;
  const isCode = /\.(js|css|webmanifest)$/.test(url.pathname) || url.pathname.startsWith("/shared/");
  if (isCode) {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match("/")))
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(self.clients.openWindow("/"));
});

self.addEventListener("push", (e) => {
  let data = { title: "Smart Routine", body: "" };
  try {
    data = { ...data, ...e.data?.json() };
  } catch {
    data.body = e.data?.text() || "";
  }
  e.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      tag: data.tag || "routine-alarm",
    })
  );
});
