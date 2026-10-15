# MVP-03A — Autopsie de la carte visible (état runtime Leaflet)

Statut : instrumentation livrée, **test réel A/B non effectué**. Aucune conclusion sur l'accessibilité de la géométrie n'est établie par ce document.

## Question expérimentale

Une fois la carte et le cadastre rendus, peut-on récupérer les géométries des parcelles visibles depuis l'état Leaflet / VectorGrid / VectorTileLayer déjà chargé et décodé par la page ? Où, sous quelle structure, et comment relier entité → géométrie → tuile → viewport ?

## Ce que l'on inspecte (lecture seule, monde MAIN)

`tools/probe/visible-map-inspector.js` :

- **Découverte de la Map**, par ordre : propriété globale de la page (descripteurs de données uniquement, aucun getter appelé) → propriété de données portée par le `.leaflet-container` → `L.Map.addInitHook` (API publique Leaflet, observe `this`, ne wrappe rien ; ne voit que les cartes créées après installation). Le rapport indique la méthode réellement efficace.
- **Inventaire des layers** de `map._layers` : famille (`instanceof` sur les classes Leaflet, car les classes Leaflet s'appellent toutes `NewClass`), id Leaflet, pane, z-index, `_tileZoom`, taille des caches `_tiles` / `_vectorTiles`, renderer, présence canvas/svg/container, gabarit d'URL sanitisé. Classification `raster | wms | vectorgrid | vectortilelayer | geojson-vector | mask | unknown` avec `evidence` et `confidence`.
- **Candidat cadastre** : score sur gabarit d'URL, clés de `vectorTileLayerStyles`, noms de couches décodées, noms de propriétés (`idu`, `insee`), classe.
- **Tuiles** (`_vectorTiles`) : magasins `_features`, `_layers` (objets chemin du renderer), `layers` (tuile décodée à la Mapbox, `feature(i).loadGeometry()` appelé localement pour compter anneaux/sommets, rien n'est conservé). Représentations reconnues : `lazy-loadGeometry`, `mvt-geometry`, `mvt-command-integers`, `geojson-geometry` (directes) ; `leaflet-pixel-parts`, `leaflet-rings`, `leaflet-latlngs` (renderer).

`tools/probe/visible-map-report.js` (monde isolé) : validation à schéma fermé, comparaison A/B, conclusion déterministe, rapport.

## Protocole A/B

Dans Diagnostic → **VISIBLE MAP / CADASTRE** :

1. Masque masqué, cadastre **désactivé** dans Mon Territoire, viewport fixé → **Capture A — Cadastre OFF**.
2. Activer uniquement le cadastre. Ne pas déplacer, ne pas zoomer → **Capture B — Cadastre ON**.
3. **Comparer A/B** (layers ajoutés/retirés, delta de cache de tuiles, renderer, nouvelles structures, candidat le plus probable, même zoom).
4. **Copier / Télécharger rapport MVP-03A**.

L'extension ne bascule jamais un layer et ne modifie jamais la vue ; les captures ne partent que d'un clic.

## Sanitization

Rapport : noms de classes, noms de clés, compteurs, zoom. Jamais : centre, bounds, coordonnées, x/y de tuile (les clés de tuile ne sont gardées que sous forme `n:n:n`), valeurs de propriétés, identifiants, query strings, cookies, en-têtes. Gabarits d'URL : hostname + chemin avec `{z}/{x}/{y}`. Le pont MAIN → isolé rejette tout champ hors schéma.

## Invariant réseau

Aucune requête : pas de fetch, XHR, Worker, Image, rejeu ni reconstruction d'URL de tuile. Permissions inchangées : `["activeTab"]`.

## Conclusions possibles → décision MVP-03B

| Conclusion | Sens | MVP-03B |
|---|---|---|
| `DIRECT_GEOMETRY_AVAILABLE` | géométrie décodée (loadGeometry / MVT) en mémoire | lire les entités par tuile, projeter dans le viewport, SVG |
| `RENDERER_GEOMETRY_AVAILABLE` | géométrie seulement dans les objets du renderer (pixels de tuile) | replacer par tuile + export SVG ; vérifier le lien tuile ↔ entité |
| `TILE_CACHE_WITHOUT_GEOMETRY` | tuiles en cache, rien d'exploitable | observer le point de décodage ou étudier le canvas, sans rejeu |
| `NO_RUNTIME_GEOMETRY_FOUND` | rien dans l'état Leaflet | chercher hors Leaflet (worker, canvas séparé) |
| `INSUFFICIENT_EVIDENCE` | carte ou candidat introuvable | refaire le protocole A/B |

`recommendedNextStep` est inclus dans le rapport.
