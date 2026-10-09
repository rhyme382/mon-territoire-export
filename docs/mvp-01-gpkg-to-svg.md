# MVP-01 — Conversion locale GeoPackage cadastral → SVG Inkscape

**Statut : MVP-01 VALIDATED.**

Convertisseur **local** : il lit un GeoPackage produit par la fonction officielle
« Exporter les données au format SIG » de Mon Territoire et écrit un SVG ouvrable
dans Inkscape. Il n'est pas (encore) intégré à l'extension Chrome et n'utilise aucun réseau.

## Utilisation

1. Dans Mon Territoire, utiliser « Exporter les données au format SIG » et récupérer le `.gpkg`.
2. Lancer :

```
npm run gpkg-to-svg -- --input <fichier.gpkg> --output <fichier.svg> [--layer parcelle] [--width 1200] [--padding 20]
```

| Option | Rôle | Défaut |
|---|---|---|
| `--input` | GeoPackage source | requis |
| `--output` | SVG de sortie | requis |
| `--layer` | couche de features | `parcelle` si présente, sinon l'unique couche, sinon erreur demandant `--layer` |
| `--width` | largeur du SVG en px | 1200 |
| `--padding` | marge en px | 20 |

Sortie terminal : `layer`, `geometry`, `features`, `crs`, `output` (aucune valeur cadastrale).
Code de sortie non nul + message `Erreur : …` en cas de problème.

## Architecture (`tools/gpkg-svg/`)

- `node/sqlite-reader.js` (ex-`lib/gpkg-reader.js`) — adaptateur Node : ouverture lecture seule via `node:sqlite` ; découverte des couches par `gpkg_contents` + `gpkg_geometry_columns` ; CRS via `gpkg_spatial_ref_sys`. Seule la colonne géométrie est sélectionnée : **les attributs ne sont jamais lus**.
- `core/gpkg-geometry.js` — en-tête GeoPackage (`GP`, flags, enveloppe, endianness) + WKB (little/big endian, ISO et EWKB, Z/M ignorés).
- `core/projection.js` — stratégies par CRS vers un plan cartésien Y vers le haut.
- `core/svg-transform.js` — emprise, mise à l'échelle uniforme, padding, inversion Y.
- `core/svg-writer.js` — SVG, style centralisé (`DEFAULT_STYLE`), groupe Inkscape.
- `core/pipeline.js` + `node/convert.js` — orchestration (voir MVP-02) ; `cli.js` — CLI.

**Choix de dépendance : aucune.** `node:sqlite` est intégré à Node ≥ 22.13 (déjà exigé par `package.json`) ; le WKB est décodé par ~160 lignes sur `DataView`. Pas de GDAL, pas de module natif, pas de paquet npm. `node:sqlite` est encore marqué expérimental (avertissement masqué par le script).

## Géométries supportées

`Polygon` et `MultiPolygon`, anneaux extérieurs et trous. Chaque parcelle = un `<path>` unique
(compound path, `fill-rule="evenodd"`) ; les polygones d'un MultiPolygon restent des sous-chemins distincts, non aplatis. Tout autre type (déclaré ou WKB) → erreur explicite.

## CRS et transformation

- EPSG:4326 → Web Mercator sphérique (EPSG:3857), pour éviter de traiter lon/lat comme du cartésien.
- EPSG:3857 et CRS projetés (`PROJCS`/`PROJCRS`) → coordonnées utilisées telles quelles.
- Autre CRS → `UNSUPPORTED_CRS` (extension : ajouter un cas dans `resolveProjection`).
- Puis : emprise, échelle uniforme `(width − 2·padding) / largeur`, hauteur déduite (proportions conservées), Y inversé (SVG vers le bas).

## SVG produit

SVG UTF-8 autonome : `xmlns`, `xmlns:inkscape`, `viewBox`, `width`/`height`, `<metadata>` et
`<g inkscape:groupmode="layer" inkscape:label="Cadastre" id="layer-cadastre">`.
Style : `fill="none" stroke="#000000" stroke-width="1" vector-effect="non-scaling-stroke"`.

## Confidentialité

Métadonnées : générateur, schéma, `sourceFormat`, `layerName`, type géométrique déclaré, CRS, `featureCount`, date d'export, transformation.
Jamais : chemin du fichier, identifiants/références cadastrales, attributs, coordonnées ou bbox source, propriétaires. Les `id` des paths sont séquentiels (`cadastre-N`). Les messages d'erreur ne contiennent pas de valeurs de données.

## Tests

`npm test` — fixture GeoPackage **entièrement synthétique**, générée de façon déterministe pendant les tests (`test/fixture.js`) ; aucune donnée réelle dans le dépôt.

## Limites MVP-01

- Exporte **les parcelles présentes dans le résultat SIG** fourni. Il ne résout **pas** l'export automatique de toutes les parcelles visibles dans le viewport.
- Pas d'intégration extension Chrome, d'interception de téléchargement, de fond IGN/WMS, de labels, d'annotations ni de données propriétaires/MAJIC.
- Trous détectés uniquement via la structure WKB (pas de validation topologique).
- Géométries NULL/vides ignorées (comptées, signalées en `skipped`).
