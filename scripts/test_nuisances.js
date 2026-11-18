/* Tests du repérage des nuisances (site/nuisances.js) sur une fausse réponse Overpass.
   Lancer : node scripts/test_nuisances.js */
"use strict";
const assert = require("assert");
const N = require("../site/nuisances.js");

const lat = 44.4428, lon = 4.7106;          // Donzère
const m = 1 / 111320;                         // ~1 m en latitude
const kx = 1 / (111320 * Math.cos(lat * Math.PI / 180));  // ~1 m en longitude

const elements = [
  // autoroute nord-sud à 120 m à l'est
  { type: "way", tags: { highway: "motorway", ref: "A 7" },
    geometry: [{ lat: lat - 500 * m, lon: lon + 120 * kx }, { lat: lat + 500 * m, lon: lon + 120 * kx }] },
  // voie ferrée LGV à 400 m à l'ouest
  { type: "way", tags: { railway: "rail", highspeed: "yes" },
    geometry: [{ lat: lat - 800 * m, lon: lon - 400 * kx }, { lat: lat + 800 * m, lon: lon - 400 * kx }] },
  // voie de garage : ignorée par la requête réelle, mais même si elle arrive on la classe en voie ferrée
  // ligne haute tension à 280 m : dans le rayon (300 m), niveau « à proximité »
  { type: "way", tags: { power: "line", voltage: "225000;63000" },
    geometry: [{ lat: lat + 280 * m, lon: lon - 600 * kx }, { lat: lat + 280 * m, lon: lon + 600 * kx }] },
  // zone industrielle qui contient le point : distance 0
  { type: "way", tags: { landuse: "industrial" }, geometry: [
    { lat: lat - 50 * m, lon: lon - 50 * kx }, { lat: lat - 50 * m, lon: lon + 50 * kx },
    { lat: lat + 50 * m, lon: lon + 50 * kx }, { lat: lat + 50 * m, lon: lon - 50 * kx }, { lat: lat - 50 * m, lon: lon - 50 * kx }] },
  // route sans intérêt
  { type: "way", tags: { highway: "residential" }, geometry: [{ lat, lon }, { lat: lat + 10 * m, lon }] },
  // aérodrome à 5 km : hors rayon (3 km), ignoré
  { type: "node", lat: lat + 5000 * m, lon, tags: { aeroway: "aerodrome", name: "Loin" } },
];

const r = N.analyser(elements, lat, lon);
const par = Object.fromEntries(r.map(x => [x.id, x]));

assert.deepStrictEqual(r.map(x => x.id).sort(), ["autoroute", "haute-tension", "industrie", "voie-ferree"]);
assert.ok(Math.abs(par.autoroute.distance - 120) <= 2, `autoroute ${par.autoroute.distance}`);
assert.strictEqual(par.autoroute.niveau, "collé");
assert.strictEqual(par.autoroute.detail, "A 7");
assert.ok(Math.abs(par["voie-ferree"].distance - 400) <= 3);
assert.strictEqual(par["voie-ferree"].niveau, "à proximité");
assert.strictEqual(par["voie-ferree"].detail, "LGV");
assert.strictEqual(par["haute-tension"].detail, "225 kV");
assert.strictEqual(par["haute-tension"].niveau, "à proximité");
assert.strictEqual(par.industrie.distance, 0);
assert.strictEqual(r[0].niveau, "collé");  // le plus gênant en premier
assert.ok(N.requete(lat, lon).includes("around:600,44.442800,4.710600"));
assert.deepStrictEqual(N.analyser([], lat, lon), []);

console.log("nuisances : tous les tests passent");
for (const x of r) console.log(`  ${x.nom}${x.detail ? " (" + x.detail + ")" : ""} : ${x.distance} m, ${x.niveau}`);
