export const DEFAULT_API_BASE = '';
export const API_BASE_STORAGE_KEY = 'menti_api_base';

// Restricts runtime API overrides to HTTP(S) origins without trailing slashes.
export function normalizeApiBase(rawUrl) {
  if (rawUrl === null || rawUrl === undefined) return '';
  const trimmed = String(rawUrl).trim();
  if (!trimmed) return '';

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('INVALID_API_BASE');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('INVALID_API_BASE');
  }

  return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '');
}

// Resolves API base URL with precedence: ?apiBase query > storage > defaultBase.
export function resolveApiBase({
  search = '',
  storage = null,
  defaultBase = DEFAULT_API_BASE,
} = {}) {
  try {
    const queryValue = new URLSearchParams(search).get('apiBase');
    if (queryValue && queryValue.trim()) {
      return normalizeApiBase(queryValue);
    }
  } catch {
    // Ignore malformed query parameter and fall back to stored or default base.
  }

  try {
    const storedValue = storage?.getItem?.(API_BASE_STORAGE_KEY);
    if (storedValue && storedValue.trim()) {
      return normalizeApiBase(storedValue);
    }
  } catch {
    // Storage access can throw in restricted contexts; fall back to default.
  }

  try {
    return normalizeApiBase(defaultBase);
  } catch {
    return '';
  }
}
