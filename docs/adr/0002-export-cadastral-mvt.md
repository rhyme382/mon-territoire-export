# ADR 0002 — Décoder les MVT cadastraux observés en paths SVG

**Statut :** proposé (T00)

## Décision

Décoder uniquement les PBF enregistrés comme déjà reçus pour la vue courante,
avec `pbf` et `@mapbox/vector-tile`. Convertir la couche
`cadastre_parcelle` de coordonnées tuile WebMercator vers les pixels de la
viewport, puis clipper et dédoublonner par provenance/source-layer/`idu`.

## Conséquences

Les parcelles restent éditables dans Inkscape. Le pipeline doit gérer les
buffers de tuiles, anneaux et multipolygones, et fournir des diagnostics si la
topologie ne peut pas être réunie. Aucun appel cadastral supplémentaire n'est
effectué.
