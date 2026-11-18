# Estimateur DVF

Estimation d'un appartement ou d'une maison à partir des ventes notariées réelles autour de l'adresse
(Demandes de Valeurs Foncières). Site statique publié avec GitHub Pages : rien à installer, il s'ouvre
dans n'importe quel navigateur, téléphone compris.

## Comment ça marche

```
GitHub Actions (au push et le 5 de chaque mois)
  1. télécharge les fichiers « DVF géolocalisées » d'Etalab (une année = un fichier France entière)
  2. ne garde que les ventes d'un logement unique (scripts/build_data.py)
  3. calcule l'évolution des prix par département et par semestre (indices.json)
  4. découpe la France en tuiles d'environ 5,5 km
  5. mesure la précision sur 3 000 ventes réelles de l'année écoulée (precision.json)
  6. publie le tout avec le site

Navigateur
  7. l'adresse saisie est géocodée par la Géoplateforme IGN
  8. la page charge la tuile de l'adresse et ses 8 voisines
  9. l'estimation est calculée sur place (site/estimation.js)
```

Comme les tuiles ignorent les limites administratives, les ventes situées dans le département voisin
comptent aussi.

## Mise en ligne

1. Créer un dépôt sur GitHub (ici `Estimateur-Immo`) et y envoyer le contenu de ce dossier,
   **y compris le dossier caché `.github`**.
2. Dans le dépôt : **Settings → Pages → Build and deployment → Source : GitHub Actions**.
3. Onglet **Actions** : le workflow « Publier le site » démarre. La première exécution dure 15 à 30 minutes,
   à cause du téléchargement des données DVF.
4. Le site est en ligne à l'adresse https://phrbo26.github.io/Estimateur-Immo/.

Pour forcer une mise à jour des données : **Actions → Publier le site → Run workflow**.

## L'algorithme

1. **Nettoyage des mutations** : une vente DVF s'étale sur plusieurs lignes et `valeur_fonciere` y est
   répété. Les ventes de plusieurs logements et celles qui comprennent un local professionnel sont écartées.
   Les caves et parkings vendus avec le logement restent. Les terrains de plusieurs parcelles sont additionnés.
2. **Comparables** : même type de bien, surface à ±35 %, nombre de pièces à ±1.
3. **Rayon adaptatif** : 300 m, puis 500, 800, 1 200, 2 000, 3 000 et 5 000 m, jusqu'à 12 ventes sur
   les 36 derniers mois. Sinon, la période est élargie à toutes les années disponibles.
4. **Valeurs extrêmes** écartées par écart interquartile autour de l'adresse.
5. **Indexation** : chaque vente est ramenée au niveau de prix du dernier semestre connu, d'après
   l'évolution du prix médian au m² dans son département (à défaut, en France). Sans cela, les ventes
   du pic de 2022 gonflent l'estimation.
6. **Médiane pondérée** du prix au m² : les ventes proches, récentes et de surface voisine comptent davantage.
   La fourchette correspond aux quartiles pondérés (25 % et 75 %).
7. **Ajustements** : état du logement, classe énergie (DPE), étage et ascenseur, balcon (30 % du prix
   au m²), terrasse (40 %), terrain des maisons comparé à la médiane des comparables (±8 % au plus).
8. **Indice de fiabilité** sur 100 : nombre de ventes, rayon nécessaire, dispersion des prix, ancienneté.

## Nuisances autour de l'adresse

Après chaque estimation, `site/nuisances.js` interroge OpenStreetMap (API Overpass) autour de l'adresse et signale
les autoroutes, voies rapides, grandes routes très proches, voies ferrées (LGV comprises), lignes haute tension,
zones industrielles, aérodromes et sites nucléaires, avec leur distance et un niveau (collé, proche, à proximité).
Les tracés apparaissent en couleur sur la carte.

C'est un **simple avertissement** : il ne modifie pas l'estimation. `estimation.js` n'en dépend pas, si bien que
l'appli d'annonces (Annonce-immo-), qui réutilise `estimation.js` pour comparer les annonces au marché, n'est pas concernée.
Tests : `node scripts/test_nuisances.js`.

## Précision mesurée

À chaque publication, `scripts/mesurer_precision.js` tire 3 000 ventes de l'année écoulée, au prorata
du nombre de ventes de chaque zone. Il estime chacune avec les seules ventes antérieures, puis compare
au prix réellement payé. Le site affiche l'erreur médiane, globale et par niveau de fiabilité, et la part
des prix réels qui tombent dans la fourchette. Le détail se trouve dans `site/data/precision.json` du site
publié. C'est l'outil pour régler les coefficients : on modifie, on publie, et on compare.

## Fonctions de l'appli

- Bouton « Utiliser ma position » et lien partageable pour chaque estimation.
- Historique des 12 dernières estimations, gardé sur l'appareil.
- Installable sur l'écran d'accueil du téléphone : depuis le navigateur, choisir « Ajouter à l'écran
  d'accueil ». L'interface s'ouvre aussi sans réseau, et les zones déjà consultées restent disponibles.

## Pour tester en local

```bash
pip install -r scripts/requirements.txt
python -m pytest scripts                          # tests sur un faux fichier DVF
python scripts/build_data.py --out site/data      # télécharge les vraies données (environ 700 Mo)
node scripts/mesurer_precision.js site/data
python -m http.server -d site 8000                # puis ouvrir http://localhost:8000
```

## Limites connues

- Pas de données pour le Bas-Rhin, le Haut-Rhin, la Moselle (Livre foncier) ni Mayotte.
- DVF est publié avec environ 6 mois de retard ; la date de la dernière vente connue est affichée.
- L'indexation se fait à l'échelle du département : un quartier qui évolue à contre-courant est moins bien suivi.
- Les coefficients d'état, de DPE et d'étage sont fixés à la main : DVF ne contient pas ces informations,
  on ne peut donc pas les mesurer avec ces seules données.
