# MVP-02 — Export GeoPackage → SVG dans l'extension

**Statut : MVP-02 VALIDATED IN REAL BROWSER** (voir `mvp-02c-consolidation.md`).

MVP-02 convertit les parcelles présentes dans un export SIG officiel
sélectionné par l'utilisateur. Il ne récupère **pas** encore automatiquement
toutes les parcelles du viewport.

## Workflow utilisateur

1. Dans Mon Territoire, utiliser « Exporter les données au format SIG » → fichier `.gpkg`.
2. Dans le panneau de l'extension (section **Export cadastre**), « Choisir un fichier GeoPackage ».
3. L'extension analyse le fichier localement et affiche : couche, géométrie, nombre de parcelles, CRS (jamais d'attribut cadastral).
4. « Exporter en SVG » télécharge `mon-territoire-cadastre-YYYYMMDD.svg`, ouvrable dans Inkscape (calque **Cadastre**).

Les sondes de diagnostic existantes sont conservées, regroupées dans la section repliable **Diagnostic**.
Le panneau ne propose pas de bascule du masque : aucune n'existe dans le code du dépôt.

## Architecture core / adaptateurs

```
tools/gpkg-svg/
  core/      pur JS, sans API Node ni navigateur
    geopackage.js        modèle GeoPackage au-dessus d'une interface « reader »
    gpkg-geometry.js     en-tête GP + WKB (Polygon / MultiPolygon)
    projection.js        CRS → plan Y-haut
    svg-transform.js     emprise, échelle, inversion Y
    svg-writer.js        SVG (un <g inkscape:groupmode="layer"> par calque)
    export-document.js   modèle ExportDocument { meta, layers[] }
    pipeline.js          prepareCadastreDocument → renderExportDocument
  node/      adaptateur CLI / tests (node:sqlite)
  browser/   adaptateur extension
    sqlite-file-reader.js  lecteur SQLite pur JS sur Uint8Array
    api.js                 loadGeoPackageBytes, exportDocumentToSvg, contrôleur d'UI
  cli.js
```

Interface « reader » (seul point dépendant de la plateforme) :
`listFeatureLayers()`, `getSrsRow(srsId)`, `readGeometryBlobs(layer)`, `close()`.
Les algorithmes (géométrie, projection, transformation, SVG) existent **une seule fois** dans `core/`.

`ExportDocument` = liste de calques exportables. Aujourd'hui seul `Cadastre`
existe ; le writer itère sur `layers`, donc d'autres calques pourront être
ajoutés sans réécrire le moteur (aucun n'est implémenté).

## Reader Node vs navigateur

| | Node (CLI, tests) | Navigateur |
|---|---|---|
| Entrée | chemin de fichier | `Uint8Array` du fichier choisi |
| SQLite | `node:sqlite` | lecteur pur JS (`sqlite-file-reader.js`) |
| Attributs | jamais sélectionnés | jamais décodés (octets ignorés via les serial types) |

Les deux sont testés l'un contre l'autre (mêmes blobs géométriques, mêmes SVG octet pour octet).

## Choix SQLite navigateur

Ni `sql.js` ni aucune dépendance n'étaient disponibles (aucun accès réseau lors du
développement). Choix retenu : **lecteur SQLite minimal en lecture seule, écrit dans le dépôt**.
Il couvre ce dont un GeoPackage a besoin : en-tête, `sqlite_master`, tables b-tree rowid
(pages intérieures/feuilles, pages de débordement, alias `INTEGER PRIMARY KEY`),
encodages UTF-8/UTF-16.

Avantages : aucune dépendance et donc aucune licence tierce, aucun WASM (pas de
`wasm-unsafe-eval` dans la CSP, pas d'asset binaire à empaqueter), surface minimale.
Limites : tables `WITHOUT ROWID` et tables virtuelles non supportées (jamais utilisées
par les tables de features/système GeoPackage) ; pas de SQL. Si un besoin futur dépasse cela,
l'interface « reader » permet de brancher `sql.js` localement (WASM packagé) sans toucher au core.

Le bundle `dist/gpkg-svg.js` est produit par `tools/probe/bundle-modules.mjs`
(concaténation d'ES modules relatifs en IIFE ; un import non relatif ou `node:` fait échouer le build).
Il n'expose qu'un global : `MonTerritoireGpkgSvg`.

## Confidentialité

- Le fichier reste en mémoire (`Uint8Array`) le temps de l'analyse ; seules les géométries projetées sont conservées pour l'export, libérées au changement de fichier.
- Aucun `fetch`/XHR/beacon, aucun stockage (`chrome.storage`, `localStorage`, IndexedDB), aucune télémétrie, aucun code distant.
- Le SVG ne contient ni attribut cadastral ni coordonnée source dans ses métadonnées.
- Les erreurs affichées sont des messages fixes ; la console ne reçoit que le nom et le code d'erreur.
- Les sondes existantes ne reçoivent pas le contenu du GPKG.

## Permissions

`permissions = ["activeTab"]` inchangé. Pas de `downloads` (Blob + `<a download>`), `storage`, host supplémentaire ni accès système de fichiers (simple `<input type=file>`).

## Limites

- Couche `parcelle` (ou couche unique) ; Polygon / MultiPolygon ; EPSG:4326, EPSG:3857 ou CRS projeté.
- Fichier ≤ 256 Mo, entièrement chargé en mémoire.
- Pas d'interception de l'export SOGEFI, pas d'appel API, pas de MVT, pas de viewport automatique, pas de fond IGN/WMS, urbanisme, servitudes, randonnée, annotations, labels, MAJIC.
- À vérifier en navigateur : téléchargement Blob depuis le content script sur `carto.monterritoire.fr` (dépend de la CSP de la page).
