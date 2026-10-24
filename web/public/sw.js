// Tin Hat Web does not use a service worker. The Element fork that used to live at this origin registered
// /sw.js (it rewrote /_matrix/media/v3 requests). Browsers keep that worker until the script at /sw.js
// changes, so this file replaces it with a worker that removes itself and reloads its pages once.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      await self.registration.unregister();
      const pages = await self.clients.matchAll({ type: "window" });
      for (const page of pages) page.navigate(page.url);
    })(),
  );
});
