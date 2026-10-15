# MVP-03B — Export SVG du cadastre visible dans le viewport

Statut : **VALIDATED_IN_REAL_BROWSER** (limites cadastrales du pan de carte visible, emprise et géométrie conformes à la carte réelle, sans sélection préalable).

| Jalon | Statut |
| --- | --- |
| MVP-01 | VALIDATED |
| MVP-02 / MVP-02C | VALIDATED_IN_BROWSER |
| MVP-03A | VALIDATED_IN_REAL_BROWSER (`RENDERER_GEOMETRY_AVAILABLE`) |
| MVP-03B | VALIDATED_IN_REAL_BROWSER |
| MVP-03C | READY_FOR_REAL_SELECTION_AB_TEST |

## Ce que fait la commande

Produit **Export de la carte visible → Exporter le cadastre visible en SVG** : un SVG de la seule géométrie cadastrale visible dans le rectangle courant de la carte. Indépendant du GeoPackage (le pipeline GPKG reste intact), sans sélection de parcelles, sans API, sans réseau.

## Source runtime

Réutilise la découverte de MVP-03A (`visible-map-inspector.js`, `locate()` partagé avec `capture()`) : Map Leaflet → layer cadastral VectorGrid actif (`map._layers`, score identique) → caches déjà en mémoire `_vectorTiles` (+ `_tiles[clé].coords`), `_tileZoom`. Par tuile : `_features` (entrées `layerName = …parcelle…` uniquement) sinon `_layers` ; géométrie = `_parts` (`leaflet-pixel-parts`, anneaux de points `{x,y}` en pixels de tuile). Seuls les `Polygon` sont lus. Aucune propriété de getter appelée, aucune requête, aucune modification de la Map.

## Pipeline de coordonnées

```
_parts (px locaux de la tuile)
  × zoomScale = map.getZoomScale(map.getZoom(), layer._tileZoom)
  + origine de tuile = coords·tileSize·zoomScale − map.getPixelOrigin()   (point de layer)
  → map.layerPointToContainerPoint(...)                                    (décalage du pane)
  = pixels du conteneur Leaflet : x ∈ [0,largeur], y ∈ [0,hauteur], Y vers le bas
```

- Viewport : `map.getSize()` (repli : `clientWidth/clientHeight` du conteneur). Le SVG a `width`, `height`, `viewBox="0 0 W H"` exacts.
- Aucune latitude/longitude n'est calculée ni écrite. Les tuiles d'un autre niveau de zoom que `_tileZoom` sont ignorées.
- Le rapport conserve la **méthode** (`pixelOriginMethod`, `transformMethod`, `viewportMethod`), la taille de tuile, le zoom, le zoomScale et des compteurs — jamais la valeur d'une origine.

## Clipping

`visible-cadastre-geometry.js` : Sutherland–Hodgman contre le rectangle (aucune dépendance). Chaque anneau est clippé séparément (trous inclus, rendu `evenodd`), l'orientation est conservée, les sommets créés sont exactement sur le bord, les anneaux extérieurs sont supprimés, les anneaux intérieurs inchangés. Chaque fragment est d'abord clippé à `rectangle de sa tuile ∩ viewport` : le buffer de tuile ne produit donc pas de recouvrement.

Limite connue : sur un polygone concave coupé, Sutherland–Hodgman peut laisser des arêtes dégénérées (longeant le bord) ; invisibles en trait seul, à surveiller si un remplissage est ajouté.

## Déduplication et fragments

Clé de regroupement **en mémoire uniquement** (jamais exportée, journalisée, rapportée) : 1) id de feature du runtime (clé de `_features` si ce n'est pas un `_leaflet_id`, ou `feature.id`) ; 2) valeur cadastrale stable (`idu`, `id`, ou insee/section/numéro) ; 3) empreinte géométrique déterministe (grille 0,1 px, invariante au point de départ).

- Même clé + même empreinte dans la même tuile : doublon, ignoré.
- Même clé dans plusieurs tuiles : fragments complémentaires. Ils sont fusionnés en retirant les arêtes de coupe de tuile communes (arêtes axiales opposées qui se recouvrent, tolérance 0,15 px), puis rechaînés en anneaux. Si le rechaînage n'est pas propre, **les anneaux d'origine sont tous conservés** (aucune perte).
- Une parcelle logique → un `<path>` (composé d'anneaux, `fill-rule="evenodd"`).

Limite : sans identifiant, deux fragments d'une même parcelle coupée n'ont pas la même empreinte et restent deux chemins (arête de coupe visible). Les identifiants sont censés être présents (`getFeatureId`) ; le diagnostic compte les clés par niveau (`id / property / geometry`).

## ExportDocument et SVG

`gpkg-svg/core/viewport-export.js` : `prepareViewportDocument` → `ExportDocument { meta, layers:[{ id:'layer-cadastre', label:'Cadastre', type:'vector', idPrefix:'cadastre-visible', features:[{polygons}], style }] }` ; `renderViewportDocument` réutilise `buildSvg` (même writer que le GPKG) avec une transformation identité. D'autres couches (fond IGN, urbanisme…) s'ajouteront dans `layers` sans toucher au writer. Style centralisé : `CADASTRE_VIEWPORT_STYLE` (fill none, stroke `#1a1a1a`, 1 px, `non-scaling-stroke`).

Métadonnées : generator, converterSchema (`visible-cadastre/1`), source (`Leaflet runtime / VectorGrid`), zoom, viewportWidth/Height, featureCount, exportDatetime. Rien d'autre. IDs : `cadastre-visible-1…N`. Fichier : `mon-territoire-cadastre-visible-YYYYMMDD.svg`.

## Modèle de sécurité

- Monde MAIN : lit la mémoire de la page et envoie un fait `visible-cadastre` ne contenant que des anneaux en pixels du viewport + compteurs + noms de méthodes. Aucun id, tuile x/y, propriété, coordonnée géographique.
- Monde isolé : `visible-cadastre-export.js` valide à schéma fermé (champs exacts, points dans le viewport, plafonds 20 000 entités / 256 anneaux / 1,5 M sommets). Le fait générique `validatePageFact` délègue à ce validateur avant le contrôle générique (les tableaux de géométrie dépassent légitimement son plafond).
- Un fait de géométrie n'est exploité que si l'utilisateur vient de cliquer (`exportPending`) ; un fait forgé par la page ne télécharge rien. Les demandes `status` / `export` sont les seules valeurs acceptées.
- Aucune requête (ni fetch, XHR, Worker, rejeu d'URL PBF), pas de cookies/stockage/debugger. Permissions : `["activeTab"]` uniquement. Tests : `privacy-audit.test.js`, `visible-cadastre-*.test.js`.

## UI

Produit : Carte → **Export de la carte visible** (bouton actif seulement si Map + cadastre actif + géométrie exploitable ; sinon « Activez la couche Cadastre. » ou « Cadastre visible non détecté. ») → Export cadastre depuis GeoPackage → Diagnostic (▸ CADASTRE VISIBLE, ▸ Outils de développement). La disponibilité est interrogée toutes les 3 s en mémoire (sans effet sur la carte). Le diagnostic affiche viewport, compteurs (cached / unique / visible / exported / clipped / duplicates) et méthodes.

## Limites

- Seul `leaflet-pixel-parts` est exploité ; `leaflet-rings` / `leaflet-latlngs` / MVT directs ne le sont pas (« non détecté »).
- Tuiles uniquement du niveau `_tileZoom` courant ; pendant une animation de zoom l'état peut être transitoire : réessayer après stabilisation.
- Tuiles encore non chargées : leur zone est absente du SVG.
- Le repère « origine = coin NO de la tuile » des `_parts` est celui supposé d'après MVP-03A ; il est à confirmer par le test réel (superposition).
- Pas de fond, pas de géoréférencement, pas d'autres couches (MVP-03C+).

## Protocole de test réel

1. `npm run build`, recharger l'extension (`tools/probe/dist`), ouvrir un onglet Mon Territoire neuf.
2. Activer le cadastre, attendre le chargement, ne plus bouger la carte. Le bouton « Exporter le cadastre visible en SVG » doit devenir actif (sinon lire le message).
3. Cliquer ; vérifier le téléchargement `mon-territoire-cadastre-visible-YYYYMMDD.svg` et le résumé Diagnostic → CADASTRE VISIBLE (viewport = taille de la carte ; visible features < unique features ; clipped > 0 si des parcelles touchent le bord).
4. Ouvrir le SVG (Inkscape) : calque « Cadastre », dimensions = viewport, contours alignés avec la carte à l'écran (capture d'écran en transparence). Chercher : décalage constant (origine/pane), facteur d'échelle (zoom fractionnaire), doubles contours ou traits parasites sur les coutures de tuiles (fusion).
5. Répéter après un zoom entier et un déplacement ; avec un zoom fractionnaire si possible.
6. Vérifier que le SVG ne contient ni identifiant, ni coordonnée géographique, ni x/y de tuile. Ne pas versionner le SVG.
7. Reporter le résultat (alignement, compteurs, anomalies). MVP-03B ne passe `VALIDATED_IN_REAL_BROWSER` qu'à l'issue de ce test.
