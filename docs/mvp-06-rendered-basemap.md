> **MVP-07B** : le panneau décrit dans cette page n’est plus injecté ; commandes dans le popup de l’extension (`mvp-07b-native-extension-ui.md`).

# MVP-06 — Fond cartographique fidèle par capture du rendu visible

## Statut

| Tranche | Statut |
| --- | --- |
| MVP-03B (cadastre visible) | VALIDATED_IN_REAL_BROWSER |
| MVP-05A (parcelles sélectionnées individuelles) | VALIDATED_IN_REAL_BROWSER |
| MVP-06 capture / alignement | VALIDATED_IN_REAL_BROWSER |
| MVP-06 isolation visuelle (première version) | FAILED_REAL_BROWSER_TEST — remplacée par MVP-06B |
| MVP-06B (isolation positive du fond) | VALIDATED_IN_REAL_BROWSER — réserve corrigée par MVP-07 : la capture pouvait précéder le rendu d'une tuile (tuile blanche en bas à droite) |
| MVP-07 (barrière « fond prêt », UI produit, package) | VALIDATED_IN_REAL_BROWSER — voir `mvp-07-final-polish.md` |

## Résultat attendu

Un SVG autonome : `Fond cartographique` (raster PNG incorporé) < `Cadastre` (vectoriel) < `Parcelles sélectionnées`
(vectoriel indépendant), tous dans le même `viewBox="0 0 W H"`. Le fond ne contient ni cadastre, ni sélection, ni
masque, ni contrôles Leaflet, ni popups, ni UI de l'extension.

## Pourquoi la lecture directe des tuiles échoue

Diagnostic réel : `TileLayer` raster, 256×256, 81 tuiles dans le viewport, 0 lisible, 81 illisibles
(`unavailable-cors`, `crossOrigin` non défini). Dessiner une tuile cross-origin sans CORS dans un canvas le « tainte » :
`getImageData`/`toDataURL` lèvent `SecurityError`. MVP-04 le constate et n'incorpore rien ; rien n'est contourné.

## Pourquoi la capture du rendu est différente

`chrome.tabs.captureVisibleTab` ne lit pas les octets des tuiles : il récupère les pixels que le navigateur a **déjà
peints** pour l'onglet. Les règles CORS du canvas ne s'appliquent pas. En contrepartie la capture contient tout ce qui
est peint, d'où l'isolation visuelle ci-dessous, et elle dépend de l'API privilégiée `activeTab`.

## Vérification de l'API (étape A)

Vérifié dans la documentation Chrome (developer.chrome.com, « activeTab » et `tabs.captureVisibleTab`) :

- `captureVisibleTab` exige `<all_urls>` **ou** `activeTab` ; `activeTab` ne déclenche aucun avertissement.
- Les API `tabs` ne sont **pas** disponibles dans un content script : un service worker est nécessaire.
- `activeTab` n'est accordé que par un geste d'extension : clic sur l'icône d'action, élément de menu contextuel,
  raccourci `commands`, suggestion d'omnibox. **Un clic sur un bouton injecté dans la page ne l'accorde pas.** Le
  droit dure jusqu'à la navigation ou la fermeture de l'onglet.
- Les `matches` des content scripts ne tiennent pas lieu de permission hôte pour cet appel.

Conséquence assumée : le bouton de la page seul ne peut capturer le fond que si l'onglet a déjà reçu le droit. D'où :

1. clic sur l'**icône de l'extension** (barre d'outils) : accorde `activeTab` et lance **le même export** (une seule
   action utilisateur) ;
2. clic sur le bouton de la page : tente la capture ; sans droit, export vectoriel + message
   « Fond cartographique non incorporable ; export vectoriel effectué. » suivi de « Cliquez sur l’icône de l’extension
   pour incorporer le fond. ». Si l'icône a déjà été utilisée sur l'onglet, le bouton de la page capture aussi.

Le manifest ajoute `"action"` (sans `default_popup`) et `"background.service_worker"`. Ce ne sont pas des permissions.
`permissions` reste `["activeTab"]` ; ni `host_permissions`, `<all_urls>`, `tabs`, `webRequest`, `debugger`, `storage`.
Si ce modèle se révélait insuffisant en navigateur réel, le verdict deviendrait `CAPTURE_PERMISSION_BLOCKED` : rien
n'est élargi silencieusement.

## Architecture de messagerie

```
icône (geste activeTab) ─► service-worker.js ─ tabs.sendMessage('mte:export-request') ─► content-ui.js
bouton de la page ───────────────────────────────────────────────────────────────────► content-ui.js (même export)

content-ui.js ──événement DOM──► MAIN : visible-capture-isolation.js   (masque, renvoie le rectangle)
rendered-basemap.js : barrière de peinture (2 frames)
rendered-basemap.js ─ runtime.sendMessage('mte:capture-visible-tab') ─► service-worker.js ─ captureVisibleTab
content-ui.js ──événement DOM──► MAIN : restauration (toujours)
rendered-basemap.js : recadrage canvas → data:image/png → couche raster
```

Le monde MAIN seul connaît les objets Leaflet et peut désigner les éléments DOM à masquer ; le monde isolé seul
dispose de `chrome.runtime`. Les faits MAIN → isolé passent par le même validateur à schéma fermé
(`rbmValidateFact`, clés exactes, vocabulaires fermés).

Le service worker est sans état (pas de stockage). Il vérifie : `sender.id` = extension, `sender.tab`, frame 0, origine
`https://carto.monterritoire.fr`, et que l'onglet émetteur est toujours **l'onglet actif** de sa fenêtre
(`tabs.query({active, windowId})`, sans permission `tabs`) avant de capturer au format PNG. Les erreurs sont mappées
vers `api-unavailable | sender-rejected | not-active-tab | permission | capture-failed` ; le texte Chrome n'est jamais
transmis.

## Isolation visuelle

### Échec réel de MVP-06 et cause

Le test en Chromium réel a validé activeTab, `captureVisibleTab`, le recadrage, le DPR, l'ordre des calques et le repli.
Le PNG « Fond cartographique » contenait pourtant l'UI superposée (barre de recherche, compte, colonne de boutons,
mini-carte, panneau de l'extension, habillage). Diagnostic réel : `cadastre 1, selection 1, mask 4, controls 2,
overlays 8, extension 1, rasterLeft 2`.

Cause : stratégie **négative** et limitée au container Leaflet. Seuls étaient masqués les éléments connus
(`.leaflet-control-container`, panes marker/shadow/popup/tooltip, mask, conteneurs cadastre/sélection) trouvés par
`container.querySelectorAll`. Tout ce qui est hors du container (en-tête, recherche, compte, barre flottante,
mini-carte sibling) n'était jamais examiné ; `rasterLeft` n'était qu'un compteur (rasters autres que le fond), sans
effet ; `extension 1` était l'hôte `#mon-territoire-probe-ui` seul ; un descendant qui force `visibility: visible`
échappait au masquage de son parent.

### Stratégie MVP-06B : positive-basemap

Qu'est-ce qui appartient au fond ? Un **keep-set** explicite :

- BASEMAP_RASTER : conteneur du TileLayer identifié (classe TileLayer, tuiles image, pane de fond, non WMS) ;
- THEMATIC_RASTER : autre TileLayer brut (non WMS) avec tuiles image décodées, seulement si le fond est identifié ;
- UNKNOWN_RASTER (WMS, non classé) : **masqué** et compté (prudence : un fond propre prime) ;
- UI_RASTER / MINIMAP_RASTER : masqués (tout ce qui n'est pas keep).

Le plan (`vciPlan`, pur, testable sans navigateur) parcourt le DOM **du document** :

1. membres explicites : racines de l'extension (`data-mon-territoire-export-ui`, `#mon-territoire-probe-ui`), cadastre,
   sélection, mask, contrôles, panes marker/shadow/popup/tooltip, rasters inconnus ;
2. tout élément non lié au keep-set dont le rectangle intersecte celui de la carte est HIDE (position, rôle ARIA, tag
   interactif, classes Leaflet, autre `.leaflet-container` = mini-carte). Jamais le texte ;
3. un ancestor du keep-set, `html`, `body`, le keep et ses descendants ne sont jamais masqués : un parent mixte n'est
   pas masqué, seuls ses descendants HIDE le sont ;
4. après masquage, les descendants qui forceraient `visibility: visible` sont masqués aussi.

Masquage : `visibility: hidden !important` seulement (pas de display:none, pas de suppression, aucun appel métier).
Restauration exacte (valeur, priorité, attribut style absent), watchdog, transaction inchangée :
snapshot → isolate → double RAF → capture → restore → double RAF → crop → export.

Abandon → repli vectoriel : aucun fond identifié (`no-basemap`), fond ambigu (`ambiguous-basemap`), fond non rendu
(`basemap-hidden`). Confiance : `high` (rien d'inconnu), `medium` (éléments inconnus masqués ou raster inconnu).

Diagnostic « CAPTURE DU FOND » : visual isolation mode, basemap surfaces kept, thematic raster kept, vector overlays,
controls, application UI, extension UI, minimaps, markers/popups/tooltips hidden, unknown intersecting elements,
isolation confidence, puis les champs existants. Compteurs uniquement : ni URL, coordonnée, tuile, identifiant, nom.

## Barrière de peinture

`rbmPaintBarrier(raf, 2)` : deux `requestAnimationFrame` après le masquage (un pour valider, un pour être sûr), avec
délai maximal. Même barrière après la restauration. Séquence : masquer → peindre → capturer → restaurer → repeindre.

## Recadrage et DPR

Le facteur d'échelle vient de la capture elle-même : `image.width / window.innerWidth` (contrôle croisé sur la
hauteur, tolérance 1 %), jamais de `devicePixelRatio` seul (zoom navigateur, mise à l'échelle OS). Rectangle = boîte
de contenu du conteneur Leaflet (`getBoundingClientRect` + `clientLeft/Top`, taille `clientWidth/Height`).
Sortie = `round(w·r) × round(h·r)`. Le fond n'est **pas** incorporé (export vectoriel) si :

- le rectangle déborde du viewport de l'onglet (`map-clipped`) ;
- zoom de pincement actif (`page-zoomed`) ;
- ratio X/Y incohérent (`ratio-mismatch`) ou hors 0,5–8 ;
- le conteneur est transformé/mis à l'échelle (`map-transformed`) ou sa taille diffère de `map.getSize()` ;
- la vue (taille, origine de pixels, zoom) a changé entre le masquage et la restauration (`view-changed`) ;
- l'image dépasse 2^25 pixels.

L'image est placée en `x=0 y=0 width=W height=H` de la même `viewBox` que le cadastre ; le schéma d'export et le writer
vérifient en plus l'aspect, sans recalage manuel.

## Restauration transactionnelle

Pour chaque élément : valeur et priorité précédentes de `visibility`, présence de l'attribut `style`. La restauration
remet exactement cet état (attribut supprimé s'il n'existait pas). Un masque déjà caché par l'utilisateur
(`display:none`) le reste. Trois filets : `finally` côté monde isolé (restauration demandée même si le masquage, le
message ou la capture échouent) ; chien de garde de 3 s côté MAIN ; restauration idempotente liée à un identifiant de
transaction (une demande périmée ne touche pas une transaction plus récente). La restauration précède le recadrage et
l'export : un échec de ceux-ci ne peut pas laisser la page modifiée.

## Repli

Capture, message, permission, recadrage, ratio ou schéma en échec → export du Cadastre et des Parcelles sélectionnées
inchangé + « Fond cartographique non incorporable ; export vectoriel effectué. » Ordre des tentatives : composition des
tuiles (MVP-04, si 100 % lisibles) → capture du rendu → vectoriel seul.

## Confidentialité

Mémoire uniquement : capture d'onglet, canvas et PNG ne sont ni stockés ni écrits. Aucune requête ajoutée. Le
diagnostic « CAPTURE DU FOND » ne contient que des booléens, dimensions, ratios et compteurs (API disponible, contexte
activeTab, capture demandée, isolation, synchronisation, dimensions capture/carte/recadrage, ratio, raster incorporé,
restauration, raison du repli) : jamais de coordonnée, tuile x/y, URL, jeton ni identifiant. La signature de vue reste
dans le monde MAIN.

## Limites connues

- La capture contient aussi tout ce qui est peint dans la carte et non masqué : couches raster/WMS additionnelles, et
  éléments DOM d'autres scripts superposés à la carte (non masqués, non comptés pour l'instant).
- Sélection dessinée sur un canvas partagé : le conteneur du renderer entier est masqué (peut inclure d'autres tracés).
- `innerWidth` inclut une éventuelle barre de défilement ; non rencontré sur une carte plein cadre, à vérifier.
- `activeTab` expire à la navigation ; sur navigation SPA le comportement est à confirmer.
- Le texte « Fond : incorporable » est affiché après usage de l'icône (le droit n'est pas observable sans essai).
- Le fond reste un raster (rendu navigateur) : aucune vectorisation.

## Investigation vectorielle (secondaire, passive)

Aucun nouveau script lu, aucune requête. Éléments déjà observés : `TileLayer`, pane `raster`, XYZ, `jpeg`,
`rendering: raster-tiles`, premier parti ; `maplibregl` non, `mapboxgl` non, pont GL non ; `VectorGrid` présent mais
utilisé par le cadastre. Style, fournisseur nominal, MVT/PBF pour le fond, `style.json` : **UNKNOWN**. Les 133 scripts
externes n'ont pas été lus. Conclusion : aucune preuve de fond vectoriel ; ne pas déduire « vectoriel disponible » d'une
provenance OSM supposée.

## Architecture future (non implémentée)

**Mode fidèle** — fond raster capturé + cadastre vectoriel + sélection vectorielle (MVP-06).

**Mode vectoriel** — fond reconstruit depuis des données publiques (routes, bâtiments, hydrographie, végétation,
toponymes) + cadastre + sélection. Il n'a pas à être visuellement identique au fond Mon Territoire ; il exigerait une
source publique identifiée et ses propres licences/attributions.

## Protocole de test en navigateur réel

1. `npm run build`, recharger `tools/probe/dist` dans `chrome://extensions` (le manifest a changé : service worker +
   icône d'action ; vérifier qu'aucune permission supplémentaire n'est affichée).
2. Ouvrir Mon Territoire, activer le cadastre, sélectionner des parcelles.
3. Cliquer sur le bouton de la page **sans** avoir cliqué l'icône : attendu, export vectoriel + message avec indication
   d'icône ; page intacte.
4. Cliquer sur l'**icône** de l'extension : attendu, un seul SVG avec 3 calques Fond / Cadastre / Parcelles sélectionnées.
5. Pendant l'export, la carte, la sélection, le masque, les contrôles et l'UI doivent réapparaître à l'identique ;
   la sélection existe toujours ; l'état du masque choisi par l'utilisateur est conservé.
6. Inkscape : image à (0,0), alignée sur le cadastre sans recalage ; aucune copie du cadastre/sélection/contrôles/UI dans
   le raster ; pas de lien distant.
7. Répéter : zoom navigateur 90/110/125/150 %, écran HiDPI, carte partiellement hors viewport (attendu : repli),
   panoramique pendant l'export (attendu : repli `view-changed`), onglet changé pendant l'export.
8. Console : aucune erreur ; réseau : aucune requête cartographique ajoutée.
