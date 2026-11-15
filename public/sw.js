/*
 * Ready's service worker (M7-06). Only two jobs:
 * 1. Show a push notification sent by src/server/push/send.ts.
 * 2. On tap, focus an open Ready window on the notification's page, or open one.
 *
 * No offline caching on purpose (ticket Cut): there is no fetch handler, so
 * every request goes to the network exactly as without this worker.
 *
 * Payload: JSON { title, body, url }, where url is a path in this app.
 */
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

/** A path in this app, or "/" for anything else. */
function samePath(url) {
  try {
    const target = new URL(typeof url === "string" ? url : "/", self.location.origin);
    if (target.origin !== self.location.origin) return "/";
    return target.pathname + target.search + target.hash;
  } catch {
    return "/";
  }
}

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }
  const title = typeof data.title === "string" && data.title ? data.title : "Ready";
  const options = {
    body: typeof data.body === "string" ? data.body : "",
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    data: { url: samePath(data.url) },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const path = samePath(event.notification.data && event.notification.data.url);
  const target = new URL(path, self.location.origin).href;

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windows) {
        if (new URL(client.url).origin !== self.location.origin) continue;
        if (client.url === target) return client.focus();
      }
      // An open Ready window: bring it forward on the right page.
      const open = windows.find((c) => new URL(c.url).origin === self.location.origin);
      // navigate() works only on pages this worker controls; otherwise open a new one.
      if (open && "navigate" in open) {
        try {
          const focused = await open.focus();
          const moved = await (focused || open).navigate(target);
          if (moved) return moved;
        } catch {
          // fall through
        }
      }
      return self.clients.openWindow(target);
    })(),
  );
});
