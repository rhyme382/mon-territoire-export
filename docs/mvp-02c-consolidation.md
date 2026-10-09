# MVP-02C — Consolidation avant export multicouche

- MVP-01 : VALIDATED
- MVP-02 : VALIDATED IN REAL BROWSER

## Workflow validé

Mon Territoire → export SIG officiel GeoPackage → import du GPKG dans l'extension → conversion locale → téléchargement SVG → ouverture dans Inkscape.
Test réel : 6 parcelles, 6 paths distincts, un unique calque Inkscape « Cadastre », MULTIPOLYGON, EPSG:4326, formes correctes, SVG éditable.

## Contrôle local du masque

`tools/probe/mask-control.js`. Bouton « Masquer le masque » / « Afficher le masque » :

- cible exclusivement `.leaflet-mask-pane`, seule écriture : `style.display` (`'none'`, puis restauration de la valeur inline précédente) ;
- l'état est relu dans le DOM à chaque affichage : le libellé ne peut pas diverger de la réalité ;
- aucun objet SOGEFI, `isAllowed`, `user_data.insees`, requête ou réponse n'est touché ; aucune autorisation n'est modifiée ni débloquée ;
- aucune persistance : un rechargement rend le comportement normal du site ;
- pane absent : message « Masque non détecté », rien n'est simulé.

## Produit / Diagnostic

Panneau : **Carte** (masque) → **Export cadastre** (fichier, résumé couche/géométrie/parcelles/CRS, export SVG) → **Diagnostic ▸ Outils de développement** (repliés, secondaires).

## Architecture multicouche

`ExportDocument { meta, layers[] }` (`tools/gpkg-svg/core/export-document.js`). `pipeline.js` calcule les bornes sur `document.layers` et `svg-writer.js` itère sur `layers[]` (un calque Inkscape par entrée). Seul `Cadastre` existe ; aucun calque vide n'est créé par anticipation. Fond IGN, urbanisme, servitudes, randonnée, annotations s'ajouteront en fournissant de nouveaux `ExportLayer` (`id`, `label`, `idPrefix`, `features`, `style?`). Aucune abstraction supplémentaire n'était nécessaire. Un calque raster (fond IGN) exigera d'étendre le writer à un type de contenu non vectoriel : à décider en MVP-03.

## Sondes T00

| Élément | Classe | Décision |
|---|---|---|
| gpkg-svg, export UI, mask-control | produit | conservés |
| render-inspector (T00-C), pci-contour-observer (T00-G), main-observer (T00-D), engine-inspector (T00-E), lib/ | diagnostic développeur | conservés, repliés dans Diagnostic ; utiles pour MVP-03 (inspection du rendu Leaflet, tuiles/contours) |
| `t00-f-static.js`, builds accidentels, HAR, GPKG/SVG réels, logs, source maps | obsolète / sensible | absents du dépôt et de `dist/` (vérifié) |

Rien n'a été supprimé : aucun artefact obsolète versionnable n'existait. `.local-analysis/` et `.superpowers/` sont ignorés (non versionnés), `dist/` aussi.

## Invariants

Permissions exactement `["activeTab"]`, aucun hôte supplémentaire, aucun réseau, aucune télémétrie, aucune persistance du GPKG, aucune donnée MAJIC/propriétaire, aucun identifiant cadastral ni coordonnée brute dans le SVG.

## Limites avant MVP-03

Un seul calque ; pas de fond IGN, raster, viewport, MVT, WMS ; GPKG importé manuellement (pas d'interception) ; contrôle du masque non retesté en navigateur réel.
