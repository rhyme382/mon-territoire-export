# Packaging Chromium

## Développement

```
# Aucune dépendance : pas de package-lock.json, donc ni `npm ci` ni `npm install` ne sont nécessaires (Node >= 22.13).
npm test          # suite synthétique ; nécessite un dist/ à jour (npm run build)
npm run build     # génère tools/probe/dist
```

`npm test` audite aussi `dist/` ; exécutez `npm run build` avant `npm test` après toute modification.

## Charger l'extension non empaquetée

1. `npm run build`
2. `chrome://extensions` → mode développeur → **Charger l'extension non empaquetée** → `tools/probe/dist`.

## Créer le ZIP

```
npm run package
```

La commande :

1. relance `npm run build` ;
2. dérive la liste des fichiers d'exécution **du manifest** (scripts de contenu, service worker, popup et les fichiers locaux qu'il charge, icônes) ;
3. refuse tout fichier interdit ou manquant ;
4. écrit `release/mon-territoire-export-<version>.zip` avec `manifest.json` **à la racine**.

L'archive est déterministe (entrées triées, dates fixes, aucun champ supplémentaire) : deux exécutions sur les mêmes
sources donnent le même SHA-256.

Contenu : `manifest.json`, scripts de contenu, `service-worker.js`, `popup.html` / `popup.css` / `popup.js`, `icons/icon-{16,32,48,128}.png`.
Jamais : `node_modules`, sources, tests, docs, HAR, logs, SVG/GeoPackage utilisateur, `.git`, `.env`, source maps,
fixtures, `lib/`.

Les tests `tools/probe/test/package.test.js` ouvrent le ZIP et auditent son contenu et son manifest.

## Icônes

`npm run icons` régénère `tools/probe/icons/*.png` depuis des formes vectorielles (sans ressource externe).

## Installation manuelle dans Chromium

1. Décompresser le ZIP dans un dossier dédié.
2. `chrome://extensions` → mode développeur → **Charger l'extension non empaquetée** → ce dossier.
3. Ouvrir Mon Territoire (aucune interface n'est ajoutée à la page), puis cliquer sur l'icône de l'extension : le
   popup contient les commandes.

## Procédure de release

1. Mettre à jour `version` dans `tools/probe/manifest.json` (semver `X.Y.Z`).
2. `npm run build && npm test && npm run package` (le second `npm test` audite le `dist/` neuf).
3. `git diff --check`.
4. Test réel final (voir `mvp-07-final-polish.md`).
5. Publier `release/mon-territoire-export-<version>.zip` (non versionné par git).
