/* Mesure la précision de l'estimateur sur des ventes réelles.

   Pour chaque vente tirée au hasard parmi celles des 12 derniers mois, on fait comme si elle
   n'avait pas encore eu lieu : on l'estime avec les seules ventes antérieures, puis on compare
   l'estimation au prix réellement payé. Les ventes sont tirées proportionnellement au nombre de
   ventes de chaque zone, pour refléter le marché réel (villes comprises).

   Usage : node scripts/mesurer_precision.js site/data [nombre_de_ventes=3000]
   Écrit site/data/precision.json, affiché par le site. */
"use strict";
const fs = require("fs");
const path = require("path");
const E = require("../site/estimation.js");

const dossier = process.argv[2] || "site/data";
const N = +(process.argv[3] || 3000);
const lire = f => JSON.parse(fs.readFileSync(path.join(dossier, f), "utf8"));

const meta = lire("meta.json"), indices = lire("indices.json"), comptes = lire("index_tuiles.json");
const fin = new Date(meta.derniere_vente), debut = new Date(fin); debut.setFullYear(fin.getFullYear() - 1);

// Générateur pseudo-aléatoire reproductible : même échantillon d'une exécution à l'autre
let graine = 20261116;
const hasard = () => ((graine = (graine * 1103515245 + 12345) % 2147483648) / 2147483648);

const cles = Object.keys(comptes), cumul = [];
cles.reduce((s, k, i) => (cumul[i] = s + comptes[k]), 0);
const total = cumul[cumul.length - 1];
const tirerTuile = () => { const x = hasard() * total; let lo = 0, hi = cumul.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (cumul[m] > x) hi = m; else lo = m + 1; } return cles[lo]; };

const cache = new Map();
function tuile(cle) {
  if (!cache.has(cle)) {
    const f = path.join(dossier, "tuiles", cle + ".json");
    cache.set(cle, fs.existsSync(f) ? E.lireTuile(JSON.parse(fs.readFileSync(f, "utf8"))) : []);
    if (cache.size > 400) cache.delete(cache.keys().next().value);
  }
  return cache.get(cle);
}

const resultats = [];
let essais = 0;
while (resultats.length < N && essais < N * 20) {
  essais++;
  const ventesTuile = tuile(tirerTuile());
  const cible = ventesTuile[Math.floor(hasard() * ventesTuile.length)];
  if (!cible || new Date(cible.date) < debut) continue;
  const anterieures = E.tuilesAutour(cible.lat, cible.lon).flatMap(tuile).filter(v => v.date < cible.date);
  const bien = { lat: cible.lat, lon: cible.lon, type: cible.type, surface: cible.surface, pieces: cible.pieces || null,
    etat: "bon", terrain: cible.type === "Maison" ? cible.terrain : 0 };
  const r = E.estimer(anterieures, bien, new Date(cible.date), { indices, reference: E.semestreDe(cible.date) });
  if (!r.ok) { resultats.push({ type: cible.type, ok: false }); continue; }
  resultats.push({ type: cible.type, ok: true, niveau: r.fiabilite.niveau, ecart: r.estimation.median / cible.prix - 1,
    dansFourchette: cible.prix >= r.estimation.bas && cible.prix <= r.estimation.haut });
}

const pctArrondi = x => Math.round(x * 1000) / 10;
function resume(liste) {
  const ok = liste.filter(r => r.ok);
  if (!ok.length) return { n: liste.length, estimees: 0 };
  const abs = ok.map(r => Math.abs(r.ecart));
  return {
    n: liste.length,
    estimees: ok.length,
    erreur_mediane: pctArrondi(E.quantile(abs, 0.5)),
    biais_median: pctArrondi(E.quantile(ok.map(r => r.ecart), 0.5)),
    part_moins_10: pctArrondi(abs.filter(x => x <= 0.1).length / ok.length),
    part_moins_20: pctArrondi(abs.filter(x => x <= 0.2).length / ok.length),
    part_dans_fourchette: pctArrondi(ok.filter(r => r.dansFourchette).length / ok.length),
  };
}
const grouper = cle => Object.fromEntries([...new Set(resultats.filter(r => r[cle]).map(r => r[cle]))]
  .map(k => [k, resume(resultats.filter(r => r[cle] === k))]));

const sortie = {
  mesure_le: new Date().toISOString().slice(0, 10),
  ventes_testees_du: debut.toISOString().slice(0, 10),
  ventes_testees_au: meta.derniere_vente,
  ...resume(resultats),
  par_type: grouper("type"),
  par_fiabilite: grouper("niveau"),
};
fs.writeFileSync(path.join(dossier, "precision.json"), JSON.stringify(sortie, null, 1));
console.log(JSON.stringify(sortie, null, 1));
