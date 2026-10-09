# Architecture proposée — T00

## Décision

MVP-01 sera une extension Chromium Manifest V3 à privilège minimal. Elle
observe la page Mon Territoire Carto déjà ouverte et autorisée, reconstitue
la scène actuellement affichée, puis produit localement un SVG. Elle n'est
ni un client d'API SOGEFI ni un moyen d'élargir les droits de l'utilisateur.

```text
Popup/action ── commande, état, téléchargement ── Service worker
       │                                             │
       └──────────── messages typés ─────────────────┘
                             │
Content script (monde isolé) ── DOM, UI légère, transfert de fichiers
                             │ CustomEvent / postMessage validé
Injected observer (MAIN world) ── Leaflet, fetch/XHR observés, ressources
```

Le `content script` est le point d'entrée et ne dépend pas d'une variable
globale de l'application. Un petit script injecté dans le monde principal,
installé à `document_start`, est l'adaptateur de page : il observe uniquement
ce que la page charge elle-même et, si disponible, l'instance Leaflet créée
par la page. Les messages traversant la frontière MAIN/isolated world sont
des objets sérialisables, schématiquement validés et jamais évalués comme du
code.

Le service worker gère l'action/popup, les permissions déclarées, les
téléchargements et le cycle de vie. Il ne contient pas de logique spécifique
à Leaflet ni de données de session. Le popup est une console de commande :
état de l'observation, inventaire, réglages d'export et commandes « masque »
et « exporter ». Il reste utilisable si le popup est fermé pendant l'analyse.

## Accès à Leaflet et observation

Une instance `L.Map` ne doit pas être recherchée dans des fermetures privées
ou obtenue en modifiant le code applicatif. L'adaptateur adopte trois niveaux,
du plus fiable au repli :

1. intercepter de façon limitée la création d'une carte Leaflet (ou le point
   d'initialisation identifié après la sonde T00), conserver seulement une
   référence en mémoire et écouter `moveend`, `zoomend`, `layeradd` et
   `layerremove` ;
2. utiliser les structures publiques accessibles depuis l'instance capturée :
   taille, zoom, bounds, CRS, panes, layers et `getPixelOrigin()` ;
3. sans instance, dresser un inventaire DOM : `.leaflet-container`, panes,
   éléments `img`, `svg`, `canvas`, transformations CSS et URLs de tuiles.
   Ce mode peut exporter le DOM vectoriel et inventorier les tuiles, mais
   signale qu'il ne peut pas certifier le CRS/bounds exacts.

Le masque est une action séparée, purement visuelle :

```js
document.querySelector('.leaflet-mask-pane')?.style.setProperty('display', 'none');
```

Le rétablissement supprime uniquement cette propriété locale (ou la restaure
à sa valeur initiale mémorisée). Cette opération ne lit ni n'écrit
`isAllowed`, `user_data.insees`, contrôles d'accès ou état serveur.

### Sources d'observation retenues

| Source | Rôle dans MVP-01 | Limite |
| --- | --- | --- |
| Adaptateur Leaflet | vérité pour vue, zoom, CRS et couches si capturé | dépend de la sonde d'intégration |
| DOM + MutationObserver | visibilité, ordre des panes, SVG, canvas, images, ajout/retrait de tuiles | ne donne pas le contenu binaire d'une image cross-origin |
| `PerformanceObserver` (`resource`) | inventaire/audit de ressources réellement chargées | URL et timings seulement, pas le corps |
| wrappers ciblés `fetch`/XHR | copie des corps PBF ou raster que la page reçoit normalement | doit être installé avant le chargement concerné |

Les wrappers conservent l'identité et le comportement : `fetch` délègue
immédiatement à l'original puis analyse un `Response.clone()` seulement si
l'URL est admissible. Pour XHR, l'observateur lit `response` après le
chargement seulement lorsqu'il s'agit déjà d'un `ArrayBuffer` ou d'un `Blob`.
Il n'émet aucune requête. Les corps sont plafonnés, indexés par URL normalisée
et évincés en mémoire ; aucune persistance automatique n'est permise.

`chrome.webRequest` n'est pas retenu : en MV3 il est utile pour l'observation
de métadonnées mais ne fournit pas un mécanisme général, léger et pérenne pour
obtenir les corps. Il ne résout donc pas l'export PBF/raster. Un patch global
non ciblé, un débogueur CDP et toute réécriture de réponse sont hors périmètre.

## Pipeline d'export

1. **Snapshot** — au clic, figer une vue logique (taille, pixel origin, zoom,
   bounds, CRS, panes/layers visibles, ressources observées). Attendre une
   période de stabilité bornée ; avertir des tuiles encore en chargement.
2. **Classification** — classer chaque source observée : MVT/PBF, Leaflet SVG,
   canvas, WMS, WMTS, image, inconnue. La preuve (DOM, URL, en-tête déjà vu,
   source-layer) est conservée dans le rapport de couche.
3. **Vectorisation** — décoder les PBF cadastraux retenus, convertir leurs
   géométries, importer les éléments SVG Leaflet sûrs. Les canvas restent
   explicitement raster/inconnus : il ne faut jamais prétendre les vectoriser.
4. **Composition** — créer un SVG `viewBox="0 0 width height"`, groupes
   nommés par couche, et facultativement incorporer les rasters disponibles.
5. **Validation** — contrôler XML, `viewBox`, absence d'URL/secret dans les
   métadonnées, et comptages (tuiles, entités, features écartées).

L'inventaire ne repose pas sur une liste figée de couches SOGEFI. Il assemble
des signaux : pane/ordre Leaflet, nom de layer/source-layer, URL sans query
sensible, type MIME, collection OGC, élément DOM et style. Des règles
spécifiques SOGEFI vivent derrière une interface versionnée
`SogefiAdapter`, avec une stratégie générique en repli. Chaque règle publie
une confiance et sa preuve ; une règle inconnue devient « inconnue », non une
catégorie devinée.

## MVT cadastral : bibliothèque et projection

Le choix est `pbf` + `@mapbox/vector-tile`. Ces deux bibliothèques sont
petites, matures et permettent d'accéder à la couche `cadastre_parcelle`, aux
propriétés `idu`/`insee`, à l'extent et aux géométries MVT sans introduire un
moteur cartographique complet. Leur usage sera isolé dans un module
`mvt-decoder`, afin de pouvoir remplacer le décodeur sans modifier
l'exporteur. Une bibliothèque de clipping polygonal robuste sera ajoutée
uniquement si les fixtures confirment que les fragments bufferisés ne peuvent
pas être résolus avec les primitives déjà choisies ; elle ne doit pas se
substituer au décodeur MVT.

Pour une tuile WebMercator `(z, x, y)` d'extent `E`, un point MVT local
`(u, v)` devient un pixel monde Leaflet :

```text
scale = 256 * 2^z
worldX = (x + u / E) * 256
worldY = (y + v / E) * 256
svgX   = worldX - pixelOriginX
svgY   = worldY - pixelOriginY
```

La formule vaut lorsque `z` est le zoom de la vue. Si le niveau source diffère
du niveau d'affichage, le monde est ramené au zoom de la carte par `2^(mapZ-z)`
avant soustraction de `pixelOrigin`. L'implémentation privilégiera
`map.project(latLng, mapZ)` / `map.getPixelOrigin()` lorsqu'une carte Leaflet
a été capturée ; la formule ci-dessus est l'oracle des tests indépendants.
Pour EPSG:3857, les bounds seront aussi enregistrés en WGS84 et le CRS source
sera déclaré `EPSG:3857` lorsque l'adaptateur peut l'établir.

### Topologie, bords et dédoublonnage

Les coordonnées MVT peuvent dépasser `[0,E]` à cause du buffer. Chaque
fragment est d'abord projeté, puis clippé au rectangle de sa tuile, puis à la
viewport. Les fragments sont agrégés par clé stable :
`provenance + source-layer + idu` (repli : id MVT ; dernier repli : hash
canonique de géométrie et propriétés non sensibles). Les pièces d'une même clé
sont réunies par opération polygonale ; les anneaux intérieurs sont conservés
et l'attribut `fill-rule="evenodd"` est posé. En cas d'échec topologique, le
rapport signale la feature et l'export garde les fragments clippés sans les
dupliquer à l'identique. Les lignes et points suivent le même clipping mais ne
sont pas soumis à l'union polygonale.

Cette stratégie traite multipolygones, trous et objets franchissant une tuile
sans supposer que toutes les tuiles livrent une géométrie complète.

## Raster et SVG autonome

La priorité est de réutiliser le corps reçu par la page et capturé par le
wrapper `fetch`/XHR. Pour les images créées directement par le navigateur,
un canvas de lecture n'est possible que si la page les a chargées CORS-clean ;
sinon il est tainted et l'extension l'indique au lieu de contourner CORS.

Une récupération par le service worker n'est autorisable que comme option
explicite ultérieure, avec permissions de domaines minimales, uniquement pour
une URL déjà observée dans la vue courante, sans cookies/credentials et sans
découverte d'endpoint. MVP-01 ne doit pas en dépendre : elle produit un SVG
autonome seulement pour les octets légitimement capturés ou lisibles. Un
raster indisponible apparaît dans le manifeste d'export, pas comme image vide.

Les octets capturés deviennent des `data:<mime>;base64,...` dans `<image>`.
Des limites configurables protègent le navigateur : plafond par image,
plafond total embarqué, plafond d'entités/points et alerte avant un export
lourd. Les valeurs exactes seront fixées après la sonde de tailles T00, pas
inventées dans le code. Les images gardent leur position et dimensions de
viewport ; l'ordre des groupes suit l'ordre des panes.

## SVG et métadonnées

Le document reste SVG 1.1/2 standard. Les calques Inkscape sont des groupes :

```xml
<g id="cadastre" inkscape:groupmode="layer" inkscape:label="Cadastre">…</g>
```

avec les namespaces `xmlns:inkscape` et `xmlns:mon-territoire-export`.
Chaque groupe a un `id` déterministe, un label humain et une provenance. Les
métadonnées JSON sérialisées dans `<metadata>` contiennent version de schéma,
date ISO 8601, emprise WGS84 et/ou métrique, CRS déterminé, zoom, taille,
résultat de capture et liste de couches (type, provenance assainie, compteur,
confiance). Ni query strings ni en-têtes ni credentials n'y figurent.

## Extensibilité et risques

Le coeur est indépendant de SOGEFI : `scene-snapshot`, `resource-ledger`,
`mvt-decoder`, `geometry-pipeline`, `svg-writer` et `export-report`. Seul
`SogefiAdapter` connaît les sélecteurs, signatures d'URL et heuristiques. Des
fixtures et contrats d'adapter détecteront les changements de l'application.

Les risques majeurs sont l'installation trop tardive de l'observateur, le
transport réel des tuiles, les canvases/images tainted, des formats de couche
inconnus et des changements de DOM/Leaflet. La section « observations de
levée de blocage » de `docs/mvp-01.md` définit les preuves nécessaires avant
de commencer MVP-01.
