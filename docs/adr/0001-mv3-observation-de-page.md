# ADR 0001 — Observer la page, ne pas devenir client SOGEFI

**Statut :** proposé (T00)

## Contexte

Le rendu mélange Leaflet, PBF/MVT, WMS/WMTS, images et couches DOM. La carte
est déjà authentifiée par l'utilisateur ; l'extension ne doit pas étendre ce
périmètre.

## Décision

Utiliser un content script isolé et un observateur MAIN world injecté à
`document_start`. L'observateur capture les informations et les corps que la
page reçoit normalement ; le service worker orchestre sans initier les appels
de données. DOM, MutationObserver et Performance API complètent l'observation.

## Conséquences

La solution respecte le principe de moindre privilège et reste testable avec
une application Leaflet locale. Certaines ressources chargées avant
l'observateur ou directement comme images cross-origin peuvent être
inventoriées sans pouvoir être embarquées : c'est un résultat explicite.
