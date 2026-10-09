import { GpkgSvgError } from './errors.js';

// Planar Y-up geometries -> local SVG pixel space (Y down), aspect preserved.

export function computeBounds(polygons) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const polygon of polygons) {
    for (const ring of polygon) {
      for (const [x, y] of ring) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (!Number.isFinite(minX)) throw new GpkgSvgError('EMPTY_GEOMETRY', 'Aucune coordonnée à convertir.');
  return { minX, minY, maxX, maxY };
}

export function createSvgTransform(bounds, { width = 1200, padding = 20 } = {}) {
  if (!(width > 0) || !Number.isFinite(width)) throw new GpkgSvgError('BAD_OPTION', '--width doit être un nombre > 0.');
  if (!(padding >= 0) || !Number.isFinite(padding) || padding * 2 >= width) {
    throw new GpkgSvgError('BAD_OPTION', '--padding doit être >= 0 et inférieur à la moitié de --width.');
  }
  const spanX = bounds.maxX - bounds.minX;
  const spanY = bounds.maxY - bounds.minY;
  if (spanX === 0 && spanY === 0) throw new GpkgSvgError('EMPTY_GEOMETRY', 'Emprise dégénérée (un seul point).');
  const inner = width - 2 * padding;
  const scale = spanX > 0 ? inner / spanX : Infinity;
  // Degenerate (zero-width) extents: fit the height to the same inner size.
  const effectiveScale = Number.isFinite(scale) ? scale : inner / spanY;
  const height = spanY * effectiveScale + 2 * padding;
  return {
    width,
    height,
    scale: effectiveScale,
    apply: ([x, y]) => [padding + (x - bounds.minX) * effectiveScale, padding + (bounds.maxY - y) * effectiveScale],
  };
}
