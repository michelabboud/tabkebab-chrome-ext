// core/focus-policy.js — Pure Focus allowlist construction, rebinding, and evaluation

import { checkAgainstBlocklists } from './focus-blocklists.js';

function tabUrl(tabOrUrl) {
  if (typeof tabOrUrl === 'string') return tabOrUrl;
  return tabOrUrl?.pendingUrl || tabOrUrl?.url || '';
}

function canonicalUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    return new URL(value.trim()).href;
  } catch {
    return null;
  }
}

function canonicalDomain(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const candidate = value.trim();

  try {
    const parsed = new URL(`https://${candidate}`);
    if (
      parsed.username ||
      parsed.password ||
      parsed.port ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash
    ) {
      return null;
    }
    return parsed.hostname.toLowerCase().replace(/\.+$/, '') || null;
  } catch {
    return null;
  }
}

function urlHostname(value) {
  const url = tabUrl(value);
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.+$/, '') || null;
  } catch {
    return null;
  }
}

/** Return true for pages owned by Chrome or an installed extension. */
export function isInternalUrl(value) {
  const url = tabUrl(value).trim().toLowerCase();
  return url.startsWith('chrome://') || url.startsWith('chrome-extension://');
}

/** Match legacy string and typed-domain entries by exact host or true subdomain. */
export function domainMatches(url, allowList) {
  if (!Array.isArray(allowList) || allowList.length === 0) return false;
  const hostname = urlHostname(url);
  if (!hostname) return false;

  return allowList.some((entry) => {
    const rawDomain = typeof entry === 'string'
      ? entry
      : entry?.type === 'domain' ? entry.value : null;
    const domain = canonicalDomain(rawDomain);
    return Boolean(domain && (hostname === domain || hostname.endsWith(`.${domain}`)));
  });
}

/** Match typed URL entries after URL canonicalization, with no prefix behavior. */
export function urlMatches(url, allowList) {
  if (!Array.isArray(allowList) || allowList.length === 0) return false;
  const candidate = canonicalUrl(tabUrl(url));
  if (!candidate) return false;

  return allowList.some((entry) => (
    entry?.type === 'url' && canonicalUrl(entry.value) === candidate
  ));
}

/** Match only current runtime group IDs produced by title rebinding. */
export function groupMatches(tab, allowList) {
  if (!tab || typeof tab !== 'object' || !Number.isInteger(tab.groupId) || tab.groupId < 0) {
    return false;
  }
  if (!Array.isArray(allowList) || allowList.length === 0) return false;

  return allowList.some((entry) => (
    entry?.type === 'group' &&
    Array.isArray(entry.groupIds) &&
    entry.groupIds.includes(tab.groupId)
  ));
}

/** Apply the complete Focus allowlist predicate to a tab or URL. */
export function isAllowed(tabOrUrl, allowList) {
  if (isInternalUrl(tabOrUrl)) return true;
  if (!Array.isArray(allowList) || allowList.length === 0) return false;
  if (domainMatches(tabOrUrl, allowList)) return true;
  if (urlMatches(tabOrUrl, allowList)) return true;
  return typeof tabOrUrl === 'object' && groupMatches(tabOrUrl, allowList);
}

/** Build one stable, title-based preference entry from panel input. */
export function createAllowlistEntry(type, value, liveGroups = []) {
  if (type === 'domain') {
    const domain = canonicalDomain(value);
    return domain ? { type: 'domain', value: domain } : null;
  }

  if (type === 'url') {
    const url = canonicalUrl(value);
    return url ? { type: 'url', value: url } : null;
  }

  if (type !== 'group' || !Array.isArray(liveGroups)) return null;

  let groupId = null;
  if (Number.isInteger(value)) {
    groupId = value;
  } else if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    groupId = Number(value.trim());
  }
  if (!Number.isInteger(groupId)) return null;

  const group = liveGroups.find((candidate) => candidate?.id === groupId);
  if (!group || typeof group.title !== 'string' || !group.title.trim()) return null;
  return { type: 'group', value: group.title };
}

/** Normalize title-only preferences and keep one entry per stable type/value identity. */
export function normalizeAllowlistPreferences(allowList) {
  if (!Array.isArray(allowList)) return [];

  const normalized = [];
  const identities = new Set();
  for (const candidate of allowList) {
    let entry = null;
    if (typeof candidate === 'string') {
      entry = createAllowlistEntry('domain', candidate);
    } else if (candidate?.type === 'domain' || candidate?.type === 'url') {
      entry = createAllowlistEntry(candidate.type, candidate.value);
    } else if (
      candidate?.type === 'group' &&
      typeof candidate.value === 'string' &&
      candidate.value.trim()
    ) {
      entry = { type: 'group', value: candidate.value };
    }

    if (!entry) continue;
    const identity = JSON.stringify([entry.type, entry.value]);
    if (identities.has(identity)) continue;
    identities.add(identity);
    normalized.push(entry);
  }
  return normalized;
}

/** Resolve title-only group preferences to every matching live Chrome group ID. */
export function resolveGroupAllowlist(allowList, liveGroups = []) {
  if (!Array.isArray(allowList)) return [];
  const groups = Array.isArray(liveGroups) ? liveGroups : [];

  return allowList.map((entry) => {
    if (!entry || typeof entry !== 'object') return entry;
    if (entry.type !== 'group') return structuredClone(entry);

    const groupIds = [...new Set(groups
      .filter((group) => (
        group?.title === entry.value && Number.isInteger(group.id) && group.id >= 0
      ))
      .map((group) => group.id))];

    return { type: 'group', value: entry.value, groupIds };
  });
}

/** Return a new runtime state whose group allowlist reflects current Chrome groups. */
export function rebindFocusAllowlist(state, liveGroups) {
  if (!state || typeof state !== 'object') return state ?? null;
  return {
    ...state,
    allowedDomains: resolveGroupAllowlist(state.allowedDomains, liveGroups),
  };
}

/** Evaluate deterministic Focus blocking in the approved priority order. */
export function evaluateFocusPolicy(tabOrUrl, state) {
  if (isInternalUrl(tabOrUrl) || isAllowed(tabOrUrl, state?.allowedDomains)) {
    return { blocked: false, reason: null, category: null };
  }

  if (domainMatches(tabOrUrl, state?.blockedDomains)) {
    return { blocked: true, reason: 'blocklist', category: 'Blocked Domain' };
  }

  if (state?.strictMode) {
    return { blocked: true, reason: 'strict', category: 'Not in allowed list' };
  }

  const hostname = urlHostname(tabOrUrl);
  if (hostname && state?.blockedCategories?.length > 0) {
    const result = checkAgainstBlocklists(hostname, state.blockedCategories);
    if (result.blocked) {
      return { blocked: true, reason: 'category', category: result.category };
    }
  }

  return { blocked: false, reason: null, category: null };
}
