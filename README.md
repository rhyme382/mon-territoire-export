# Mon Territoire Export

Extension Chromium permettant d'exporter une vue de Mon Territoire Carto
en SVG éditable, en conservant autant que possible les couches
cartographiques vectorielles.

## Principes

- fonctionne sur la carte déjà ouverte et authentifiée ;
- aucune conservation d'identifiants, cookies ou jetons ;
- export des données cartographiques effectivement chargées pour l'affichage ;
- conservation des couches vectorielles comme objets vectoriels ;
- fonds raster incorporables dans le SVG ;
- SVG organisé en groupes exploitables dans Inkscape.

## Fonctions

- masquer / afficher le masque territorial ;
- convertir un GeoPackage cadastral officiel en SVG (traitement local) ;
- exporter le cadastre visible en SVG ;
- conserver les parcelles sélectionnées comme objets vectoriels indépendants ;
- incorporer le fond cartographique visible en raster propre.

## Architecture de l'export

| Calque | Nature |
| --- | --- |
| Fond cartographique | raster |
| Cadastre | vectoriel |
| Parcelles sélectionnées | vectoriel |

L'extension n'injecte aucune interface dans Mon Territoire : la page reste identique à celle sans l'extension. Toutes
les commandes (exporter la carte visible en SVG, masquer / afficher le masque, importer un GeoPackage et l'exporter en
SVG) sont dans le popup de l'icône de l'extension, dans la barre d'outils. Sans fond, l'export vectoriel reste complet.
Les traitements sont locaux : aucune requête supplémentaire, aucune
persistance, aucune télémétrie ; seule la permission `activeTab` est demandée.

## Utilisation

1. Charger l'extension (voir ci-dessous) et ouvrir Mon Territoire Carto, carte et couches affichées.
2. Cliquer sur l'icône de l'extension : le popup s'ouvre.
3. **Exporter la carte visible** : télécharge un SVG (fond raster capturé, cadastre et parcelles sélectionnées vectoriels).
4. **Masquer / Afficher le masque** : pilote le masque territorial de la page.
5. **Importer un GeoPackage** local, puis l'exporter en SVG (traitement entièrement local).

Le fond raster correspond au rendu visible capturé ; le cadastre et la sélection restent vectoriels.

## Confidentialité et permissions

Traitement local uniquement : aucune requête supplémentaire, aucune persistance, aucune télémétrie. Manifest V3,
permission unique `activeTab` ; ni `host_permissions`, ni `tabs`, `webRequest`, `debugger`, `storage`, `<all_urls>`.

## Développement et distribution

```
npm run build      # Node >= 22.13, aucune dépendance (ni npm ci ni npm install nécessaires)
npm test
npm run package    # release/mon-territoire-export-<version>.zip
```

Chargement non empaqueté : `npm run build`, puis `chrome://extensions` → mode développeur → **Charger l'extension non
empaquetée** → `tools/probe/dist`.

Voir `docs/packaging.md`.
