/* Nuisances autour d'une adresse, d'après OpenStreetMap (API Overpass).
   Simple avertissement affiché à côté de l'estimation : n'intervient PAS dans le calcul du prix
   (estimation.js n'en dépend pas, et l'appli d'annonces qui réutilise estimation.js n'est pas concernée).
   Fonctions pures + une fonction réseau : utilisable dans le navigateur (window.Nuisances) et sous Node (tests). */
(function (racine) {
  "use strict";

  const SERVEURS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];

  /* Chaque catégorie : ce qu'on cherche, jusqu'où, et à partir de quelle distance c'est « collé » ou « proche ». */
  const CATEGORIES = [
    { id: "autoroute", nom: "Autoroute", rayon: 600, colle: 150, proche: 350,
      filtre: '["highway"~"^(motorway|motorway_link)$"]' },
    { id: "voie-rapide", nom: "Voie rapide", rayon: 400, colle: 100, proche: 250,
      filtre: '["highway"~"^(trunk|trunk_link)$"]' },
    { id: "grande-route", nom: "Route à grande circulation", rayon: 120, colle: 40, proche: 80,
      filtre: '["highway"="primary"]' },
    { id: "voie-ferree", nom: "Voie ferrée", rayon: 500, colle: 100, proche: 250,
      filtre: '["railway"~"^(rail|light_rail)$"]["service"!~"^(yard|siding|spur)$"]' },
    { id: "haute-tension", nom: "Ligne haute tension", rayon: 300, colle: 50, proche: 150,
      filtre: '["power"="line"]' },
    { id: "industrie", nom: "Zone industrielle", rayon: 300, colle: 50, proche: 150,
      filtre: '["landuse"="industrial"]' },
    { id: "aerodrome", nom: "Aérodrome", rayon: 3000, colle: 800, proche: 1500,
      filtre: '["aeroway"="aerodrome"]' },
    { id: "nucleaire", nom: "Site nucléaire", rayon: 15000, colle: 3000, proche: 8000,
      filtre: '["power"="plant"]["plant:source"="nuclear"]' },
  ];

  function requete(lat, lon) {
    const p = `${lat.toFixed(6)},${lon.toFixed(6)}`;
    const parties = CATEGORIES.map(c => `nwr(around:${c.rayon},${p})${c.filtre};`).join("\n  ");
    return `[out:json][timeout:25];\n(\n  ${parties}\n);\nout tags geom;`;
  }

  /* Distance en mètres sur une petite zone (projection équirectangulaire autour du point). */
  function projeteur(lat0, lon0) {
    const ky = 111320, kx = 111320 * Math.cos(lat0 * Math.PI / 180);
    return (lat, lon) => [(lon - lon0) * kx, (lat - lat0) * ky];
  }
  function distanceSegment([ax, ay], [bx, by]) {
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2)) : 0;
    return Math.hypot(ax + t * dx, ay + t * dy);
  }
  function dedans(points) {  // le point (0,0) est-il dans le polygone ?
    let ok = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const [xi, yi] = points[i], [xj, yj] = points[j];
      if ((yi > 0) !== (yj > 0) && 0 < (xj - xi) * (0 - yi) / (yj - yi) + xi) ok = !ok;
    }
    return ok;
  }

  /* Lignes (listes de [lat, lon]) d'un élément Overpass : chemin, relation ou point. */
  function lignes(el) {
    if (el.geometry) return [el.geometry.map(g => [g.lat, g.lon])];
    if (el.members) return el.members.filter(m => m.geometry).map(m => m.geometry.map(g => [g.lat, g.lon]));
    if (el.lat != null) return [[[el.lat, el.lon]]];
    if (el.center) return [[[el.center.lat, el.center.lon]]];
    return [];
  }

  function categorieDe(tags) {
    const h = tags.highway, r = tags.railway;
    if (/^motorway/.test(h || "")) return "autoroute";
    if (/^trunk/.test(h || "")) return "voie-rapide";
    if (h === "primary") return "grande-route";
    if (r === "rail" || r === "light_rail") return "voie-ferree";
    if (tags.power === "line") return "haute-tension";
    if (tags.landuse === "industrial") return "industrie";
    if (tags.aeroway === "aerodrome") return "aerodrome";
    if (tags.power === "plant" && tags["plant:source"] === "nuclear") return "nucleaire";
    return null;
  }

  function precision(tags, cat) {
    if (cat === "voie-ferree" && (tags.highspeed === "yes")) return "LGV";
    if (cat === "haute-tension" && tags.voltage) {
      const kv = Math.max(...String(tags.voltage).split(";").map(v => +v || 0)) / 1000;
      return kv ? `${kv.toLocaleString("fr-FR")} kV` : "";
    }
    return tags.ref || tags.name || "";
  }

  /**
   * Résume les éléments Overpass : la plus proche nuisance de chaque catégorie, avec sa distance et son niveau.
   * @returns [{id, nom, detail, distance, niveau: "collé"|"proche"|"à proximité", lignes}] trié par gravité
   */
  function analyser(elements, lat, lon) {
    const proj = projeteur(lat, lon), parCat = new Map();
    for (const el of elements || []) {
      const id = categorieDe(el.tags || {});
      if (!id) continue;
      const cat = CATEGORIES.find(c => c.id === id);
      const ls = lignes(el).filter(l => l.length);
      let d = Infinity;
      for (const l of ls) {
        const pts = l.map(([a, b]) => proj(a, b));
        if (pts.length === 1) d = Math.min(d, Math.hypot(...pts[0]));
        for (let i = 1; i < pts.length; i++) d = Math.min(d, distanceSegment(pts[i - 1], pts[i]));
        const ferme = pts.length > 3 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1];
        if (ferme && ["industrie", "aerodrome", "nucleaire"].includes(id) && dedans(pts)) d = 0;
      }
      if (!(d <= cat.rayon)) continue;
      const prec = parCat.get(id);
      if (!prec || d < prec.distance) {
        parCat.set(id, { id, nom: cat.nom, detail: precision(el.tags || {}, id), distance: Math.round(d),
          niveau: d <= cat.colle ? "collé" : d <= cat.proche ? "proche" : "à proximité", lignes: ls });
      } else if (prec) prec.lignes.push(...ls);
    }
    const rang = { "collé": 0, "proche": 1, "à proximité": 2 };
    return [...parCat.values()].sort((a, b) => rang[a.niveau] - rang[b.niveau] || a.distance - b.distance);
  }

  /** Interroge Overpass (avec un serveur de secours) et renvoie analyser(...). */
  async function chercher(lat, lon, signal) {
    const corps = "data=" + encodeURIComponent(requete(lat, lon));
    let derniere;
    for (const url of SERVEURS) {
      try {
        const r = await fetch(url, { method: "POST", body: corps, signal,
          headers: { "Content-Type": "application/x-www-form-urlencoded" } });
        if (!r.ok) throw new Error(`Overpass ${r.status}`);
        return analyser((await r.json()).elements, lat, lon);
      } catch (e) {
        if (e.name === "AbortError") throw e;
        derniere = e;
      }
    }
    throw derniere;
  }

  const api = { CATEGORIES, requete, analyser, chercher };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else racine.Nuisances = api;
})(typeof window !== "undefined" ? window : globalThis);
