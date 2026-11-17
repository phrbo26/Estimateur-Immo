"""Tests hors ligne de la préparation des données (lancer : python -m pytest scripts)."""
import json
from datetime import date

import numpy as np
import pandas as pd

import build_data as bd

CENTRE = (45.7600, 4.8500)


def faux_geo_dvf(n=400, seed=1) -> pd.DataFrame:
    """Faux fichier au format geo-dvf, avec les pièges réels du format."""
    rng = np.random.default_rng(seed)
    lignes = []
    base_vide = {"nature_culture": None, "surface_terrain": None}

    def ligne(mid, **kw):
        d = dict(id_mutation=mid, date_mutation="2025-03-01", nature_mutation="Vente", valeur_fonciere=200000,
                 adresse_numero=1, adresse_nom_voie="RUE DE LA PAIX", nom_commune="Lyon 3e Arrondissement", code_departement="69",
                 id_parcelle="P" + mid, type_local="Appartement", surface_reelle_bati=50,
                 nombre_pieces_principales=2, longitude=CENTRE[1], latitude=CENTRE[0], **base_vide)
        d.update(kw)
        lignes.append(d)

    for i in range(n):
        maison = i % 4 == 0
        surf = int(rng.uniform(25, 120))
        d = date(2021 + i % 5, 1 + i % 12, 1 + i % 27).isoformat()
        tendance = {2021: 1.0, 2022: 1.1, 2023: 1.05, 2024: 0.95, 2025: 0.95}[2021 + i % 5]
        commun = dict(date_mutation=d, valeur_fonciere=round(surf * rng.normal(4800, 400) * tendance),
                      adresse_numero=i % 80 + 1, latitude=CENTRE[0] + rng.normal(0, .01),
                      longitude=CENTRE[1] + rng.normal(0, .012))
        ligne(f"M{i}", type_local="Maison" if maison else "Appartement", surface_reelle_bati=surf,
              nombre_pieces_principales=max(1, surf // 22), **commun)
        if maison:  # deux parcelles de terrain : sol + jardin
            lignes[-1].update(nature_culture="sols", surface_terrain=300)
            ligne(f"M{i}", type_local=None, surface_reelle_bati=None, nombre_pieces_principales=None,
                  nature_culture="jardins", surface_terrain=200, **commun)
        if i % 5 == 0:  # cave vendue avec le logement
            ligne(f"M{i}", type_local="Dépendance", surface_reelle_bati=None, nombre_pieces_principales=None, **commun)
    for _ in range(3):
        ligne("BLOC", valeur_fonciere=900000)  # vente en bloc de 3 appartements
    ligne("SYMB", valeur_fonciere=1)  # vente à prix symbolique
    ligne("PRO", valeur_fonciere=600000)
    ligne("PRO", type_local="Local industriel. commercial ou assimilé", surface_reelle_bati=80)
    ligne("ECH", nature_mutation="Echange")
    ligne("NOGEO", latitude=None, longitude=None)
    return pd.DataFrame(lignes)


def test_nettoyage():
    v = bd.nettoyer(faux_geo_dvf())
    assert len(v) == 400  # les 6 mutations pièges sont toutes écartées
    assert (v["prix"] / v["surface"]).between(3000, 7000).all()
    assert set(v.loc[v["maison"] == 1, "terrain"]) == {500}


def test_chaine_complete(tmp_path):
    src = tmp_path / "dvf.csv"
    faux_geo_dvf().to_csv(src, index=False)
    assert bd.main(["--out", str(tmp_path / "data"), "--fichiers", str(src)]) == 0
    meta = json.loads((tmp_path / "data" / "meta.json").read_text())
    assert meta["nb_ventes"] == 400
    tuiles = list((tmp_path / "data" / "tuiles").glob("*.json"))
    total = 0
    for t in tuiles:
        contenu = json.loads(t.read_text())
        assert contenu["communes"][0][1] == "69"
        for lat, lon, *_ in contenu["ventes"]:
            assert bd.cle_tuile(lat, lon) == t.stem
        total += len(contenu["ventes"])
    assert total == 400


def test_cle_tuile_negative():
    assert bd.cle_tuile(-21.13, 55.53) == "-423_793"  # La Réunion : arrondi vers le bas, même en négatif


def test_indices():
    v = bd.nettoyer(faux_geo_dvf(n=2000))
    ind = bd.calculer_indices(v)
    app = ind["dep"]["69"]["Appartement"]
    assert ind["reference"] == "2025-2"
    # le pic de 2022 ressort nettement au-dessus de 2025
    assert app["2022-1"] / app["2025-1"] > 1.08
    assert bd.semestre(pd.Series(["2024-06-30", "2024-07-01"])).tolist() == ["2024-1", "2024-2"]
