import { normalizeUrl } from './sanitize.js';

const DEFAULT_LIMITS = Object.freeze({ maxResources: 200, maxText: 96, maxLayers: 24, maxProperties: 64 });
const MIME = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:;\s*charset=[a-z0-9._-]+)?$/i;
const TYPE = new Set(['resource', 'transport-error', 'unreadable', 'dom', 'leaflet']);

function boundedText(value, limit) {
  return typeof value === 'string' && value.length <= limit && !/[\u0000-\u001f]/.test(value) ? value : undefined;
}
function boundedNumber(value) { return Number.isSafeInteger(value) && value >= 0 ? value : undefined; }
function sanitizedMvt(mvt, limits) {
  if (!mvt || typeof mvt !== 'object') return undefined;
  const layers = Array.isArray(mvt.layers) ? mvt.layers.slice(0, limits.maxLayers).map(layer => {
    const name = boundedText(layer?.name, limits.maxText);
    if (!name) return null;
    const propertyNames = Array.isArray(layer.propertyNames)
      ? layer.propertyNames.slice(0, limits.maxProperties).map(p => boundedText(p, limits.maxText)).filter(Boolean)
      : [];
    const geometryTypes = {};
    for (const type of ['Point', 'LineString', 'Polygon']) {
      const count = boundedNumber(layer?.geometryTypes?.[type]);
      if (count !== undefined) geometryTypes[type] = count;
    }
    return { name, ...(boundedNumber(layer.extent) !== undefined ? { extent: boundedNumber(layer.extent) } : {}), propertyNames, geometryTypes };
  }).filter(Boolean) : [];
  return { layers, ...(boundedNumber(mvt.featureCount) !== undefined ? { featureCount: boundedNumber(mvt.featureCount) } : {}), ...(boundedNumber(mvt.vertexCount) !== undefined ? { vertexCount: boundedNumber(mvt.vertexCount) } : {}) };
}

export function createLedger(options = {}) {
  const limits = { ...DEFAULT_LIMITS, ...options };
  const resources = [];
  const facts = [];
  let knownBytes = 0;
  let pbfFeatures = 0;
  let vertices = 0;

  function observeResource(fact = {}) {
    if (resources.length >= limits.maxResources) return false;
    const url = normalizeUrl(fact.url);
    if (!url) return false;
    const item = { ...url };
    const bytes = boundedNumber(fact.bytes);
    if (bytes !== undefined) { item.bytes = bytes; knownBytes += bytes; }
    const mime = boundedText(fact.mime, limits.maxText);
    if (mime && MIME.test(mime)) item.mime = mime;
    const type = TYPE.has(fact.type) ? fact.type : undefined;
    if (type && type !== 'resource') item.status = type;
    const mvt = sanitizedMvt(fact.mvt, limits);
    if (mvt) {
      item.mvt = mvt;
      pbfFeatures += mvt.featureCount || 0;
      vertices += mvt.vertexCount || 0;
    }
    resources.push(item);
    return true;
  }
  function observeFact(fact = {}) {
    if (!TYPE.has(fact.type) || fact.type === 'resource' || facts.length >= limits.maxResources) return false;
    const detail = boundedText(fact.detail, limits.maxText);
    facts.push({ type: fact.type, ...(detail ? { detail } : {}) });
    return true;
  }
  function toSanitizedReport() {
    return {
      schemaVersion: 1,
      privacy: {
        queryStrings: 'removed', headers: 'not-retained', credentials: 'not-retained',
        responseBodies: 'not-retained', propertyValues: 'not-retained', coordinates: 'not-retained'
      },
      resources: resources.map(item => structuredClone(item)),
      facts: facts.map(item => structuredClone(item)),
      totals: { resourceCount: resources.length, knownBytes, pbfFeatures, vertices },
      availability: { leaflet: 'unknown', bounds: 'unavailable', crs: 'unavailable', pixelOrigin: 'unavailable' }
    };
  }
  return { observeResource, observeFact, toSanitizedReport };
}
