import { GpkgSvgError } from './errors.js';

// CRS strategies: map source coordinates to a planar, Y-up metric-ish plane.
// Add new CRS handlers here; the rest of the pipeline only sees projected XY.

const EARTH_RADIUS = 6378137;
const MAX_MERCATOR_LAT = 85.0511287798;

export function webMercator([lon, lat]) {
  if (lon < -180 || lon > 180 || lat < -MAX_MERCATOR_LAT || lat > MAX_MERCATOR_LAT) {
    throw new GpkgSvgError('COORD_OUT_OF_RANGE', 'Coordonnées hors du domaine EPSG:4326 / Web Mercator.');
  }
  const rad = Math.PI / 180;
  return [EARTH_RADIUS * lon * rad, EARTH_RADIUS * Math.log(Math.tan(Math.PI / 4 + (lat * rad) / 2))];
}

const identity = (point) => point;

export function resolveProjection(srs) {
  const label = srs.authority && srs.code != null ? `${srs.authority}:${srs.code}` : `srs_id=${srs.srsId}`;
  if (srs.authority === 'EPSG' && srs.code === 4326) {
    return {
      sourceCrs: label,
      transformation: 'EPSG:4326 -> Web Mercator (sphérique, EPSG:3857) -> mise à l\'échelle uniforme + inversion Y',
      project: webMercator,
    };
  }
  if (srs.authority === 'EPSG' && srs.code === 3857) {
    return { sourceCrs: label, transformation: 'EPSG:3857 (déjà plan) -> mise à l\'échelle uniforme + inversion Y', project: identity };
  }
  if (/^\s*PROJCS\s*\[/i.test(srs.definition) || /^\s*PROJCRS\s*\[/i.test(srs.definition)) {
    return { sourceCrs: label, transformation: `${label} (CRS projeté, plan métrique) -> mise à l'échelle uniforme + inversion Y`, project: identity };
  }
  throw new GpkgSvgError('UNSUPPORTED_CRS', `CRS source non supporté (${label}) : EPSG:4326, EPSG:3857 ou CRS projeté attendu.`);
}
