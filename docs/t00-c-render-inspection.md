# T00-C — inspection passive du rendu DOM/Leaflet

T00-C est une voie indépendante de T00-B. Elle ne modifie ni ne remplace les
observations réseau existantes de T00-B : le snapshot est produit uniquement
lorsque l’utilisateur clique **Inspect render**.

## Périmètre

Le script lit seulement le rendu déjà présent dans le DOM de la page :

- inventaire des `.leaflet-container` et de leurs panes observés ;
- signalement explicite de la présence d’un `.leaflet-mask-pane`, sans le
  modifier ;
- comptages par pane des `svg`, `path`, `polyline`, `polygon`, `circle`,
  `rect`, `canvas` et `img` ;
- métadonnées SVG sûres (dimensions et `viewBox` numériques), styles locaux,
  transforms et boîtes locales arrondies en pixels ;
- statistiques de `d` (présence, longueur, nombre de commandes) sans jamais
  copier la chaîne `d` ;
- signatures visuelles agrégées avec au plus dix exemples par signature et
  cent exemples au total ;
- canvas : dimensions seulement, sans lecture de pixel, `toDataURL` ni
  `getImageData` ;
- images : hostname et chemin générique. Query, fragment et segments de tuile
  `z/x/y` sont supprimés.

Les `candidateGroups` décrivent uniquement les éléments réellement rendus,
leur pane et leur signature visuelle. Ils ne donnent jamais de nom métier à
une couche et ne tentent pas d’identifier un cadastre.

## Conclusion pour le cadastre et suite T00-D

Dans l'expérience contrôlée (A sans couche, B cadastre seul, sans déplacement,
zoom ni reload), les rapports DOM/rendu sont identiques. T00-C exclut donc la
voie DOM actuellement inspectée pour obtenir la géométrie cadastrale : les
traits visibles ne sont pas des SVG/path/canvas/img accessibles ici. T00-D est
une sonde distincte et passive des réponses MVT/PBF que le runtime reçoit déjà;
elle ne produit pas encore de SVG.

## Limites de confidentialité

Le rapport ne contient ni texte DOM, ni valeurs métier, ni référence/ID
cadastral, ni coordonnées géographiques, ni URL complète, ni cookie, token,
`Authorization`, query ou fragment. Aucun appel réseau n’est créé et aucune
permission ni aucun contrôle d’accès applicatif n’est modifié.

Les boutons **Copy sanitized render report** et **Download sanitized render
report** opèrent exclusivement sur le dernier snapshot T00-C local. Ils ne
déclenchent pas une inspection et n’envoient rien.

## Validation synthétique

`tools/probe/test/render-inspector.test.js` couvre SVG/path similaires,
mask pane, tiles raster, canvas, transforms, path sans `d`, `d` long,
sanitisation query/token, suppression de `x/y`, absence de texte métier ou
coordonnées géographiques, et plafonds d’échantillonnage.
