export const DEFAULT_API_BASE = '';
export const API_BASE_STORAGE_KEY = 'menti_api_base';

/**
 * Validate and normalize an HTTP(S) API base URL without trailing slashes.
 * Empty values normalize to '' (same-origin mode).
 * @param {unknown} rawUrl
 * @returns {string}
 */
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

  const combined = `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '');
  return combined;
}

/**
 * Resolve API base URL using precedence: ?apiBase query > storage > defaultBase.
 * Invalid candidates are ignored safely.
 * @param {{ search?: string, storage?: { getItem?: (key: string) => string | null } | null, defaultBase?: string }} [options]
 * @returns {string}
 */
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
    // Ignore invalid query override and fall back.
  }

  try {
    const storedValue = storage?.getItem?.(API_BASE_STORAGE_KEY);
    if (storedValue && storedValue.trim()) {
      return normalizeApiBase(storedValue);
    }
  } catch {
    // Ignore invalid stored value or restricted storage.
  }

  try {
    return normalizeApiBase(defaultBase);
  } catch {
    return '';
  }
}
