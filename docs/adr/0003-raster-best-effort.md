# ADR 0003 — Raster autonome seulement avec octets légitimement accessibles

**Statut :** proposé (T00)

## Décision

Embarquer un raster dans le SVG uniquement si ses octets ont été capturés lors
du chargement normal ou sont CORS-clean dans la page. Ne pas contourner CORS,
ne pas s'appuyer sur `chrome.debugger`, et ne pas effectuer de requête PBF ou
raster de rattrapage dans MVP-01.

## Conséquences

Le résultat est sûr mais le fond IGN/WMS peut être absent du SVG autonome dans
certains cas. L'export doit rendre cette omission visible et conserver son
inventaire ; une politique future de récupération explicitement autorisée
pourra être évaluée séparément.
