/* Algorithme d'estimation par ventes comparables DVF.
   Fonctions pures : utilisables dans le navigateur (window.Estimation) et sous Node (tests). */
(function (racine) {
  "use strict";

  const PAS_LAT = 0.05, PAS_LON = 0.07; // identiques à scripts/build_data.py
  const RAYONS = [300, 500, 800, 1200, 2000, 3000, 5000];
  const MIN_COMPARABLES = 12, MAX_COMPARABLES = 40, FENETRE_MOIS = 36;
  const ETATS = { neuf: 0.12, renove: 0.06, bon: 0, rafraichir: -0.05, travaux: -0.12 };
  const POIDS_BALCON = 0.3, POIDS_TERRASSE = 0.4;
  // Classe énergie : écarts observés par les notaires entre passoires (F, G) et logements performants
  const DPE = { A: 0.06, B: 0.04, C: 0.02, D: 0, E: -0.03, F: -0.08, G: -0.12 };
  const DEMI_VIE_MOIS = 36; // une vente de 3 ans compte moitié moins (les prix sont déjà indexés)
  // Départements sans DVF : Alsace-Moselle (Livre foncier) et Mayotte
  const HORS_DVF = ["57", "67", "68", "976"];

  function departement(codeInsee) {
    return codeInsee.startsWith("97") ? codeInsee.slice(0, 3) : codeInsee.slice(0, 2);
  }

  /** Clés des 9 tuiles (la tuile du point et ses voisines) : couvre au moins 5,5 km autour. */
  function tuilesAutour(lat, lon) {
    const ty = Math.floor(lat / PAS_LAT), tx = Math.floor(lon / PAS_LON), cles = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) cles.push(`${ty + dy}_${tx + dx}`);
    return cles;
  }

  /** Transforme le contenu d'une tuile en objets vente. */
  function lireTuile(contenu) {
    return contenu.ventes.map(([lat, lon, maison, surface, pieces, terrain, prix, date, voie, c]) => {
      const [commune, dep] = contenu.communes[c];
      return { lat, lon, type: maison ? "Maison" : "Appartement", surface, pieces, terrain, prix, date, dep,
        adresse: voie ? `${voie}, ${commune}` : commune, prixM2: prix / surface };
    });
  }

  /** "2024-03-15" -> "2024-1" */
  function semestreDe(date) {
    const d = typeof date === "string" ? date : date.toISOString().slice(0, 10);
    return `${d.slice(0, 4)}-${+d.slice(5, 7) <= 6 ? 1 : 2}`;
  }

  /** Coefficient qui ramène un prix du semestre `sem` au niveau du semestre `ref`.
      Série du département si elle couvre les deux semestres, sinon série nationale. */
  function facteurIndex(indices, dep, type, sem, ref) {
    if (!indices || sem === ref) return 1;
    const d = indices.dep?.[dep]?.[type], n = indices.national?.[type];
    let f = 1;
    if (d && d[sem] && d[ref]) f = d[ref] / d[sem];
    else if (n && n[sem] && n[ref]) f = n[ref] / n[sem];
    return Math.max(0.75, Math.min(1.33, f));
  }

  /** Étage et ascenseur, pour les appartements uniquement. */
  function coefEtage(bien) {
    if (bien.type !== "Appartement" || bien.etage === null || bien.etage === undefined || bien.etage === "") return 0;
    const e = +bien.etage;
    if (e === 0) return -0.06;                     // rez-de-chaussée
    if (!bien.ascenseur && e >= 3) return -0.05;   // 3e étage et plus sans ascenseur
    if (bien.ascenseur && e >= 4) return 0.03;     // étage élevé avec ascenseur
    return 0;
  }

  function distanceM(lat1, lon1, lat2, lon2) {
    const r = 6371000, rad = Math.PI / 180;
    const dp = (lat2 - lat1) * rad, dl = (lon2 - lon1) * rad;
    const a = Math.sin(dp / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dl / 2) ** 2;
    return 2 * r * Math.asin(Math.sqrt(a));
  }

  function quantile(valeurs, q) {
    const a = [...valeurs].sort((x, y) => x - y), p = (a.length - 1) * q, b = Math.floor(p);
    return a[b] + (a[Math.min(b + 1, a.length - 1)] - a[b]) * (p - b);
  }

  function quantilePondere(valeurs, poids, q) {
    const ordre = valeurs.map((_, i) => i).sort((a, b) => valeurs[a] - valeurs[b]);
    const total = poids.reduce((s, w) => s + w, 0);
    let cumul = 0;
    const pts = ordre.map(i => { const c = (cumul + poids[i] / 2) / total; cumul += poids[i]; return [c, valeurs[i]]; });
    if (q <= pts[0][0]) return pts[0][1];
    for (let k = 1; k < pts.length; k++) {
      if (q <= pts[k][0]) { const [c0, v0] = pts[k - 1], [c1, v1] = pts[k]; return v0 + (v1 - v0) * (q - c0) / (c1 - c0); }
    }
    return pts[pts.length - 1][1];
  }

  function filtreEcartInterquartile(ventes) {
    if (ventes.length < 5) return ventes;
    const pm = ventes.map(v => v.prixM2), q1 = quantile(pm, 0.25), q3 = quantile(pm, 0.75), e = q3 - q1;
    return ventes.filter(v => v.prixM2 >= q1 - 1.5 * e && v.prixM2 <= q3 + 1.5 * e);
  }

  /**
   * @param ventes  ventes des tuiles autour du bien (lireTuile)
   * @param bien    {lat, lon, type, surface, pieces, etat, dpe, etage, ascenseur, balcon, terrasse, terrain}
   * @param aujourdHui Date de référence pour l'ancienneté des ventes
   * @param options {indices, reference} : indices de prix (indices.json) et semestre auquel ramener les prix
   */
  function estimer(ventes, bien, aujourdHui = new Date(), options = {}) {
    const { indices = null, reference = indices?.reference } = options;
    const candidats = ventes
      .filter(v => v.type === bien.type && v.surface >= bien.surface * 0.65 && v.surface <= bien.surface * 1.35
        && (!bien.pieces || Math.abs(v.pieces - bien.pieces) <= 1))
      .map(v => {
        const f = facteurIndex(indices, v.dep, v.type, semestreDe(v.date), reference);
        // prixM2 devient le prix ramené au semestre de référence ; prixM2Brut garde le prix de la vente
        return { ...v, prixM2Brut: v.prixM2, prixM2: v.prixM2 * f, indexation: f,
          distance: distanceM(bien.lat, bien.lon, v.lat, v.lon),
          ageMois: (aujourdHui - new Date(v.date)) / 864e5 / 30.44 };
      });

    // Rayon adaptatif : on élargit le rayon, puis la période, jusqu'à avoir assez de ventes
    let sel = null, rayon = RAYONS[RAYONS.length - 1], fenetre = null;
    recherche: for (const f of [FENETRE_MOIS, null]) {
      for (const r of RAYONS) {
        const l = candidats.filter(v => v.distance <= r && (f === null || v.ageMois <= f));
        if (l.length >= MIN_COMPARABLES) { sel = l; rayon = r; fenetre = f; break recherche; }
      }
    }
    if (!sel) sel = candidats.filter(v => v.distance <= rayon);

    sel = filtreEcartInterquartile(sel).sort((a, b) => a.distance - b.distance).slice(0, MAX_COMPARABLES);
    if (sel.length < 3) {
      return { ok: false, rayon, message: "Trop peu de ventes comparables autour de cette adresse. Essayez sans le nombre de pièces, ou avec une surface proche de celles du quartier." };
    }

    // Poids : proximité × fraîcheur × ressemblance de surface
    const poids = sel.map(v => Math.max(0.05,
      (1 / (1 + v.distance / Math.max(rayon / 2, 150)))
      * Math.pow(0.5, v.ageMois / DEMI_VIE_MOIS)
      * (1 - Math.abs(v.surface - bien.surface) / (bien.surface * 0.35) * 0.5)));
    const pm = sel.map(v => v.prixM2);
    const p25 = quantilePondere(pm, poids, 0.25), p50 = quantilePondere(pm, poids, 0.5), p75 = quantilePondere(pm, poids, 0.75);

    const surfacePonderee = bien.surface + (bien.balcon || 0) * POIDS_BALCON + (bien.terrasse || 0) * POIDS_TERRASSE;
    let cTerrain = 0;
    if (bien.type === "Maison" && bien.terrain > 0) {
      const t = sel.filter(v => v.terrain > 0).map(v => v.terrain);
      if (t.length >= 3) cTerrain = Math.max(-0.08, Math.min(0.08, 0.04 * Math.log2(bien.terrain / quantile(t, 0.5))));
    }
    const cEtat = ETATS[bien.etat] ?? 0, cDpe = DPE[bien.dpe] ?? 0, cEtage = coefEtage(bien);
    const coef = 1 + cEtat + cDpe + cEtage + cTerrain;
    const prix = m2 => Math.round(m2 * surfacePonderee * coef / 1000) * 1000;

    const dispersion = (p75 - p25) / p50;
    let score = 100 - Math.max(0, MIN_COMPARABLES - sel.length) * 5
      - ({ 300: 0, 500: 0, 800: 5, 1200: 10, 2000: 20, 3000: 30, 5000: 40 }[rayon])
      - Math.max(0, dispersion - 0.15) * 150 - (fenetre === null ? 15 : 0);
    score = Math.round(Math.max(0, Math.min(100, score)));

    const parAn = {};
    // La courbe montre les prix réellement payés chaque année (non indexés)
    candidats.filter(v => v.distance <= rayon).forEach(v => (parAn[v.date.slice(0, 4)] ??= []).push(v.prixM2Brut));
    const tendance = Object.entries(parAn).filter(([, l]) => l.length >= 3)
      .map(([an, l]) => ({ an: +an, median: quantile(l, 0.5), ventes: l.length })).sort((a, b) => a.an - b.an);

    return {
      ok: true, rayon, fenetre, comparables: sel,
      prixM2: { bas: p25, median: p50, haut: p75 },
      estimation: { bas: prix(p25), median: prix(p50), haut: prix(p75) },
      surfacePonderee, reference: indices ? reference : null,
      ajustements: { etat: cEtat, dpe: cDpe, etage: cEtage, terrain: cTerrain, total: coef - 1 },
      fiabilite: { score, niveau: score >= 70 ? "élevée" : score >= 45 ? "moyenne" : "faible" },
      tendance,
    };
  }

  const api = { PAS_LAT, PAS_LON, ETATS, DPE, HORS_DVF, departement, tuilesAutour, lireTuile, semestreDe,
    facteurIndex, coefEtage, distanceM, quantile, quantilePondere, estimer };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else racine.Estimation = api;
})(typeof window !== "undefined" ? window : globalThis);
