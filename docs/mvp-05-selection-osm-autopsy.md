# MVP-05 — Sélection parcellaire individuelle et autopsie du fond cartographique

Statut : **A VALIDATED_IN_REAL_BROWSER (sélection individuelle, objets vectoriels indépendants). B : investigation passive, aucune reconstruction du fond.**

Légende : **OBSERVED** (relevé réel rapporté par les tranches précédentes, ou mesuré par un test), **INFERRED** (déduit, à confirmer), **UNKNOWN** (aucune preuve).

| Jalon | Statut |
| --- | --- |
| MVP-03B / 03C / 04 | VALIDATED_IN_REAL_BROWSER (03C : parcelles regroupées en un seul objet) |
| MVP-05A sélection individuelle | VALIDATED_IN_REAL_BROWSER (parcelles sélectionnées = objets vectoriels indépendants) |
| MVP-05B provenance du fond | INSTRUMENTÉE (rapport passif) — en attente du relevé réel |

---

## 1. Mécanisme réel de sélection

- **OBSERVED** (03C réel) : une sélection crée un nouveau groupe GeoJSON dans le pane `polygone` : 1 polygone, 2 anneaux, 125 sommets. Le VectorGrid cadastral gagne `styleOverridesDelta +52`. Le SVG réel confirme qu'un GeoJSON agrégé donne un seul `path`.
- **INFERRED** (code source de Leaflet.VectorGrid, relu sur la branche publique ; la version embarquée par le site n'a pas été lue) :
  - `setFeatureStyle(id, style)` écrit `this._overriddenStyles[id] = style` (le style peut être indexé par nom de couche) ;
  - `resetFeatureStyle(id)` supprime l'entrée ;
  - `tile._features[id] = { layerName, feature }` utilise la **même clé** (`getFeatureId`) dans chaque tuile qui détient un fragment ;
  - la clé de `_features` n'est pas forcément `feature.id` : l'association utilise la clé de la table.
- **UNKNOWN** : si les 52 overrides sont 52 parcelles distinctes. Rien ne l'établit : l'agrégat observé (1 polygone, 2 anneaux, 125 sommets) peut être un contour fusionné ou une seule parcelle trouée, et les overrides peuvent inclure d'autres clés (anciennes sélections, survol, objets non cadastraux). Le diagnostic `unmatched`/`matched` tranchera.

## 2. Relation overrides / features (implémentation)

```
cadastre._overriddenStyles  ──clé──►  tile._features[clé] (couche /parcelle/i)  ──►  _parts de la tuile
        │                                                                              │
   style (classe opaque)                         même moteur que le Cadastre : tuile → viewport, clipping, fusion des coutures, dédup
```

Un override **n'est jamais** pris pour une sélection. Décision (`vcgSelectIndividual`, `visible-cadastre-geometry.js`) :

1. **Candidats** : toutes les clés d'override du VectorGrid cadastral ; si une capture **A** existe, seulement les clés **apparues depuis A** (les overrides préexistants sont écartés). Les clés restent en mémoire du lecteur MAIN.
2. **Appariement** : une clé est « matched » si elle nomme une feature d'une couche `parcelle`. Une clé absente des tuiles, ou qui nomme une couche non cadastrale, est « unmatched ». Une clé qui nomme à la fois une parcelle et un objet non cadastral → `id-layer-collision` (repli).
3. **Preuve de sélection** : le polygone agrégé (GeoJSON) sert d'**oracle d'appartenance**. Pour chaque feature candidate : un point intérieur (milieu de la plus large corde d'une ligne de balayage, trous respectés) doit être dans l'agrégat (even-odd). Un override hors de l'agrégat (survol, autre mise en évidence) est **exclu**, pas exporté.
4. **Couverture** : des points d'échantillonnage dans l'agrégat ∩ viewport doivent être couverts par les features retenues (≥ 95 %). **Tolérance** (la tuile MVT quantifiée et le GeoJSON projeté ne coïncident jamais au pixel près) : les échantillons à moins de 1,5 px du contour de l'agrégat ne sont pas jugés ; l'appartenance accepte un point intérieur à moins de 1 px du contour ; c'est le plus grand fragment d'une feature qui décide (les fragments < 4 px², coutures et buffers, sont ignorés). Sinon (une parcelle sélectionnée sans override, tuile manquante) → `incomplete-coverage` et repli : on n'exporte pas un sous-ensemble silencieux.
5. **Une seule classe de style** parmi les features retenues, sinon `ambiguous-style-groups`.
6. **Sans agrégat** : seulement si une capture A existe et que les clés nouvelles sont d'une seule classe de style → confiance `medium`. Sans A ni agrégat → rien (`no-selection-evidence`).
7. **Confiance** : `high` = agrégat présent, tous les candidats dans l'agrégat, couverture suffisante, une classe de style ; `medium` = des overrides exclus, ou A seul ; sinon repli.

Géométrie exportée : `vcgAssemble` du Cadastre (inchangé) sur les seules features retenues → alignement pixel identique au Cadastre, clipping, fusion multi-tuiles, trous. Tri déterministe (haut-gauche). Chaque entrée devient un `<path id="selection-N">` ; `svg-writer.js` n'a pas changé.

Repli explicite (`source: aggregate-geojson`) : l'ancien export agrégé, avec `fallbackReason`. Calque Cadastre, styles du site, autorisations : inchangés.

## 3. Résultats des tests

`npm test` : **337 PASS** (304 avant + 23 sélection individuelle + 10 provenance). `npm run build`, `git diff --check` : OK.

`visible-selection-individual.test.js` (synthétique, ids `SECRET-*` absents de tout résultat ; contours de l'agrégat décalés de 0,7 px et parcelles de 20 px dans le test de tolérance, voisin à 2 px exclu) : une feature ; plusieurs features ; 52 overrides (2 appariés, 50 « unmatched ») ; parcelle sur deux tuiles fusionnée en un anneau (le buffer voisin n'est pas compté deux fois) ; polygone avec trou ; sélection partiellement hors viewport (clippée, comptée) ; survol distinct de la sélection ; override non cadastral ; collision d'id ; aucun override ; désaccord géométrique ; couverture incomplète ; deux classes de style ; aucune sélection ; delta A ; alignement avec le Cadastre ; un `path` par feature dans le SVG ; aucune donnée cadastrale dans le SVG, le Diagnostic ou le rapport ; schéma fermé du validateur ; lecture seule + dry-run cohérent. Une mutation volontaire (couverture et appartenance désactivées) fait échouer 4 tests. `visible-basemap-provenance.test.js` simule des accesseurs natifs (`location`, `script.src`, `script.textContent`) : rendre ces lectures via `vmiGet` fait échouer 2 tests.

Diagnostic : bloc **SÉLECTION INDIVIDUELLE** — source, confidence, basis, override count, matched features, unique geometries, exported objects, unmatched features, style groups, coverage, evidence, fallback reason. Le champ du rapport s'appelle `perFeature` : le nom `individual` contient la sous-chaîne `idu` que l'audit de confidentialité interdit.

## 4. Limites

- **UNKNOWN** : le comportement réel (nombre d'overrides, classes de style, clés) — jamais observé en navigateur.
- La preuve d'appartenance dépend de l'agrégat GeoJSON : si le site ne l'ajoute pas (autre mécanisme), pas d'export individuel sans capture A.
- Si l'agrégat est un contour fusionné de parcelles voisines (2 anneaux : contour + trou), les parcelles retenues sont celles dont le point intérieur y tombe ; une parcelle absente du cache de tuiles déclenche le repli (couverture), pas une omission.
- Parcelle multi-polygone : un seul point intérieur est testé.
- Un survol *sur* une parcelle sélectionnée remplace son style (un seul override par clé) : non détectable.
- Les parcelles non chargées (hors tuiles du cache) ne sont pas exportables individuellement.
- Le Diagnostic « status » est rafraîchi toutes les 3 s : le calcul individuel s'arrête tôt sans preuve possible (ni agrégat ni capture A) ; avec preuve, il parcourt les tuiles et échantillonne la couverture (≤ 2 500 points). Mesure de temps réel : UNKNOWN.

## 5. Fournisseur du fond

- **OBSERVED** (diagnostic réel) : Leaflet `TileLayer`, pane `raster`, tuiles 256×256, zoom 16, 80 tuiles en cache, 80 intersectant le viewport, 0 lisible, accès image `unavailable-cors`. Le rendu *ressemble* à OpenStreetMap (routes, forêts, hydrographie, bâtiments, toponymes).
- **UNKNOWN** : le fournisseur. Ressembler à OSM ne prouve ni la source vectorielle ni le service.
- **INFERRED, à vérifier** : `unavailable-cors` ne dit presque rien du fournisseur. Leaflet crée les `<img>` sans attribut `crossorigin` sauf si `options.crossOrigin` est défini ; le canevas est alors « tainted » même si le serveur envoie `Access-Control-Allow-Origin: *`. Le rapport indique donc `options.crossOrigin`.

Rapport passif ajouté (`background.provenance`, Diagnostic → « Provenance du fond »), calculé sur les objets Leaflet déjà en mémoire, sans requête : famille de fournisseur (liste fermée : OSM Foundation, OSM France, CARTO, Thunderforest, MapTiler, Stadia, Mapbox, IGN Géoplateforme, Esri, OpenTopoMap, Google, `first-party`, `other-third-party`, `unknown`), famille de service (XYZ / WMTS / tuiles vectorielles), format (extension du gabarit), indices de style (jetons), attribution publique (balises et liens retirés), options (`crossOrigin`, nombre de sous-domaines, retina, `tileSize`, zooms), présence de `maplibregl` / `mapboxgl` / pont Leaflet-GL / `VectorGrid`, indices statiques. **Jamais** : URL, hôte, query, jeton, coordonnées de tuile.

Analyse statique : limitée aux scripts **inline** (`textContent`, drapeaux fermés : mentions OSM, MapLibre, Mapbox, extension `.pbf`/`.mvt`, `style.json`). Les scripts externes sont **comptés, jamais lus** : lire leur corps exige une requête ; cela n'a pas été fait. Aucune analyse des bundles du site n'a donc été réalisée : **UNKNOWN**.

## 6. Nature raster / vectorielle réelle

- **OBSERVED** : le fond est affiché par un `TileLayer` d'images (élément image décodé par tuile, pas de canevas vectoriel) : raster côté navigateur.
- **UNKNOWN** : le format réel de la réponse (PNG/JPEG/WebP ; `<img>` n'expose pas le type MIME). Le rapport donne le format *inféré* de l'extension du gabarit.
- **UNKNOWN** : l'existence d'une source vectorielle séparée. Aucune couche `VectorGrid` ou MapLibre n'est connue pour le fond.

## 7. Scénarios de reconstruction

| | Preuves attendues | Confiance actuelle | Données publiques | Reproduction du style | SVG éditable |
| --- | --- | --- | --- | --- | --- |
| **A** raster OSM standard | `provider: osm-foundation-standard` | UNKNOWN | oui (extraits OSM, ODbL) | difficile : le style « Carto » n'est pas un format portable | oui mais approximatif |
| **B** rendu OSM personnalisé | fournisseur tiers/`first-party`, indices de style, attribution OSM | UNKNOWN | oui (données) ; le style, non | très difficile (palette et règles inconnues) | oui, style propre à choisir |
| **C** service tiers | `other-third-party`/nommé, attribution tierce | UNKNOWN | données selon licence du fournisseur | impossible sans le style | seulement via données ouvertes équivalentes |
| **D** vectoriel séparé | `serviceFamily: vector-tiles`, `maplibregl`/`mapboxgl`/pont GL, indices statiques (`vectorGrid: yes` n'en est **pas** une : le cadastre l'utilise) | UNKNOWN (aucun indice) | tuiles déjà chargées ; accès à la mémoire du lecteur, pas de réseau | style JSON éventuel | très bon |
| **E** indéterminable | tout `unknown` | scénario par défaut aujourd'hui | — | — | seule la capture reste possible |

Les données OSM ne sont pas le rendu du fournisseur : même dans le scénario A, un SVG vectoriel est une réinterprétation, pas une copie du rendu.

## 8. Options futures

| | 1 Capture du viewport | 2 Reconstruction depuis OSM public | 3 Source vectorielle équivalente | 4 Fond simplifié |
| --- | --- | --- | --- | --- |
| Fidélité | exacte (pixels) | moyenne, style à recréer | selon le style fourni | faible à moyenne |
| Éditabilité | nulle (raster) | totale | totale | totale |
| Complexité | faible | élevée | moyenne (si le style existe) | moyenne |
| Performance | bonne | coûteuse (volumes) | bonne | bonne |
| Réseau | non | oui, ou fichier fourni par l'utilisateur | oui | idem 2 |
| Licence | celle du fournisseur (pixels copiés) | ODbL, attribution | variable | ODbL |
| Limites | `captureVisibleTab` capture toute la page (UI, contrôles) ; recadrage et ratio nécessaires ; geste utilisateur (`activeTab`) | demande les coordonnées géographiques de la vue | n'existe peut-être pas | sous-calques à définir |

La capture est une solution de fidélité visuelle, pas une vectorisation. `captureVisibleTab` n'est pas implémentée et aucune permission n'a été ajoutée.

## 9. Architecture future

Modèle multicouche conservé (`ExportDocument.layers[]`, bas → haut) : Fond cartographique, Cadastre, Parcelles sélectionnées, puis Urbanisme, Servitudes, Randonnée, Annotations (non codés). Prévu, non implémenté : le calque « Fond cartographique » pourra devenir un groupe de sous-calques vectoriels (Hydrographie, Routes, Bâtiments, Végétation, Toponymes) ; `layerToSvg` n'a besoin que d'un type `group` ajouté plus tard, sans toucher au moteur viewport. `BACKGROUND_LAYER` reste raster tant qu'aucune source vectorielle n'est prouvée.

## 10. Stratégie recommandée pour MVP-06

1. **D'abord un relevé réel de provenance** (protocole §11) : sans lui, tout choix de reconstruction est spéculatif. Conclure A/B/C/D/E.
2. Si D : exporter le fond depuis les tuiles vectorielles déjà en mémoire (même moteur que le Cadastre).
3. Si A/B/C : **ne pas** coder la reconstruction réseau. Deux voies, par ordre de préférence : (a) fond simplifié (option 4) alimenté par un **fichier OSM local fourni par l'utilisateur** (GeoPackage/GeoJSON, chemin d'import déjà existant), sous-calques séparés ; (b) option 1 en calque raster optionnel, après décision explicite sur `captureVisibleTab`.
4. Décision préalable à écrire (ADR) : aligner des données géographiques sur le viewport exige les coordonnées de la vue, que le lecteur s'interdit aujourd'hui de lire (`getCenter`/`getBounds` jamais appelés). Il faut soit relâcher cette règle (calcul local, rien ne sort), soit demander à l'utilisateur de caler le fichier.

## 11. Protocole de validation navigateur (non exécuté)

**Sélection individuelle**
1. Recharger la page, activer le Cadastre, masque masqué.
2. Diagnostic → **Capture A — Aucune sélection** (n'a pas besoin de B).
3. Sélectionner 2–3 parcelles voisines, puis une isolée. Ne pas déplacer la carte.
4. Exporter. Dans Diagnostic → **SÉLECTION INDIVIDUELLE** relever : `source`, `confidence`, `override count`, `matched`, `unmatched`, `exported objects`, `coverage`, `fallback reason`.
5. Ouvrir le SVG dans Inkscape : le calque « Parcelles sélectionnées » contient un `path` par parcelle (`selection-1…`), chacun sélectionnable ; Cadastre aligné.
6. Répéter sans A, puis avec survol d'une parcelle voisine au moment de l'export, puis près du bord du viewport.
7. Critère de rejet : `source: aggregate-geojson` avec `geometry-disagreement` ou `incomplete-coverage` sur une sélection simple = hypothèse d'association à revoir ; copier le Diagnostic (il ne contient ni identifiant ni coordonnée).

**Provenance du fond**
1. Exporter avec le fond actif ; relever le bloc « Provenance du fond » du Diagnostic : `provider`, `service`, `format`, `style hints`, `attribution`, `crossOrigin`, `vector libraries`, `static hints`.
2. Conclure le scénario (§7). Une attribution OSM seule ne suffit pas à conclure A.
3. Ne rien capturer d'autre : pas de requête, pas de capture d'écran.

## Vérifications de sécurité (tranche)

Permissions `["activeTab"]` uniquement ; aucune host permission, `webRequest`, `debugger` ni stockage ; aucun appel réseau ajouté ; aucune API cadastrale ; aucun identifiant cadastral dans les sorties (tests de confidentialité) ; fichiers utilisateur : aucun ajouté.
