/* Service worker : rend l'appli installable et garde l'interface disponible sans réseau.
   Les données DVF passent par le réseau en priorité (pour être toujours à jour) ; les zones
   déjà consultées restent en mémoire et permettent de refaire une estimation hors ligne. */
const VERSION = "v3";
const COQUILLE = ["./", "index.html", "estimation.js", "nuisances.js", "manifest.webmanifest", "icones/icone.svg", "icones/icone-192.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open("coquille-" + VERSION).then(c => c.addAll(COQUILLE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(cles => Promise.all(cles.filter(k => !k.endsWith(VERSION)).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

async function reseauDabord(req, cache) {
  try {
    const rep = await fetch(req);
    if (rep.ok) (await caches.open(cache)).put(req, rep.clone());
    return rep;
  } catch (err) {
    const enCache = await caches.match(req, {ignoreSearch: req.mode === "navigate"});
    if (enCache) return enCache;
    throw err;
  }
}

async function cacheDabord(req) {
  const enCache = await caches.match(req);
  const maj = fetch(req).then(async rep => {
    if (rep.ok || rep.type === "opaque") (await caches.open("statique-" + VERSION)).put(req, rep.clone());
    return rep;
  }).catch(() => enCache);
  return enCache || maj;
}

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    if (req.mode === "navigate") e.respondWith(reseauDabord(req, "coquille-" + VERSION));
    else if (url.pathname.includes("/data/")) e.respondWith(reseauDabord(req, "donnees-" + VERSION));
    else e.respondWith(cacheDabord(req));
  } else if (/unpkg\.com|fonts\.(googleapis|gstatic)\.com/.test(url.host)) {
    e.respondWith(cacheDabord(req));
  }
  // Géocodage IGN et fonds de carte : toujours le réseau, sans mise en cache
});
