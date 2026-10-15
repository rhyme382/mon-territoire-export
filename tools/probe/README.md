> **Historique T00.** Cette page documente les sondes passives T00-B…T00-E. Depuis MVP-07 leurs boutons ne sont plus affichés dans l'interface produit (leur code reste, interne, pour les tests). Pour le build, le chargement et le ZIP, voir `docs/packaging.md`.

# Sonde locale temporaire T00-B/T00-C/T00-D

Cette extension MV3 observe passivement les ressources déjà chargées par la page. Elle ne déclenche aucune requête, ne modifie pas le trafic, ne lit pas les cookies ni `Authorization`, ne persiste pas de données et n'envoie aucune télémétrie.

1. Exécutez `npm run build` à la racine du dépôt.
2. Ouvrez `chrome://extensions`, activez le mode développeur puis **Charger l'extension non empaquetée**.
3. Sélectionnez le dossier `tools/probe/dist`.
4. Ouvrez une page Mon Territoire fraîche. Pour la procédure T00-D, masquez le masque territorial seulement si vous le souhaitez, désactivez toutes les couches, puis remettez uniquement le cadastre. Ne déclenchez ni déplacement, ni zoom, ni reload pour les besoins de la sonde.
5. Attendez le rendu normal puis utilisez **Copy sanitized MVT report** dans la section **T00-D MVT/PBF passive probe**. Ce rapport est séparé de T00-C.
6. Vérifiez le résumé, copiez/téléchargez localement si nécessaire, révisez avant partage et retirez l'extension à la fin.

## T00-E — moteur / Worker (probe réelle)

1. Dans `chrome://extensions`, rechargez l’extension, puis fermez l’ancien onglet Mon Territoire et ouvrez-en un neuf.
2. Attendez le chargement normal ; le masque peut être caché localement si nécessaire. Désactivez toutes les couches métier.
3. Dans **T00-E Engine / Worker probe**, choisissez **Capture engine snapshot** (snapshot A).
4. Activez manuellement uniquement le cadastre, attendez les limites normales, sans pan, zoom ni rechargement.
5. Choisissez **Capture engine snapshot** (snapshot B), puis **Compare with previous snapshot** et **Download sanitized T00-E report**.

T00-E n’active aucune couche, ne crée aucune requête, ne lit aucun message Worker et ne recharge jamais un Worker. Les Workers créés avant l’instrumentation ne peuvent pas être observés : le rapport le signale implicitement par son compteur et ne tente jamais de les recréer. La sonde inspecte en lecture seule le contrôleur Service Worker courant ; elle n’appelle ni enregistrement, ni mise à jour, ni désenregistrement, ni inventaire susceptible de déclencher une mise à jour.

T00-C a montré que les états cadastre OFF/ON ont le même rendu DOM/SVG/canvas/image observé : la géométrie cadastrale n'est donc pas matérialisée dans cette voie. T00-D observe seulement le runtime de la page, dès `document_start`, par wrappers transparents de `fetch` et XHR. Il ne génère aucune requête; pour `fetch`, il lit au plus un `Response.clone()` d'une réponse déjà reçue; pour XHR, seulement un `ArrayBuffer` déjà fourni par la page. Un échec de lecture est déclaré sans retry.

Le rapport T00-D porte `inspection: "passive-mvt-runtime-only"` et `no-additional-network-requests: true`. Il contient exclusivement host/path normalisés (sans query/fragment, et coordonnées de tuile remplacées par `{z}/{x}/{y}`), transport, content-type, taille, état de lecture/décodage, et statistiques MVT agrégées. Il n'inclut jamais PBF brut, base64/hex, géométrie, coordonnées, cookies, tokens, Authorization ni valeurs de propriétés cadastrales. Si les tuiles ont été chargées avant l'instrumentation, le faible nombre de candidats doit être interprété honnêtement : la sonde ne les recharge jamais; l'utilisateur peut refaire ultérieurement un chargement normal de page avec la couche voulue.

Invariant comptable T00-D : `sanitizedFactsEmitted = sanitizedFactsAccepted + sanitizedFactsRejected + sanitizedFactsPending`. À l'export, les candidats collectés donnent habituellement `pending = 0`.
