"""Prépare les données DVF pour le site statique.

Télécharge les fichiers « DVF géolocalisées » d'Etalab (une année = un fichier France entière),
ne garde que les ventes d'un logement unique, puis découpe la France en tuiles d'environ
5,5 km × 5,5 km. Le navigateur charge la tuile de l'adresse et ses 8 voisines, ce qui couvre
le rayon de recherche maximal (5 km), y compris de l'autre côté d'une limite de département.

Usage :
    python scripts/build_data.py --out site/data                 # vraies données (GitHub Actions)
    python scripts/build_data.py --out site/data --fichiers a.csv  # fichiers locaux (tests)
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from datetime import date, datetime, timezone
from pathlib import Path

import httpx
import numpy as np
import pandas as pd

URL_ANNEE = "https://files.data.gouv.fr/geo-dvf/latest/csv/{annee}/full.csv.gz"
NB_ANNEES = 7  # on essaie les 7 dernières années ; celles qui n'existent pas sont ignorées

# Taille des tuiles en degrés (doit être identique dans site/estimation.js)
PAS_LAT = 0.05
PAS_LON = 0.07

COLONNES = [
    "id_mutation", "date_mutation", "nature_mutation", "valeur_fonciere",
    "adresse_numero", "adresse_nom_voie", "nom_commune", "code_departement",
    "id_parcelle", "type_local", "surface_reelle_bati", "nombre_pieces_principales",
    "nature_culture", "surface_terrain", "longitude", "latitude",
]
TYPES = {
    "id_mutation": "string", "date_mutation": "string", "nature_mutation": "category",
    "adresse_nom_voie": "string", "nom_commune": "category", "code_departement": "string", "id_parcelle": "string",
    "type_local": "category", "nature_culture": "category",
}


# ---------------------------------------------------------------- téléchargement
def telecharger(annee: int, cache: Path) -> Path | None:
    cache.mkdir(parents=True, exist_ok=True)
    chemin = cache / f"dvf_{annee}.csv.gz"
    if chemin.exists() and chemin.stat().st_size > 0:
        print(f"  {annee} : en cache", flush=True)
        return chemin
    url = URL_ANNEE.format(annee=annee)
    with httpx.Client(timeout=600, follow_redirects=True) as client, client.stream("GET", url) as r:
        if r.status_code == 404:
            print(f"  {annee} : pas de fichier", flush=True)
            return None
        r.raise_for_status()
        tmp = chemin.with_suffix(".part")
        with tmp.open("wb") as f:
            for bloc in r.iter_bytes(1 << 20):
                f.write(bloc)
        tmp.rename(chemin)
    print(f"  {annee} : téléchargé ({chemin.stat().st_size / 1e6:.0f} Mo)", flush=True)
    return chemin


def lire(chemin: Path) -> pd.DataFrame:
    return pd.read_csv(chemin, usecols=COLONNES, dtype=TYPES, low_memory=False)


# ---------------------------------------------------------------- nettoyage
def nettoyer(brut: pd.DataFrame) -> pd.DataFrame:
    """Une ligne par vente d'un logement unique.

    Une mutation DVF s'étale sur plusieurs lignes (lots, dépendances, parcelles) et
    `valeur_fonciere` y est répété : c'est le prix de TOUTE la mutation. On écarte donc les
    ventes de plusieurs logements ou avec un local professionnel, sinon le prix au m² serait gonflé.
    Les caves et parkings vendus avec le logement restent, leur prix est inclus dans la vente.
    """
    df = brut[brut["nature_mutation"] == "Vente"]
    df = df.dropna(subset=["valeur_fonciere", "latitude", "longitude"])

    est_logement = df["type_local"].isin(["Maison", "Appartement"])
    est_pro = df["type_local"].astype("string").str.startswith("Local", na=False)
    compte = pd.DataFrame({"id": df["id_mutation"], "log": est_logement, "pro": est_pro}).groupby("id").sum()
    ok = compte.index[(compte["log"] == 1) & (compte["pro"] == 0)]
    df = df[df["id_mutation"].isin(ok)]

    # Terrain : somme des parcelles distinctes de la mutation
    terrain = (
        df.drop_duplicates(["id_mutation", "id_parcelle", "nature_culture"])
        .groupby("id_mutation")["surface_terrain"].sum(min_count=1)
    )
    lg = df[df["type_local"].isin(["Maison", "Appartement"])].drop_duplicates("id_mutation")
    lg = lg.join(terrain.rename("terrain"), on="id_mutation")

    num = pd.to_numeric(lg["adresse_numero"], errors="coerce").astype("Int64").astype("string").fillna("")
    voie = lg["adresse_nom_voie"].fillna("").str.title()

    out = pd.DataFrame({
        "lat": lg["latitude"].astype(float),
        "lon": lg["longitude"].astype(float),
        "maison": (lg["type_local"] == "Maison").astype(int),
        "surface": pd.to_numeric(lg["surface_reelle_bati"], errors="coerce"),
        "pieces": pd.to_numeric(lg["nombre_pieces_principales"], errors="coerce").fillna(0).astype(int),
        "terrain": lg["terrain"].fillna(0).round().astype(int),
        "prix": pd.to_numeric(lg["valeur_fonciere"], errors="coerce"),
        "date": lg["date_mutation"],
        "voie": (num + " " + voie).str.strip(),
        "commune": lg["nom_commune"].astype("string").fillna(""),
        "dep": lg["code_departement"].astype("string").fillna("").str.zfill(2),
    })
    out = out[(out["surface"] >= 9) & (out["prix"] >= 5_000)]
    pm2 = out["prix"] / out["surface"]
    # Garde-fou large (ventes symboliques, erreurs de saisie). Le filtre fin est fait autour de
    # chaque adresse dans le navigateur, par écart interquartile.
    out = out[(pm2 >= 300) & (pm2 <= 30_000)]
    out["surface"] = out["surface"].round().astype(int)
    out["prix"] = out["prix"].round().astype(int)
    return out.reset_index(drop=True)


# ---------------------------------------------------------------- tuiles
def cle_tuile(lat: float, lon: float) -> str:
    return f"{math.floor(lat / PAS_LAT)}_{math.floor(lon / PAS_LON)}"


def ecrire_tuiles(ventes: pd.DataFrame, dossier: Path) -> int:
    tuiles = dossier / "tuiles"
    tuiles.mkdir(parents=True, exist_ok=True)
    for f in tuiles.glob("*.json"):
        f.unlink()
    # Même calcul que Math.floor(lat / PAS) côté navigateur, sur les coordonnées arrondies
    # telles qu'elles sont écrites (l'opérateur // diffère de floor(a/b) aux bords de tuile).
    ventes = ventes.assign(lat=ventes["lat"].round(5), lon=ventes["lon"].round(5))
    ventes = ventes.assign(
        ty=np.floor(ventes["lat"] / PAS_LAT).astype(int), tx=np.floor(ventes["lon"] / PAS_LON).astype(int)
    ).sort_values(["ty", "tx", "date"])
    comptes = {}
    for (ty, tx), g in ventes.groupby(["ty", "tx"], sort=False):
        communes = list(dict.fromkeys(zip(g["commune"], g["dep"])))
        idx = {c: i for i, c in enumerate(communes)}
        lignes = [
            [round(r.lat, 5), round(r.lon, 5), r.maison, r.surface, r.pieces, r.terrain, r.prix,
             r.date, r.voie, idx[(r.commune, r.dep)]]
            for r in g.itertuples(index=False)
        ]
        contenu = {"communes": [list(c) for c in communes], "ventes": lignes}
        cle = f"{ty}_{tx}"
        (tuiles / f"{cle}.json").write_text(
            json.dumps(contenu, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
        )
        comptes[cle] = len(lignes)
    # Nombre de ventes par tuile : sert à tirer un échantillon représentatif pour mesurer la précision
    (dossier / "index_tuiles.json").write_text(json.dumps(comptes, separators=(",", ":")), encoding="utf-8")
    return len(comptes)


# ---------------------------------------------------------------- indices de prix
MIN_VENTES_SEMESTRE_DEP = 40
MIN_VENTES_SEMESTRE_NAT = 200


def semestre(dates: pd.Series) -> pd.Series:
    """'2024-03-15' -> '2024-1' ; '2024-09-01' -> '2024-2'."""
    d = dates.astype("string")
    return d.str[:4] + "-" + np.where(d.str[5:7].astype(int) <= 6, "1", "2")


def calculer_indices(ventes: pd.DataFrame) -> dict:
    """Prix médian au m² par semestre, par département et pour la France entière, séparément
    pour les appartements et les maisons. Le navigateur s'en sert pour ramener une vente ancienne
    au niveau de prix du dernier semestre connu."""
    v = ventes.assign(sem=semestre(ventes["date"]), pm2=ventes["prix"] / ventes["surface"],
                      type=np.where(ventes["maison"] == 1, "Maison", "Appartement"))

    def series(g, minimum):
        s = g.groupby("sem")["pm2"].agg(["median", "count"])
        s = s[s["count"] >= minimum]
        return {k: round(float(m)) for k, m in s["median"].items()}

    national = {t: series(g, MIN_VENTES_SEMESTRE_NAT) for t, g in v.groupby("type")}
    par_dep = {}
    for (dep, t), g in v.groupby(["dep", "type"]):
        s = series(g, MIN_VENTES_SEMESTRE_DEP)
        if len(s) >= 2:
            par_dep.setdefault(dep, {})[t] = s
    # Référence : le dernier semestre présent dans les deux séries nationales
    communs = set(national.get("Appartement", {})) & set(national.get("Maison", {}))
    reference = max(communs) if communs else max(v["sem"])
    return {"reference": reference, "national": national, "dep": par_dep}


def main(argv=None) -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--out", type=Path, default=Path("site/data"))
    p.add_argument("--cache", type=Path, default=Path(".cache-dvf"))
    p.add_argument("--fichiers", nargs="*", type=Path, help="fichiers geo-dvf locaux à utiliser à la place du téléchargement")
    a = p.parse_args(argv)

    if a.fichiers:
        sources = a.fichiers
    else:
        print("Téléchargement des fichiers DVF géolocalisées…", flush=True)
        an = date.today().year
        sources = [c for c in (telecharger(y, a.cache) for y in range(an - NB_ANNEES + 1, an + 1)) if c]
    if not sources:
        print("Aucun fichier DVF disponible.", file=sys.stderr)
        return 1

    morceaux = []
    for s in sources:
        print(f"Nettoyage de {s.name}…", flush=True)
        morceaux.append(nettoyer(lire(s)))
    ventes = pd.concat(morceaux, ignore_index=True)

    a.out.mkdir(parents=True, exist_ok=True)
    nb_tuiles = ecrire_tuiles(ventes, a.out)
    indices = calculer_indices(ventes)
    (a.out / "indices.json").write_text(json.dumps(indices, separators=(",", ":")), encoding="utf-8")
    meta = {
        "semestre_reference": indices["reference"],
        "genere_le": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "derniere_vente": str(ventes["date"].max()),
        "premiere_vente": str(ventes["date"].min()),
        "nb_ventes": int(len(ventes)),
        "nb_tuiles": nb_tuiles,
        "pas_lat": PAS_LAT,
        "pas_lon": PAS_LON,
    }
    (a.out / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{meta['nb_ventes']:,} ventes réparties dans {nb_tuiles:,} tuiles.".replace(",", " "))
    return 0


if __name__ == "__main__":
    sys.exit(main())
