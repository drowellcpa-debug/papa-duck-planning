// Duck Check service worker: catches a screenshot shared from the Android share menu, keeps it, and opens the app.
const CACHE = "duck-share";
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method === "POST" && u.pathname === "/share") {
    e.respondWith((async () => {
      const f = await e.request.formData();
      const c = await caches.open(CACHE);
      await c.delete("/shared-image"); await c.delete("/shared-text");
      const img = f.get("image");
      if (img && img.size) await c.put("/shared-image", new Response(img, { headers: { "Content-Type": img.type || "image/jpeg" } }));
      const txt = [f.get("title"), f.get("text"), f.get("url")].filter(Boolean).join(" ");
      if (txt) await c.put("/shared-text", new Response(txt));
      return Response.redirect("/?shared=1", 303);
    })());
  }
});
