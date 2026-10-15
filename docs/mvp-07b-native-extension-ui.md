# MVP-07B — interface native d'extension

Statut : **VALIDATED_IN_REAL_BROWSER** (v0.2.0 : popup `chrome.action` fonctionnel, aucune UI injectée dans la page).

## Changement UX

Le panneau flottant injecté en bas à droite de la page est supprimé. L'extension n'injecte plus aucune interface dans
Mon Territoire : la page reste visuellement identique à celle sans l'extension (aucun élément, shadow root, CSS, texte,
badge ni diagnostic visible). Toutes les commandes sont accessibles depuis l'icône de l'extension (popup).

| Section du popup | Commande |
| --- | --- |
| Carte visible | `Exporter en SVG` : fond (si incorporable) + cadastre + parcelles sélectionnées |
| Affichage | `Masquer le masque` / `Afficher le masque` (primitive `style.display` de la mask pane, inchangée) |
| GeoPackage | `Choisir un fichier` puis `Exporter en SVG` (analyse locale dans le popup) |

Messages d'export : `Préparation du fond…` → `Export…` → `Terminé.`, ou un message d'erreur simple.

## activeTab

Avec `action.default_popup`, `chrome.action.onClicked` n'est plus appelé : le gestionnaire du service worker est supprimé.
Le clic sur l'icône qui ouvre le popup est le geste d'extension documenté pour `activeTab` (« l'utilisateur invoque
l'extension », dont l'exécution d'une action) : le grant s'applique à l'onglet actif jusqu'à sa navigation. Le popup
envoie ensuite les commandes au script de contenu ; la demande de capture part du script de contenu vers le service
worker (`captureVisibleTab`), inchangée. Permissions finales : `["activeTab"]`, aucune autre.

## Flux

```
icône (ouvre le popup = geste activeTab) → popup.js ─ tabs.connect('mte-popup') ─► content-ui.js (port)
  popup « Exporter » → mte:export → rendered.arm() → cadastre → basemap-ready → isolation → captureVisibleTab (SW)
                       → restauration → recadrage → SVG → téléchargement par le script de contenu
  popup « Masque »   → mte:mask-toggle → maskControl.toggle() → { état, libellé }
  popup GeoPackage   → analyse + SVG dans le popup (aucun message vers la page, aucun réseau)
```

- Le port n'accepte que l'extension elle-même (`port.name === 'mte-popup'`, `sender.id === runtime.id`).
- Le téléchargement de la carte est lancé par le script de contenu : il continue même si le popup se ferme.
- L'export GeoPackage s'exécute pendant que le popup est ouvert ; aucun `File` / `ArrayBuffer` n'est conservé, aucun
  `storage`.
- Les diagnostics internes restent dans un élément détaché, non rattaché au document.

## Limites à vérifier en navigateur

- Sur certaines plateformes, le sélecteur de fichier d'un popup peut le fermer : alors l'import GeoPackage n'aboutit
  pas ; à constater lors du test réel (alternative envisagée : page d'extension dédiée, sans nouvelle permission).
- Le popup se ferme au clic dans la page ; l'export de la carte continue (téléchargement par la page).
