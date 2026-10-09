# MVP-01 — périmètre et critères d'acceptation

## But

Exporter, depuis une page Mon Territoire Carto déjà authentifiée, la vue
courante sous forme d'un SVG éditable qui conserve au minimum le cadastre
chargé comme géométrie vectorielle, et qui inventorie honnêtement toutes les
autres couches visibles. Le périmètre ne comprend pas l'export GeoJSON ni
l'accès à des données non présentes dans la vue affichée.

## Inclus

- extension Chromium MV3 limitée aux origines Mon Territoire nécessaires ;
- masque `.leaflet-mask-pane` affiché/masqué visuellement ;
- inventaire des couches et ressources visibles ;
- classification PBF/MVT, SVG/vector, canvas, WMS, WMTS/raster, image,
  inconnue ;
- emprise, zoom, taille de viewport et CRS quand déterminables ;
- décodage des tuiles PBF cadastrales déjà observées, collection
  `cadastre_parcelle` ;
- paths SVG cadastraux, clipping/dédoublonnage et style raisonnable ;
- groupes SVG standard compatibles Inkscape ;
- inclusion facultative, et uniquement best-effort, de rasters dont les
  octets ont été légitimement capturés/lus.

## Exclus

- consultation ou téléchargement d'une fiche cadastrale ;
- appel de découverte ou de rattrapage d'API privée ;
- modification des autorisations applicatives ;
- promesse de vectoriser un canvas ou un WMS/WMTS raster ;
- GeoJSON utilisateur (point d'extension futur) ;
- export autonome d'un raster impossible à lire sans contourner CORS.

## Critères d'acceptation mesurables

### Sécurité et périmètre

1. Le manifest limite les `host_permissions` aux origines nécessaires,
   documentées et vérifiées ; il ne demande ni `debugger`, ni accès à des
   cookies, ni permission large inutile.
2. Une revue automatisée du dépôt échoue si un fichier suivi contient une
   signature de cookie, bearer token, authorization header, session, ou une
   capture HAR ; `.gitignore` contient `*.har`.
3. Le test de régression du toggle prouve qu'il ne modifie que le style local
   de `.leaflet-mask-pane`, et ne lit/écrit aucune propriété d'autorisation.
4. À partir d'un journal de test instrumenté, l'export PBF effectue zéro
   requête réseau additionnelle : chaque PBF décodé possède une entrée dans le
   registre de ressources reçues par l'affichage normal.

### Inventaire et snapshot

5. Sur la scène de référence, l'inventaire liste chaque pane/couche visible
   avec type, ordre, preuve de classification et statut d'export ; les types
   requis sont tous testés au moins une fois, y compris `inconnu`.
6. Pour une carte Leaflet capturée, les métadonnées de sortie donnent une
   taille de viewport égale à celle de la carte (tolérance 0 px), le zoom égal
   à `map.getZoom()`, et une emprise WGS84 à six décimales.
7. Si la carte n'est pas capturable, l'interface avertit explicitement que le
   snapshot est dégradé et interdit toute affirmation de CRS/bounds exacts.

### Cadastre vectoriel

8. Des fixtures PBF synthétiques, sans données réelles, couvrent au minimum
   Polygon, MultiPolygon, trou, LineString, point, coordonnées bufferisées et
   deux tuiles adjacentes partageant une parcelle.
9. Les fixtures contenant `idu` et `insee` produisent des paths SVG dans le
   groupe `Cadastre`; chaque feature exportée conserve seulement les attributs
   autorisés par le schéma de métadonnées.
10. Pour au moins 20 points de contrôle répartis entre zooms 16 et 17, la
    projection tuile → SVG diffère de l'oracle Leaflet de moins de 0,25 px.
11. Une parcelle coupant une bordure de tuile est présente une seule fois dans
    le rendu final : aucune aire n'est recouverte deux fois, les trous restent
    transparents, et la géométrie est clippée à la viewport (tolérance 0,25
    px).
12. Pour les exemples assainis correspondant aux identifiants de format
    `430040000D0287`, `430040000D0288`, `430040000D0517`, le rapport indique
    une clé de dédoublonnage stable ; les fixtures ne contiennent pas leurs
    géométries ni une réponse de production.

### SVG, raster et ergonomie

13. Le SVG généré est XML bien formé, possède un `viewBox` de la taille de la
    vue et s'ouvre sans erreur dans Inkscape ; les groupes sont des calques
    `inkscape:groupmode="layer"` avec labels uniques.
14. Les métadonnées contiennent version de schéma, date ISO 8601, emprise,
    CRS quand déterminé, zoom, provenance/type/compteurs des couches, sans
    query string, header, cookie, token ni valeur de session.
15. Un raster capturé et sous les plafonds est incorporé en `data:` URI avec
    MIME et dimensions corrects. Un raster non capturable est compté et
    présenté comme omission ; l'export ne déclenche pas de contournement CORS.
16. Les tests imposent les plafonds de taille : un dépassement annule
    l'incorporation de l'image concernée, conserve le reste du SVG et produit
    un diagnostic actionnable.

### Robustesse

17. Les tests unitaires de projection, décodage, clipping, dédoublonnage et
    écrivain SVG s'exécutent hors navigateur à chaque CI.
18. Les tests d'intégration Chromium/Playwright chargent une application
    Leaflet locale synthétique, vérifient le toggle, l'inventaire et un export
    de fixture sans requête inattendue.
19. Un changement de sélecteur/signature SOGEFI ne fait pas échouer
    silencieusement : l'adaptateur produit un diagnostic « incompatible ou
    incomplet » et le mode DOM générique reste utilisable lorsque possible.

## Stratégie de test

Les fixtures sont générées localement à partir de géométries synthétiques et
assainies. Elles n'incluent ni URL de production, ni utilisateur, ni INSEE
réel imposé, ni token, ni corps de réponse capturé. Un générateur de fixtures
séparé et une vérification de secrets empêchent la dérive. Playwright sert à
l'intégration contre le serveur Leaflet de test, jamais à automatiser une
authentification Mon Territoire.

## Observations de levée de blocage avant codage

Les découvertes fournies établissent le modèle de données, mais ne prouvent
pas encore l'intégration MV3. Une session autorisée doit fournir un relevé
assaini, manuel ou issu d'une sonde locale non committée, répondant aux points
suivants :

1. ordre réel de chargement : l'observateur `document_start` est-il présent
   avant les requêtes de tuiles et, sinon, la carte peut-elle être déplacée
   normalement pour les observer à nouveau ?
2. transport réel de `cadastre_parcelle` : `fetch`, XHR, `<img>`, worker ou
   autre ; type de réponse, `content-type`, URL normalisée et coordonnées
   z/x/y (sans query/session) ;
3. possibilité de capturer une instance Leaflet via un point public stable,
   ou validation du repli DOM avec comparaison de `pixelOrigin`, bounds et
   transformations CSS ;
4. pour un fond IGN et une couche WMS SOGEFI : mode de chargement, origine,
   CORS observé et possibilité/non-possibilité de lire les octets sans une
   nouvelle requête ;
5. un échantillon PBF anonymisé ou généré équivalent confirmant layer,
   extent, id, types et géométries réels ;
6. tailles typiques (nombre de tuiles, octets PBF/raster, features et points)
   d'une vue urbaine à zoom 16 et 17 pour fixer les plafonds mémoire.

Le relevé doit exclure cookies, Authorization, URL signées, identifiants de
session et HAR complet.
