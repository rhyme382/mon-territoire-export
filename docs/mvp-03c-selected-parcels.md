# MVP-03C — Parcelles sélectionnées : identification puis export (2ᵉ calque)

Statut : **VALIDATED_IN_REAL_BROWSER** (test A/B réel : la sélection est un nouveau groupe GeoJSON/vectoriel du pane `polygone`, corroboré par les style overrides du VectorGrid cadastral ; SVG Inkscape « Parcelles sélectionnées » + « Cadastre » alignés).

| Jalon | Statut |
| --- | --- |
| MVP-03A | VALIDATED_IN_REAL_BROWSER |
| MVP-03B | VALIDATED_IN_REAL_BROWSER |
| MVP-03C | VALIDATED_IN_REAL_BROWSER |

## Question

Que change l'état Leaflet quand on passe de **A** (aucune parcelle sélectionnée) à **B** (plusieurs parcelles mises en évidence), sans bouger ni zoomer la carte ? Si la géométrie est déjà en mémoire, elle est exportée comme second calque du SVG viewport.

Hypothèses à départager (aucune n'est présumée ; les layers 291 WMS, 292 VectorGrid, 293 `overlayPane` vus en 03A existent déjà avant toute sélection) :

- des `Polygon`/`GeoJSON` ajoutés à la carte ;
- un `LayerGroup`/`FeatureGroup` **déjà présent** (p. ex. 293) qui reçoit des enfants ;
- un changement de paramètres du WMS (rendu raster côté serveur) ;
- un renderer ou un changement DOM seul.

## Protocole A/B (Diagnostic → SÉLECTION PARCELLAIRE)

1. Même viewport, masque masqué, cadastre actif, **aucune** parcelle mise en évidence → **Capture A — Aucune sélection**.
2. **Ne pas déplacer ni zoomer.** Sélectionner plusieurs parcelles par l'interface normale de Mon Territoire, attendre l'affichage bleu/cyan → **Capture B — Parcelles sélectionnées**.
3. **Comparer A/B** : affiche le delta et la conclusion. **Copier le rapport de sélection** produit le JSON sanitisé.

L'extension ne sélectionne rien, n'appelle aucune API et ne modifie pas la carte. Un viewport différent entre A et B (zoom ou taille) donne `INSUFFICIENT_EVIDENCE`.

## Ce qui est comparé

Pour chaque layer de `map._layers` (hors polygones du masque) : id Leaflet, classe (réutilise la classification 03A), rôle (`wms`, `vectorgrid`, `tile`, `renderer`, `path`, `group`, `other`), pane, nombre d'enfants, de chemins/polygones/sommets **descendants** d'un groupe, caches de tuiles, surcharges de style VectorGrid, signature de style et de paramètres WMS (hachages opaques, jamais copiés dans le rapport).
Les chemins (`Path`/`Polygon`) sont **agrégés** (totaux, par pane, rattachés à un groupe ou non) : une sélection de centaines de polygones n'est donc pas tronquée par la limite d'inventaire. Autres signaux : renderers (`Canvas`/`SVG`, renderers par pane), compteurs DOM (`svg`, `canvas`, `svg path`, enfants par pane).
Un layer qui existe en A et reçoit des enfants en B est détecté (`groupsChanged`) : la comparaison ne se limite pas aux nouveaux ids.

## Classifications

Ordre de priorité (la première qui s'applique) :

| Code | Preuve | Exportable |
| --- | --- | --- |
| `INSUFFICIENT_EVIDENCE` | capture manquante, carte introuvable, viewport différent | non |
| `LEAFLET_GROUP_SELECTION` | un groupe présent en A gagne des chemins en B | oui |
| `LEAFLET_VECTOR_SELECTION` | nouveaux chemins/polygones, ou nouveau groupe contenant des chemins | oui |
| `WMS_SELECTION` | paramètres/URL d'un WMS modifiés, ou nouveau layer WMS | non (tranche ultérieure) |
| `RENDERER_SELECTION` | renderer ajouté/retiré ou famille changée, sans autre delta | non |
| `DOM_SELECTION` | seuls `svg`/`canvas`/`path`/enfants de pane changent | non |
| `NO_SELECTION_LAYER_FOUND` | aucun delta structurel | non |

Rapport : `selectionComparison { available, layersAdded, layersChanged, groupsChanged, rendererChanges, geometryChanges, likelySelectionLayer, conclusion }` (+ `wmsChanges`, `domChanges`, `sameViewport`). `conclusion = { code, exportable, evidence[] }`. Uniquement des compteurs, classes et ids Leaflet de layers — jamais d'identifiant cadastral, de valeur de propriété, de coordonnée, de bounds, de x/y de tuile ni de valeur de paramètre WMS.
Cas limite connu : une sélection faite par `VectorGrid.setFeatureStyle` (surcharge de style sur le cadastre) n'a pas de calque propre ; elle apparaît comme `styleOverridesDelta` et n'est pas exportée.

## Pipeline vectoriel

```
map._layers (Polygon, hors pane « mask »)
 -> anneaux projetés Leaflet (_rings), validés contre latLngToLayerPoint ; sinon projection publique des _latlngs ; sinon _parts
 -> layerPointToContainerPoint            (même repère que le cadastre 03B)
 -> déduplication en mémoire              (id feature > propriété > empreinte géométrique)
 -> clipping Sutherland–Hodgman au viewport exact
 -> ExportDocument.layers[1] « Parcelles sélectionnées »
 -> writer SVG générique
```

- Clé de déduplication : même clé + même géométrie = doublon supprimé ; même clé + géométrie différente = fragments complémentaires conservés dans la même entité. Les clés ne sortent jamais du lecteur de page.
- Les polygones du pane `mask` sont ignorés ; les entités des tuiles VectorGrid (cadastre) ne sont pas dans `map._layers` et ne sont donc jamais prises pour une sélection.
- `selection.diagnostics.paneCounts` indique dans quels panes les polygones ont été trouvés, pour vérifier en réel qu'on exporte bien la sélection et rien d'autre.

## Export produit

Un seul bouton : **Exporter la carte visible en SVG**.

```
SVG
├── Cadastre                 (id layer-cadastre, chemins cadastre-visible-N, contours fins, sans remplissage)
└── Parcelles sélectionnées  (id layer-selected-parcels, chemins selection-N, au-dessus du Cadastre)
```

- Style centralisé (`SELECTION_VIEWPORT_STYLE`) : contour bleu 2,5 px + remplissage cyan à 25 % (`fill-opacity`), éditable dans Inkscape. Pas de hachures pour cette version.
- Même `width`/`height`/`viewBox` que le cadastre ; ids neutres ; métadonnées : `featureCount`, `selectedFeatureCount` (compteurs seulement).
- Le modèle reste `ExportDocument { meta, layers[] }` ; le writer n'a aucun cas particulier à deux calques (Fond IGN, Urbanisme, Servitudes, Randonnée, Annotations s'ajouteront en empilant des layers).
- **Sans sélection** : export du Cadastre seul. **Sélection WMS/raster/DOM seulement** : l'export Cadastre n'est pas bloqué ; Diagnostic indique `sélection détectée (WMS_SELECTION) : pas encore exportable`. Aucune vectorisation d'un raster.
- Compteurs après export : `selectedFeaturesDetected`, `selectedFeaturesVisible`, `selectedPathsExported`, `selectedFeaturesClipped`.

Limite connue : sans A/B, l'export considère comme sélection tout `Polygon` de `map._layers` hors pane masque. Si Mon Territoire place d'autres polygones (contour de commune, dessin utilisateur), le test réel le fera apparaître dans `paneCounts` et il faudra restreindre au pane/groupe désigné par `likelySelectionLayer`.

## Confidentialité et sécurité

Inspection de l'état déjà chargé uniquement. Aucun appel API (`getParcelleContourPCI`, `getGpkFile`, `showParcelles`…), replay, `fetch`, XHR, modification de requête, des contrôles d'autorisation, de `isAllowed` ou de `user_data.insees` ; aucun accès MAJIC/propriétaires. Lecture par propriétés de données (aucun getter de la page). Les captures A/B restent en mémoire du content script, fermées par un schéma strict, sans persistance. Permissions : `["activeTab"]` exactement, aucune nouvelle. Garde-fous : `privacy-audit.test.js` (motifs interdits dans tous les modules 03C), `same-world-bindings.test.js` (source + dist).

## Protocole de validation réelle

1. Recharger l'extension (`npm run build`, dossier `tools/probe/dist`), ouvrir Mon Territoire, activer le cadastre, masquer le masque.
2. A/B comme ci-dessus ; noter la conclusion et `likelySelectionLayer` (pane, rôle, `existedInA`).
3. Sans bouger la carte : **Exporter la carte visible en SVG**. Ouvrir dans Inkscape : deux calques, « Parcelles sélectionnées » au-dessus de « Cadastre », parcelles sélectionnées au bon endroit, coupées au bord si partiellement hors écran.
4. Comparer `selectedFeaturesVisible` au nombre de parcelles visuellement sélectionnées ; contrôler `paneCounts`.
5. Si la conclusion est `WMS_SELECTION`/`RENDERER_SELECTION`/`DOM_SELECTION` : joindre le rapport sanitisé ; l'export de la sélection est reporté, le cadastre reste exporté.
6. Vérifier un export sans sélection (Cadastre seul), le bouton masque et l'export GeoPackage.
