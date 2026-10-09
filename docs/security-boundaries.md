# Limites de sécurité et confidentialité

## Invariant central

L'extension exporte une représentation de ressources cartographiques que la
page déjà authentifiée a chargées pour rendre la vue actuellement affichée.
Elle ne découvre pas de territoires, ne crée pas de droits et ne remplace pas
les contrôles de Mon Territoire Carto.

## Autorisé

- lire le DOM et l'état Leaflet de la page actuellement ouverte ;
- observer les requêtes que la page initie pour l'affichage normal ;
- conserver temporairement en mémoire les corps admissibles déjà reçus ;
- masquer visuellement `.leaflet-mask-pane` pour l'export local ;
- exporter localement un fichier à la demande de l'utilisateur ;
- appliquer des heuristiques sur des URL/propriétés après suppression des
  query strings et de toute donnée sensible.
- pour T00-D uniquement, décoder en mémoire une copie bornée d'une réponse
  MVT déjà reçue, puis ne transmettre que des statistiques agrégées.

## Interdit

- modifier `isAllowed`, `user_data.insees` ou tout autre contrôle fonctionnel ;
- modifier une requête/réponse, contourner CORS, CAPTCHA, authentification ou
  autorisation ;
- appeler volontairement une API privée, une tuile ou un territoire que la
  page n'a pas chargé pour la vue ;
- lire, stocker, transmettre ou committer cookies, tokens, headers
  d'autorisation, credentials ou captures réelles ;
- utiliser `chrome.debugger`, intercepter le trafic système ou persister un
  cache de ressources cartographiques par défaut ;
- promettre une couche raster autonome si ses octets ne sont pas lisibles par
  un chemin légitime.
- faire traverser un `ArrayBuffer`/PBF brut la frontière MAIN→isolated,
  l'écrire sur disque, ou exporter ses valeurs de propriétés/géométries.

## Garde-fous de conception

1. **Permissions minimales.** La liste d'origines est explicite, revue et
   limitée. Aucune permission cookies/debugger ne sera demandée.
2. **Registre de provenance.** Une ressource devient exportable uniquement si
   elle a une preuve d'observation dans le document actif et un horodatage de
   la session de rendu ; le PBF ne fait jamais l'objet d'une requête de
   rattrapage.
3. **Mémoire éphémère.** Les octets observés sont plafonnés, évincés et perdus
   à la fermeture/navigation. Ils ne vont ni dans `storage` ni dans les logs.
4. **Messages sûrs.** MAIN world, content script et service worker s'échangent
   des messages validés par schéma, bornés en taille, sans HTML arbitraire ni
   fonction sérialisée.
5. **Sortie assainie.** Les métadonnées conservent seulement origine/chemin
   normalisé ou un identifiant de fournisseur ; query strings, headers et
   URL potentiellement signées sont supprimés. Les valeurs textuelles de
   propriétés sont échappées pour XML.
6. **Échec explicite.** CORS tainted, couche inconnue, tuile manquante,
   dépassement mémoire ou adaptateur incompatible produisent un diagnostic et
   une omission déclarée, jamais une tentative de contournement.

## Dépôt et tests

`*.har` est ignoré. Les fixtures sont synthétiques ou irréversiblement
assainies ; elles subissent un scan de secrets et une revue manuelle. Les logs
de test ne doivent pas afficher d'URL complète avec query, ni le contenu brut
de réponses. Toute observation sur une session réelle reste locale et hors
versionnement.

## Modèle de menace simplifié

Le risque principal est une extension qui deviendrait involontairement un
outil d'exfiltration ou de contournement. La réduction de surface vient du
principe de moindre privilège, de l'absence de persistance, du registre de
provenance et du refus explicite des ressources non observées. Une erreur de
classification ne doit jamais élargir le périmètre réseau ou d'autorisation ;
elle dégrade seulement l'export en « inconnu/non incorporé ».
