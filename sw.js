// 서비스 워커: 앱 설치, 오프라인 화면, 푸시 알림
const VERSION = "v1";
const SHELL = "shell-" + VERSION;
const API = "api-" + VERSION;
const API_MAX = 60;
const SHELL_FILES = ["/", "/manifest.webmanifest", "/icons/icon.svg", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/apple-touch-icon.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== API).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function trim(cache) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - API_MAX; i++) await cache.delete(keys[i]);
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  // 화면: 최신을 먼저 받고, 인터넷이 안 되면 저장해 둔 화면
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req)
        .then((r) => {
          if (r.ok) {
            const copy = r.clone();
            caches.open(SHELL).then((c) => c.put("/", copy));
          }
          return r;
        })
        .catch(() => caches.match("/"))
    );
    return;
  }
  // 공연 목록·상세: 최신을 먼저 받고, 인터넷이 안 되면 마지막으로 받은 결과
  if (url.pathname === "/api/shows" || url.pathname === "/api/detail") {
    e.respondWith(
      fetch(req)
        .then((r) => {
          if (r.ok) {
            const copy = r.clone();
            caches.open(API).then((c) => c.put(req, copy).then(() => trim(c)));
          }
          return r;
        })
        .catch(() => caches.match(req).then((r) => r || Response.error()))
    );
    return;
  }
  if (url.pathname.startsWith("/api/")) return;
  // 아이콘 등: 저장해 둔 것을 먼저 쓰고 뒤에서 새로 받기
  e.respondWith(
    caches.match(req).then((hit) => {
      const net = fetch(req)
        .then((r) => {
          if (r.ok) {
            const copy = r.clone();
            caches.open(SHELL).then((c) => c.put(req, copy));
          }
          return r;
        })
        .catch(() => hit);
      return hit || net;
    })
  );
});

self.addEventListener("push", (e) => {
  let d = {};
  try {
    d = e.data ? e.data.json() : {};
  } catch (err) {
    d = { body: e.data ? e.data.text() : "" };
  }
  e.waitUntil(
    self.registration.showNotification(d.title || "공연 모아보기", {
      body: d.body || "",
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      tag: d.tag,
      data: { url: d.url || "/" },
    })
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const target = new URL((e.notification.data && e.notification.data.url) || "/", location.origin).href;
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (new URL(c.url).origin === location.origin && "navigate" in c) {
          return c.navigate(target).then((w) => (w || c).focus());
        }
      }
      return self.clients.openWindow(target);
    })
  );
});
