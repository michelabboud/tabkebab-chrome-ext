// core/engine/types.js — Constants, enums, and data structure factories

// ── Domain tier thresholds ──
export const SMALL_GROUP_LIMIT = 30;   // domain gets its own window above this
export const SHARD_SIZE = 100;          // sub-group size for huge domains
export const WINDOW_CAP = 100;          // soft cap on total tabs per window

// ── Rate-limiting ──
export const MOVE_BATCH_SIZE = 10;      // tabs moved per chrome.tabs.move call
export const BATCH_DELAY_MS = 300;      // pause between batches
export const DOMAIN_DELAY_MS = 500;     // pause between domain operations

// ── Chrome tab-group colors ──
export const COLOR_PALETTE = [
  'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'
];

// ── Domain tiers ──
export const Tier = Object.freeze({
  HUGE:   'huge',    // >100 tabs → shard, each shard = own window
  BIG:    'big',     // 31-100 tabs → own window
  SMALL:  'small',   // 2-30 tabs → bin-packed into shared windows
  SINGLE: 'single',  // 1 tab → left in place, not grouped
});

// ── Pipeline phases ──
export const Phase = Object.freeze({
  SNAPSHOT: 'snapshot',
  SOLVER:   'solver',
  PLANNER:  'planner',
  EXECUTOR: 'executor',
});

// ── Operation types for the move plan ──
export const OpType = Object.freeze({
  CREATE_WINDOW: 'CREATE_WINDOW',
  MOVE_TABS:     'MOVE_TABS',
  CREATE_GROUP:  'CREATE_GROUP',
  UPDATE_GROUP:  'UPDATE_GROUP',
  REMOVE_GROUP:  'REMOVE_GROUP',
});

// ── Factory: Snapshot ──
export function createSnapshot({ windows, tabs, tabGroups }) {
  const tabsById = new Map();
  const tabsByWindow = new Map();
  const tabsByDomain = new Map();
  const groupsById = new Map();

  for (const tab of tabs) {
    tabsById.set(tab.id, tab);

    if (!tabsByWindow.has(tab.windowId)) tabsByWindow.set(tab.windowId, []);
    tabsByWindow.get(tab.windowId).push(tab);

    const domain = tab._domain; // pre-classified by snapshot phase
    if (!tabsByDomain.has(domain)) tabsByDomain.set(domain, []);
    tabsByDomain.get(domain).push(tab);
  }

  for (const group of tabGroups) {
    groupsById.set(group.id, group);
  }

  return Object.freeze({
    windows,
    tabs,
    tabGroups,
    tabsById,
    tabsByWindow,
    tabsByDomain,
    groupsById,
  });
}

// ── Factory: DomainSlot (one domain group inside a window) ──
export function createDomainSlot({ domain, tabIds, color, label }) {
  return { domain, tabIds, color, label: label || domain };
}

// ── Factory: WindowSlot (a desired window in the end-state) ──
export function createWindowSlot({ id = null, domains = [], totalTabs = 0 }) {
  return { id, domains, totalTabs };
}

// ── Factory: DesiredState ──
export function createDesiredState({ windowSlots, singles }) {
  return Object.freeze({ windowSlots, singles });
}

// ── Factory: MovePlan ──
export function createMovePlan({ operations, stats }) {
  return Object.freeze({ operations, stats });
}

// ── Classify a domain by tab count ──
export function classifyDomain(tabCount) {
  if (tabCount > SHARD_SIZE) return Tier.HUGE;
  if (tabCount > SMALL_GROUP_LIMIT) return Tier.BIG;
  if (tabCount >= 2) return Tier.SMALL;
  return Tier.SINGLE;
}
