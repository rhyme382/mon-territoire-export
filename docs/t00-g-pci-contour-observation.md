# T00-G — Observation passive de la réponse PCI contour

## Objectif

Connaître le contrat réel de la réponse à
`POST …/cadastre/v1.0/pci/parcelle/geometries?geometryType=contour`
(pipeline : résultats de recherche → liste d'`id_par` → `getParcelleContourPCI`
→ réponse → `showParcelles` / `setGeojson`), **sans** conserver de coordonnées
ni de valeurs.

## Mécanisme

- Fichier : `tools/probe/pci-contour-observer.js` (monde MAIN, chargé avant `main-observer.js`).
- Point d'observation : `jQuery.ajax` (et `$.ajax` si distinct) est enveloppé par un wrapper
  transparent (`this`, `arguments`, valeur de retour et exceptions préservés ; options et réponse jamais modifiées).
- Filtre : seuls les appels dont l'URL normalisée a pour pathname
  `/cadastre/v1.0/pci/parcelle/geometries` **et** `geometryType=contour` sont suivis.
  Tout autre `$.ajax` est ignoré sans aucune lecture.
- La réponse est lue uniquement sur le `jqXHR` renvoyé à la page, via `.always(...)`
  (`status`, `responseJSON`, longueur de `responseText`). Aucune requête n'est créée ni rejouée.
- Installation idempotente (marqueur sur la fonction enveloppée), silencieuse si jQuery est absent.
  jQuery pouvant arriver après `document_start` : 100 tentatives × 100 ms maximum, plus un essai
  à `DOMContentLoaded` et `load`. Pas de polling infini.
- Le résumé est envoyé au content script par le pont d'événements existant, puis validé par un schéma fermé
  (`validatePageFact`, type `pci-contour`) avant d'entrer dans le rapport.

## Données observées (noms et structure uniquement)

`status` (observed / too-large / invalid, `waiting` côté UI), type racine, `rootType`,
noms de clés racine (≤ 32), source des éléments (`features`, tableau, tableau imbriqué…),
nombre de features, types de géométrie, profondeur d'imbrication des coordonnées (par type),
feuilles numériques 2D/3D, indice `valueRange` (valeurs dans / hors bornes lon-lat : simple indice
structurel, **pas** une déduction de CRS), noms de propriétés, `parcelIdentity`
(clés candidates par nom, couverture all/some/none, unicité, `id` de feature),
CRS explicite (`crs`/`srs`/`srid`/`epsg`/`projection` : emplacements ; valeur déclarée seulement
si c'est un code `EPSG:n`, sinon `unrecognized`), nombre d'ids demandés et nombre d'ids retrouvés
dans les propriétés (agrégats numériques).

## Données volontairement supprimées

Coordonnées, bbox, valeurs d'`id_par` et de propriétés, références cadastrales, noms, adresses, INSEE,
URL complète, query, corps de requête, headers, cookies. Les clés pouvant ressembler à des données
(suite de ≥ 3 chiffres, caractères atypiques) sont comptées (`redactedKeyCount`) mais jamais listées.
Les ids de la requête sont lus en mémoire le temps de l'appel pour compter les correspondances, jamais conservés ni rapportés.

## Bornes

Réponse > 5 000 000 caractères : `too-large`, non analysée. 2000 éléments inspectés, 200 000 nœuds,
profondeur 12, 32 noms de clés ; `truncated: true` si une borne est atteinte. 5 observations conservées au maximum.

## Limites

- Une réponse servie par le cache interne de la page (pas de nouvel appel) n'est pas observable.
- Si le serveur renvoie du JSON non standard, seule la structure générique est décrite.
- Le CRS n'est jamais déduit.
- Aucun export (SVG, GeoJSON, GPKG), aucun décodage MVT, aucune sélection automatique.

## Procédure du test réel

1. Recharger l'extension unpacked (`tools/probe/dist`, après `npm run build`).
2. Ouvrir un nouvel onglet Mon Territoire.
3. Utiliser normalement la recherche / sélection parcellaire qui provoque l'affichage d'un contour.
4. Ne rien faire artificiellement dans DevTools.
5. Attendre `status: observed` dans la section **PCI CONTOUR** du panneau.
6. Copier ou télécharger le rapport du probe (« Copy sanitized report » / « Download sanitized JSON », section `pciContour`).
7. Transmettre uniquement ce rapport sanitizé.
