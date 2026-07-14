export function canonicalHostname(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const input = value.trim();
    const candidate = input.includes('://') ? input : `https://${input}`;
    return new URL(candidate).hostname.toLowerCase().replace(/\.$/, '') || null;
  } catch {
    return null;
  }
}

export function hostnameMatches(url, expectedHost) {
  const hostname = canonicalHostname(url);
  const expected = canonicalHostname(expectedHost);
  if (!hostname || !expected) return false;
  return hostname === expected || hostname.endsWith(`.${expected}`);
}
