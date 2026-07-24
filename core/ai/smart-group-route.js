import { ProviderId } from './provider.js';

const KEYED_PROVIDERS = new Set([
  ProviderId.OPENAI,
  ProviderId.CLAUDE,
  ProviderId.GEMINI,
]);

/**
 * Select the provider Smart Group should use without mutating saved settings.
 * An explicitly enabled, usable BYO provider wins. Otherwise Chrome's on-device
 * provider is the zero-configuration default.
 */
export function selectSmartGroupRoute(settings) {
  const providerId = settings?.providerId;
  if (settings?.enabled === true) {
    if (providerId === ProviderId.CHROME_AI) {
      return { mode: 'zero-config', providerId: ProviderId.CHROME_AI };
    }
    if (providerId === ProviderId.CUSTOM) {
      return { mode: 'configured', providerId };
    }
    if (
      KEYED_PROVIDERS.has(providerId) &&
      settings?.providerConfigs?.[providerId]?.hasApiKey === true
    ) {
      return { mode: 'configured', providerId };
    }
  }

  return { mode: 'zero-config', providerId: ProviderId.CHROME_AI };
}

/**
 * Collapse typed provider failures into the fixed categories the panel renders.
 * Raw provider/browser messages never cross into fallback copy.
 */
export function classifySmartGroupFailure(error) {
  if (
    error?.code === 'AI_UNAVAILABLE' ||
    error?.code === 'AI_FOREGROUND_REQUIRED'
  ) {
    return 'unavailable';
  }
  if (error?.code === 'AI_TIMEOUT' || error?.code === 'AI_ABORTED') {
    return 'timeout';
  }
  return 'failed';
}
