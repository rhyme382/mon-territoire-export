const MAX_PATH_LENGTH = 512;

function safePathname(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (!decoded.startsWith('/') || decoded.length > MAX_PATH_LENGTH || /[\u0000-\u001f\u007f?#]/.test(decoded)) return null;
  return decoded;
}

export function normalizeUrl(input) {
  let parsed;
  try {
    parsed = new URL(input, typeof location === 'undefined' ? undefined : location.href);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return null;
  const pathname = safePathname(parsed.pathname);
  if (!pathname || !parsed.hostname) return null;
  const match = pathname.match(/\/(\d+)\/(\d+)\/(\d+)(?:\.[a-z0-9]+)?$/i);
  const zxy = match && match.slice(1).every(value => Number.isSafeInteger(Number(value)))
    ? { z: Number(match[1]), x: Number(match[2]), y: Number(match[3]) }
    : undefined;
  return { hostname: parsed.hostname, pathname, ...(zxy ? { zxy } : {}) };
}

export function sanitizeHeaderName(name) {
  if (typeof name !== 'string') return null;
  const normalized = name.trim().toLowerCase();
  if (!/^[a-z0-9-]{1,64}$/.test(normalized)) return null;
  return /^(authorization|cookie|set-cookie|proxy-authorization|x-api-key|x-auth-token)$/.test(normalized)
    ? null
    : normalized;
}
