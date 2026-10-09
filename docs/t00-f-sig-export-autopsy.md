# T00-F — SIG export autopsy

## Executive finding

**A — SOURCE-PROVEN NORMAL-PAGE PIPELINE.** Two JavaScript artefacts manually
saved from browser Sources prove the normal SIG-export UI and PCI geometry
clients. Analysis was local/static only: no endpoint, cookie, token, session,
or request was used. PCI is preferable for normal-page identified parcels;
MVT remains necessary for the distinct exact-viewport case.

## Real source artifacts

| Local analysis-only artifact | Size | Role |
| --- | ---: | --- |
| `.local-analysis/resultat-recherche.min.js` | 36,841 bytes | Result UI, SIG button, contour consumer |
| `.local-analysis/requests.min.js` | 20,490 bytes | `PluginSogefiRequests` PCI client |

User-provided from DevTools Sources. R1 re-verified every claim directly
against these files; the earlier `/tmp` paths and byte sizes were inexact. The
directory is excluded locally via `.git/info/exclude`: artifacts are untracked
and unmodified.

## SIG export UI

Minified `ResultatRecherche.U(e,o)` creates a DataTables button with class
`search_result_top_btn sig-export` (plus `disabled` when unavailable). Its
enabled tooltip is exactly `Exporter les données au format SIG`.

The handler builds `#sig-modal`, fills the projection selector, and calls
`t.model.getGpkFile(o, val, callback)`. In `z(i)`, `g` is built by
iterating current results `n`, applying `idu → id_par` fallback, then
`g.push(i.id_par)` (only entries with a defined `id_par`); the table is built
with `U(C>0, g)`, so `o` in `U(e,o)` is that array of parcel IDs, not a bbox or
geometry. The callback creates `new Blob([e], {type:"text/plain"})`, an object
URL, and an anchor download named
`${filename_export}_${date}_Resultat_SIG.gpkg`, clicks it, then calls optional
`exportAsGPKG`. The Blob MIME is client-side only; server MIME is not proven.
The callback has no `null` check: on error `getGpkFile` passes `null`, so the
client would still download a tiny bogus `.gpkg`.

## Availability condition

Enabled exactly when `Object.keys(n).length <= 500`; otherwise CSS includes
`disabled` and the tooltip states the 500-result limit. No role,
`majicAuthorized`, or `insees` predicate surrounds this button. This does
not establish lack of server-side authorization.

## Projection selector

`projection` is the selected static option: EPSG:4326 (WGS 84), EPSG:2154
(Lambert-93), EPSG:3942–3950 (CC42–CC50), EPSG:5490 (RGAF09 UTM 20N),
EPSG:2972 (RGFG95 UTM 22N), EPSG:2975 (RGR92 UTM 40S), and EPSG:4471
(RGM04 UTM 38S).

## getGpkFile call graph

```text
z → g.push(i.id_par) → U(..., g) → SIG modal
→ getGpkFile(g, selected EPSG, callback)
→ POST PCI parcelle/extract?format=geopackage
→ Blob → object URL → downloaded *_Resultat_SIG.gpkg
```

## GeoPackage export contract

- Base API: `https://api.sogefi.io/cadastre/v1.0/pci/` (configurable option).
- Route/query: `parcelle/extract?format=geopackage`; method: `POST`.
- Fields: `parcelles` (the `id_par` array) and `projection` (EPSG code).
  Sent as a jQuery `data` object with no `contentType`/`dataType`, i.e.
  default form-urlencoding (array as `parcelles[]=…`), **not JSON**. Direct
  `$.ajax`: no in-memory cache, no HTTP-status handling.
- Response: `xhrFields.responseType = "blob"`; success invokes callback with
  it; error logs and invokes callback with `null`.
- Download is the source-proven anchor flow above. No call was executed.

## getParcelleContourPCI call graph

```text
current result object n → Object.keys(n).join(",")
→ getParcelleContourPCI(idsCsv, callback) → idsCsv.split(",")
→ generic helper i("getParcelleContourPCI","POST", …contour, {parcelles:[id, …]})
   (form-urlencoded, not JSON)
→ callback(responseJSON|null, HTTP status) → showParcelles(response, null, flag)
→ setGeojson(response) / collection.init(response), where installed
```

**Correction vs earlier draft:** contour uses the generic helper `i` (also
used for GETs), not the JSON helper `o`. It sends `data: {parcelles: [...]}`
as an object (jQuery form-urlencoding, `parcelles[]=…`), `dataType: json`,
no `contentType`. `complete` passes `responseJSON` (or `null`) and the HTTP
status to the callback; `error` only logs. Results are memoised in-process by
method+URL+JSON(data). The consumer ignores the status argument: it shows
"Impossible de récupérer les données des parcelles." only when the value is
`null`, and otherwise passes any JSON to `showParcelles`. The client applies
no 500 cap and no paging to this call; server limits are unknown.
`getDispositionDvfGeom` reuses the same route.

`setGeojson(response)` proves GeoJSON treatment is **PARTIAL**. Neither
source checks contour `type`, `features`, geometry type, CRS, or properties:
FeatureCollection, Polygon/MultiPolygon, response CRS and properties are
**NOT PROVEN BY STATIC SOURCE**.

## PCI geometry primitives

| Primitive | Route/method | Input / skipGeometry | Static output / paging | Use |
| --- | --- | --- | --- | --- |
| `getParcellePCI` | GET `parcelle/{id}?skipGeometry=false` | ID | JSON; schema not proven | One parcel |
| `getParcelleContourPCI` | POST `parcelle/geometries?geometryType=contour` | CSV IDs → form-urlencoded `parcelles[]` | JSON; no client pagination | Selected IDs |
| `parcellesFilterPCI` | POST `parcelle/search?skipGeometry=false` | Caller body (JSON) | Code reads `features[].properties.id_par/idu` | Existing page search |
| `parcellesFilterPCIAll` | same + offset/limit | Caller body | follows `links[rel=next]`, joins features | Full normal search |
| `parcellesFilterPCIAllBatched` | same | splits `filter["insee[in]"]` in 25 | client creates FeatureCollection | Full existing search |
| `getParcellesIntersect(All)` | POST `parcelle/search?skipGeometry=false` | JSON `{geojson}` | all follows next links | Geometry selection, not viewport proven |
| `getParcellesPCI` | POST search with `limit=25&result-type=hitsOnly&skipGeometry=true` | Caller body | count-oriented JSON | No geometry |
| `communeSearchPCI` | POST `commune/search` | JSON `{geojson}`; default skipGeometry=true; limit ≤100 | JSON, no auto page | Commune helper |
| `getFeuillePCI` | GET `feuille/{id}?skipGeometry=false` | Sheet ID | JSON; schema not proven | Possible sheet geometry |
| `getNeighboringParcelles` | GET `parcelle/neighbour/{id}?skipGeometry=false` | ID | JSON; schema not proven | Adjacent parcels |

## What is proven

- SIG UI, 500 limit, CRS selector, ID input, GPKG POST/blob/download path.
- PCI base and exact GPKG/contour request construction.
- Contour requires parcel IDs, not a viewport.
- Search/intersection request `skipGeometry=false`; paging expects features;
  the batched helper explicitly creates a FeatureCollection.

## What is NOT proven

- Server authorization/limits, headers, actual GPKG contents, or a successful
  endpoint operation.
- Contour response is passed untouched to `showParcelles` / `setGeojson` /
  `collection.init`; their bodies are outside both files.
- Search-geometry contract: **PARTIAL** (`features`, `links`, `numberMatched`
  read; per-feature geometry type/CRS never inspected).
- Contour FeatureCollection, Polygon/MultiPolygon, CRS, properties: **NOT
  PROVEN BY STATIC SOURCE**.
- A PCI call that enumerates the exact map viewport; GPKG is selected IDs.

## Security / authorization observations

The module filters/injects configured `insees` for searches and aborts with
a territorial warning if none remains. `majicAuthorized` selects MAJIC mode
by regex; it is not a proven SIG guard. The 500 limit is functional only.
No control was changed or bypassed. PCI cadastral geometry is distinct from
MAJIC owner/person data; SVG must not depend on owner data.

## MVT vs PCI geometry vs GPKG

| Option | Fidelity/CRS/attributes | Viewport/IDs | Robustness, boundary | Decision |
| --- | --- | --- | --- | --- |
| 1 — MVT | Rendered tile geometry; tile transforms needed | Evidenced visible geometry; no prior IDs | Zoom/renderer dependent; passive | Keep for exact viewport |
| 2 — Contour PCI | Server contour; schema/CRS unproven | Requires prior IDs, no bbox | Simple/renderer-independent; normal data only | Best identified parcels |
| 3 — Search PCI geometry | Feature handling proven, schema not | Search/GeoJSON, not viewport proven | Paged; reuse normal-page results | Complement |
| 4 — GPKG | Official projection; content uninspected | selected IDs ≤500, not viewport | User-triggered + parse GPKG | Optional import |

## Recommended architecture

### Selected/identified parcels

Use **Option 2**: observe/reuse a contour result already obtained by the
normal page, keyed by existing `id_par`. A normal-page Option-3 result is a
richer alternative. Never manufacture API calls; omit MAJIC/owner data.

### Exact visible viewport

Use **Option 1**. PCI has neither bbox input nor proven exact-viewport
enumeration; contour needs IDs and GPKG is selected results. MVT is therefore
still required for this need.

## Recommended next experiment

Without traffic, inspect a previously page-obtained contour/search response
through the redacted passive boundary or a user-supplied local artefact:
envelope, geometry type, CRS indication, and minimal non-personal properties.
Then compare it to an already loaded MVT tile for one identified parcel.

## Evidence table

| Artifact | Symbol/function | Finding | Confidence |
| --- | --- | --- | --- |
| resultat-recherche | `U(e,o)` | button/class/limit/CRS/download | HIGH |
| resultat-recherche | `z(i)` | builds ID array | HIGH |
| requests | `getGpkFile` | route, POST, fields, blob/error | HIGH |
| resultat-recherche | contour invocation | IDs → showParcelles/setGeojson | HIGH |
| requests | `getParcelleContourPCI` | route and form-urlencoded body | HIGH |
| requests | filter/intersect helpers | geometry search/paging | HIGH |
| both | contour consumer | schema omitted | HIGH |
| resultat-recherche | INSEE / `majicAuthorized` | guards, not SIG proof | MEDIUM |

## Architectural classification

**A — SOURCE-PROVEN NORMAL-PAGE PIPELINE.** Client/UI paths are proven from
the real supplied source, with schema and authorization limits retained.
