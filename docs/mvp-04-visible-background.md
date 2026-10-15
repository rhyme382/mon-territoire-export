# MVP-04 — Fond cartographique principal + identification sûre de la sélection

Statut : **implémenté, test navigateur réel non effectué** (`READY_FOR_REAL_BACKGROUND_TEST`). MVP-04 n'est pas validé tant que ce test n'a pas eu lieu.

| Jalon | Statut |
| --- | --- |
| MVP-03A / 03B / 03C | VALIDATED_IN_REAL_BROWSER |
| MVP-04 | READY_FOR_REAL_BACKGROUND_TEST — le fond est finalement obtenu par capture du rendu (MVP-06, VALIDATED_IN_REAL_BROWSER ; MVP-06B isolation propre VALIDATED_IN_REAL_BROWSER, réserve corrigée par MVP-07) |

## SVG cible

| Ordre | Calque Inkscape | Type |
| --- | --- | --- |
| 1 (bas) | Fond cartographique | raster (PNG embarqué `data:`) |
| 2 | Cadastre | vectoriel |
| 3 (haut) | Parcelles sélectionnées | vectoriel |

Même `width`, `height`, `viewBox` et repère viewport (pixels CSS, origine en haut à gauche) pour les trois calques. Aucune URL distante dans le SVG : le writer (`svg-writer.js`) refuse tout `<image>` qui n'est pas un `data:image/(png|jpeg|webp);base64,…`.

## 1. Identification de la sélection (consolidation)

L'heuristique « tout Polygon hors mask » est supprimée (`visible-map-inspector.js`, `vmiSelectionSource`). Preuves, de la plus forte à la plus faible :

1. delta A/B gardé en mémoire (nouveau groupe, groupe modifié → seuls les polygones ajoutés, nouveaux chemins) ;
2. un seul groupe vectoriel de polygones + style overrides sur le VectorGrid cadastral (confiance moyenne) ;
3. polygones isolés d'un seul pane + overrides (confiance basse).

Rejeté : polygone sans preuve de sélection, pane `polygone` seul, groupes « urbanisme », polygones du pane mask. Plusieurs candidats concurrents (`ambiguous-candidates`) : **rien n'est exporté**. Un A/B pris à un autre zoom est ignoré. Le rapport ne contient qu'un vocabulaire fermé (confiance, mécanisme, compteurs).

## 2. Fond cartographique

`tools/probe/visible-background.js` (MAIN world, passif) :

- **Candidat** : couche classée `raster` (TileLayer/GridLayer non WMS, non VectorGrid, non mask) qui détient des éléments image décodés dans `_tiles` pour le `_tileZoom` courant ; la plus basse (pane z-index puis zIndex) gagne ; deux couches au même ordre ⇒ `ambiguous`, rien n'est embarqué. Un WMS n'est jamais pris pour le fond.
- **Position des tiles** : état Leaflet déjà présent (`coords`, `tileSize`, `getZoomScale`, `pixelOrigin`, `layerPointToContainerPoint`), même transformation que le cadastre.
- **Accès aux pixels** : uniquement `drawImage` d'un `<img>` (http(s)/`data:`/`blob:`) ou `<canvas>` déjà décodé vers un canvas temporaire ; lisibilité testée par `getImageData` sur 1×1.
- **Composition** : canvas aux dimensions exactes du viewport (× ratio 1 à 2 selon la résolution native des tiles, jamais d'upsampling), bords bornés au canvas, arêtes alignées sur la grille de sortie (pas de trou entre tiles).
- **Complet ou rien** : toute tile intersectante manquante, non décodée ou illisible ⇒ fond non embarqué (`incomplete`/`cors`/`unreadable`). Un fond troué n'est jamais présenté comme complet.
- **CORS** : `SecurityError` ⇒ tile illisible, constaté et rapporté ; aucun contournement (pas de re-fetch, pas de `crossOrigin`, pas de `new Image`).
- **Repli** : l'export vectoriel (Cadastre + sélection) reste identique ; le message indique « Fond cartographique non incorporable ; export vectoriel effectué. » Verdict dans ce cas : `VECTOR_READY_BACKGROUND_BLOCKED_BY_BROWSER`.

Le côté isolé (`visible-cadastre-export.js`) ne fait pas confiance au MAIN world : schéma fermé, data URI PNG strict, dimensions cohérentes avec le viewport, tiles `complete`/`readable === intersecting`, sinon le fond est rejeté.

## 3. Interface

Un seul bouton : **Exporter la carte visible en SVG**. État :

```
Cadastre : détecté
Sélection : détectée / aucune
Fond : incorporable / non incorporable
```

Le diagnostic « fond » ne contient que des compteurs et noms de méthodes (jamais URL, x/y de tile, coordonnée).

## 4. Garanties

- Aucune nouvelle requête (pas de fetch/XHR/replay/webRequest/debugger), aucune persistance, permissions toujours `["activeTab"]`, aucune host permission.
- Tests : `visible-background.test.js` (identification, WMS, tiles intersectantes, clipping, composition 2×2, CORS, fond incomplet, couche raster, ordre, viewBox, absence d'URL, repli vectoriel, anciens exports) et `visible-selection-identification.test.js`.

## 5. Test navigateur réel à faire

1. Charger l'extension (`npm run build`), ouvrir la carte, ne pas bouger.
2. Vérifier l'état : Cadastre détecté, Fond incorporable / non incorporable.
3. Exporter sans sélection, puis avec sélection.
4. Ouvrir le SVG dans Inkscape : 3 calques dans l'ordre, alignement fond/cadastre/sélection, aucun `http` dans le fichier.
5. Si « non incorporable » : noter la raison (`cors` attendu si les tiles sont cross-origin sans CORS) ; c'est alors `VECTOR_READY_BACKGROUND_BLOCKED_BY_BROWSER`, sans contournement.
