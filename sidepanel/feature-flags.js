// feature-flags.js — Settings → Features switches on the panel side.
//
// One place decides what a switched-off feature looks like in the panel:
//   - Static controls carry `data-feature="<name>"` (several names = needs all
//     of them, e.g. data-feature="ai commandBar"). applyFeatureFlags() toggles
//     the `feature-off` class on them (CSS: display:none).
//   - <body data-features-off="ai drive …"> lets CSS hide controls rendered
//     later (stash-card Drive buttons, .stash-btn, .ai-feature menu items).
//   - Components ask isFeatureEnabled(name) before doing feature work.
// Nothing is deleted: switching a feature back on shows everything again.

import { FEATURE_KEYS } from '../core/settings.js';
import { PRIMARY_VIEWS } from './panel-helpers.js';

export { FEATURE_KEYS };

/** Feature each primary/header view needs (views not listed are always on). */
export const VIEW_FEATURES = Object.freeze({
  windows: 'windows',
  stash: 'stash',
  sessions: 'sessions',
  focus: 'focus',
});

export const FEATURE_OFF_CLASS = 'feature-off';

function allOn() {
  return Object.fromEntries(FEATURE_KEYS.map((key) => [key, true]));
}

let current = allOn();
const listeners = new Set();

/** Every known feature as a boolean; anything missing or malformed reads ON. */
export function normalizeFeatures(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const key of FEATURE_KEYS) out[key] = source[key] !== false;
  return out;
}

export function getFeatureFlags() {
  return { ...current };
}

export function isFeatureEnabled(name, features = current) {
  return features?.[name] !== false;
}

/** True when every feature named in a `data-feature` value is on. */
export function featuresEnabled(spec, features = current) {
  return String(spec || '')
    .split(/\s+/)
    .filter(Boolean)
    .every((name) => isFeatureEnabled(name, features));
}

export function isViewEnabled(view, features = current) {
  const feature = VIEW_FEATURES[view];
  return !feature || isFeatureEnabled(feature, features);
}

/** Primary views in nav order, minus the switched-off ones. */
export function visiblePrimaryViews(features = current) {
  return PRIMARY_VIEWS.filter((view) => isViewEnabled(view, features));
}

/** Number-key shortcuts: 1..N over the visible primary views only. */
export function visibleViewShortcuts(features = current) {
  return Object.fromEntries(
    visiblePrimaryViews(features).map((view, index) => [String(index + 1), view]),
  );
}

/** Subscribe to switch changes. Returns an unsubscribe function. */
export function onFeatureFlagsChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Apply switches to the document: body data attribute + `feature-off` class
 * on every `[data-feature]` element. Notifies subscribers when a switch
 * changed (or always, with `{ force: true }`). Returns the applied switches.
 */
export function applyFeatureFlags(features, {
  root = globalThis.document,
  force = false,
} = {}) {
  const next = normalizeFeatures(features);
  const changed = FEATURE_KEYS.some((key) => next[key] !== current[key]);
  const previous = current;
  current = next;

  if (root) {
    const body = root.body || root;
    if (body?.dataset) {
      body.dataset.featuresOff = FEATURE_KEYS.filter((key) => !next[key]).join(' ');
    }
    const elements = root.querySelectorAll?.('[data-feature]') || [];
    for (const el of elements) {
      el.classList?.toggle(FEATURE_OFF_CLASS, !featuresEnabled(el.dataset?.feature, next));
    }
  }

  if (changed || force) {
    for (const listener of [...listeners]) {
      try {
        listener(getFeatureFlags(), previous);
      } catch (error) {
        console.warn('[TabKebab] feature switch listener failed:', error);
      }
    }
  }
  return getFeatureFlags();
}

/** Test seam: back to all-on with no subscribers. */
export function resetFeatureFlagsForTests() {
  current = allOn();
  listeners.clear();
}

/**
 * The view to fall back to when `view` is open and its feature is switched
 * off: always Tabs. Returns null when `view` can stay open.
 */
export function fallbackViewFor(view, features = current) {
  return isViewEnabled(view, features) ? null : 'tabs';
}

/** Sub-tab feature map inside the Tabs view. */
export const SUBTAB_FEATURES = Object.freeze({ duplicates: 'duplicates' });

export function fallbackSubtabFor(subtab, features = current) {
  const feature = SUBTAB_FEATURES[subtab];
  return feature && !isFeatureEnabled(feature, features) ? 'domains' : null;
}

/** Remove every `[data-feature]` node under `root` whose features are off. */
export function pruneDisabledFeatureNodes(root, features = current) {
  for (const el of root?.querySelectorAll?.('[data-feature]') || []) {
    if (!featuresEnabled(el.dataset?.feature, features)) el.remove();
  }
  return root;
}
