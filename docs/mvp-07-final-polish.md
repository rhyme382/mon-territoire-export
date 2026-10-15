# MVP-07 — Finalisation produit et packaging Chromium

## Statut

| Jalon | Statut |
| --- | --- |
| MVP-03B cadastre visible → SVG vectoriel | VALIDATED_IN_REAL_BROWSER |
| MVP-05A parcelles sélectionnées → objets vectoriels indépendants | VALIDATED_IN_REAL_BROWSER |
| MVP-06 capture / alignement (`captureVisibleTab`, `activeTab`, crop, DPR) | VALIDATED_IN_REAL_BROWSER |
| MVP-06B fond propre (isolation positive) | VALIDATED_IN_REAL_BROWSER — réserve corrigée par MVP-07 : la capture pouvait précéder le rendu d'une tuile |
| MVP-07 barrière « fond prêt » / finition (tuile blanche corrigée) | VALIDATED_IN_REAL_BROWSER |
| MVP-07A nettoyage UI produit | VALIDATED_IN_REAL_BROWSER |
| MVP-07B popup natif `chrome.action` | VALIDATED_IN_REAL_BROWSER |

Test réel final (v0.2.0, Chromium) : aucune UI injectée dans la page ; popup fonctionnel ; export de la carte visible
fonctionnel ; fond propre et complet ; cadastre vectoriel aligné ; parcelles sélectionnées vectorielles et
indépendantes ; masque pilotable depuis le popup. SVG vérifié : 3 calques, 1 image raster de fond, chemins vectoriels
pour le cadastre et la sélection. Le SVG réel n'est pas versionné.

## UX finale

- aucune interface injectée dans Mon Territoire ;
- clic sur l'icône de l'extension → popup ;
- **Exporter la carte visible** (SVG) ;
- **Masquer / Afficher le masque** ;
- import d'un GeoPackage local ;
- export GeoPackage → SVG (traitement local).

## Architecture du SVG

| Calque | Nature |
| --- | --- |
| Fond cartographique | raster |
| Cadastre | vectoriel |
| Parcelles sélectionnées | vectoriel |

Le fond raster est le rendu visible capturé (`captureVisibleTab`, recadré sur la carte, avec isolation du fond) ; le
cadastre et la sélection restent des chemins vectoriels, indépendants du fond.

## A — Autopsie de la tuile blanche

Cause racine : **INFERRED** (lecture du chemin de code ; aucun relevé runtime réel). Confirmation = étapes 5 à 7 du test réel.

Enchaînement avant MVP-07 : clic (ou icône) → `exportPending` → fait cadastre → `rendered.capture()` → isolation
(`visibility:hidden`) → double `requestAnimationFrame` → `captureVisibleTab`.

Rien dans cet enchaînement ne vérifiait l'état des tuiles du fond. Une tuile `<img>` Leaflet peut être :

- créée mais pas encore décodée (`complete === false`) — typique juste après un pan/zoom ;
- terminée mais en échec (`complete === true`, `naturalWidth === 0`) ;
- décodée mais en fondu d'entrée (Leaflet fait monter `style.opacity` de 0 à 1 en ~200 ms).

Le double `requestAnimationFrame` garantit seulement que le style d'isolation est peint ; il n'attend aucune tuile. Un
export lancé juste après un déplacement pouvait donc photographier une tuile encore blanche. Une entrée de `_tiles` ne
prouve pas non plus que l'image soit rendue : le critère ci-dessous ne s'appuie que sur l'élément DOM.

## B/C — Barrière « fond prêt » (MAIN world, passive)

`createBasemapReadiness` (`visible-capture-isolation.js`) est appelé **avant** l'isolation :

```
clic / icône → attente fond prêt → isolation → double RAF → contrôle léger → captureVisibleTab → restauration → crop → SVG
```

Pour chaque `<img>` des conteneurs du fond (et des rasters thématiques conservés) qui **intersecte réellement** le
rectangle de la carte :

| État | Critère |
| --- | --- |
| READY | `complete` ∧ `naturalWidth > 0` ∧ opacité inline ≥ 0,99 |
| LOADING | `!complete`, ou `complete` sans `src` encore, ou fondu en cours |
| ERROR | `complete` ∧ `naturalWidth === 0` avec une source |

Aucune lecture de pixel, aucun `src` assigné, aucune image créée, aucun `fetch` : la barrière lit l'état d'éléments que
la page possède déjà et écoute leurs événements `load`/`error` existants (phase de capture, sans les consommer). Un
sondage borné (100 ms) sert de filet.

| Cas | Comportement |
| --- | --- |
| Toutes les tuiles READY | résolution immédiate |
| LOADING | attente passive, au plus 4 s |
| Délai dépassé | `basemap-timeout` → export vectoriel sans fond (jamais de trou incorporé) |
| ERROR | `basemap-error` → export vectoriel sans fond ; aucune boucle, aucun re-téléchargement |
| Vue modifiée pendant l'attente | `view-changed` → export vectoriel sans fond |
| Tuile thématique en erreur | ignorée (hors couverture normale), seule une tuile thématique LOADING retarde |

Si le conteneur du fond ne livrait aucun `<img>` (conteneur incorrect, tuiles non-`img`), `visible === 0` est traité comme LOADING : chaque export attendrait 4 s puis retomberait en vectoriel. Symptôme à surveiller au test réel : « Fond : chargement… » ~4 s puis export sans fond systématique.

Une tuile dont l'erreur est suivie d'un `errorTileUrl` Leaflet repasse LOADING puis READY : le fallback visuel de
Leaflet est donc respecté (le jugement est différé de 30 ms après chaque événement).

## F — Contrôle juste avant la capture

Après l'isolation et le double RAF, un `check` instantané vérifie que les tuiles sont toujours READY et que la vue est
celle de l'attente. Si les tuiles ont été renouvelées : restauration, une seule nouvelle attente (2 tentatives au
maximum), puis repli vectoriel sûr. Si la vue a bougé : repli immédiat. Les gardes MVP-06 (restauration en `finally`,
watchdog, `viewUnchanged`, géométrie du crop) sont conservées.

## G — Diagnostic interne

Compteurs seulement : tuiles visibles / prêtes / en chargement / en erreur, durée d'attente, délai dépassé oui/non,
nombre de tentatives. Aucun x/y de tuile, aucune URL, aucune coordonnée, aucun jeton. Le rapport reste dans le texte
interne `#vb-diagnostic`.

## H/I — Interface produit

- Les sections **Diagnostic** et **Outils de développement** ne sont plus rendues.
- Le balisage et les moteurs de diagnostic restent dans le code (tests, maintenance) : ils sont construits dans un
  élément détaché, jamais rattaché à la page ni au shadow root du produit.
- Contrôles produit : *Carte* (masquer/afficher le masque), *Export de la carte visible* (bouton, messages d'état
  `Fond : chargement…` puis `Fond : prêt`), *Export cadastre depuis GeoPackage* (fichier + export SVG).
- Indication en langage simple : « Pour incorporer le fond cartographique, utilisez l’icône de l’extension. »

## J–M — Package

Voir [`packaging.md`](packaging.md). Version : `0.2.0` conservée (supérieure à la politique initiale 0.1.0).
Permissions : exactement `["activeTab"]`, aucun `host_permissions`.

## Test réel final requis

Limite : les compteurs de tuiles ne sont visibles que dans le diagnostic interne (non affiché). Si l'étape 7 montre encore une tuile blanche alors que l'interface annonce « Fond : prêt », la cause racine inférée ou le critère READY est à revoir ; l'interface produit ne permet pas de les distinguer.

1. Recharger l'extension non empaquetée depuis `tools/probe/dist` (ou depuis le ZIP décompressé).
2. Recharger Mon Territoire.
3. Déplacer/zoomer pour forcer de nouvelles tuiles.
4. Cliquer immédiatement l'icône de l'extension.
5. L'extension doit attendre le fond (`Fond : chargement…` puis `Fond : prêt`).
6. Ouvrir le SVG.
7. Inspecter les bords bas/droite : aucune tuile manquante.
8. `Fond cartographique` seul : raster propre et complet.
9. `+ Cadastre` : alignement vectoriel exact.
10. `+ Parcelles sélectionnées` : objets vectoriels indépendants.
11. Vérifier l'absence de menu Diagnostic / Outils de développement.


> **MVP-07B** : l'interface produit n'est plus injectée dans la page ; voir `mvp-07b-native-extension-ui.md`. Les passages ci-dessus sur le panneau de la page sont historiques.
