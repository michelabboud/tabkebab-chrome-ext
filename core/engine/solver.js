// core/engine/solver.js — Phase 2: Compute the desired end-state

import {
  SMALL_GROUP_LIMIT, SHARD_SIZE, WINDOW_CAP, COLOR_PALETTE,
  Tier, classifyDomain,
  createDomainSlot, createWindowSlot, createDesiredState,
} from './types.js';

/**
 * Takes a Snapshot, returns a DesiredState describing the ideal layout.
 *
 * Tier rules:
 *  - HUGE  (>100 tabs): shard into groups of SHARD_SIZE, each shard = own window
 *  - BIG   (31-100):    own dedicated window
 *  - SMALL (2-30):      bin-packed into shared windows (first-fit-decreasing)
 *  - SINGLE (1):        left in place, not grouped
 */
export function solve(snapshot) {
  const domainEntries = [...snapshot.tabsByDomain.entries()]
    .map(([domain, tabs]) => ({ domain, tabs, tier: classifyDomain(tabs.length) }))
    .sort((a, b) => b.tabs.length - a.tabs.length);

  const windowSlots = [];
  const singles = [];
  let colorIndex = 0;

  function nextColor() {
    return COLOR_PALETTE[colorIndex++ % COLOR_PALETTE.length];
  }

  // ── HUGE domains: shard into windows of SHARD_SIZE ──
  for (const entry of domainEntries) {
    if (entry.tier !== Tier.HUGE) continue;

    const tabIds = entry.tabs.map(t => t.id);
    const shardCount = Math.ceil(tabIds.length / SHARD_SIZE);
    const color = nextColor();

    for (let i = 0; i < shardCount; i++) {
      const shardIds = tabIds.slice(i * SHARD_SIZE, (i + 1) * SHARD_SIZE);
      const label = `${i + 1}-${entry.domain}`;
      const slot = createWindowSlot({
        domains: [createDomainSlot({ domain: entry.domain, tabIds: shardIds, color, label })],
        totalTabs: shardIds.length,
      });
      windowSlots.push(slot);
    }
  }

  // ── BIG domains: one window each ──
  for (const entry of domainEntries) {
    if (entry.tier !== Tier.BIG) continue;

    const tabIds = entry.tabs.map(t => t.id);
    const color = nextColor();
    const slot = createWindowSlot({
      domains: [createDomainSlot({ domain: entry.domain, tabIds, color, label: entry.domain })],
      totalTabs: tabIds.length,
    });
    windowSlots.push(slot);
  }

  // ── SMALL domains: first-fit-decreasing bin-pack ──
  const smallEntries = domainEntries
    .filter(e => e.tier === Tier.SMALL)
    .sort((a, b) => b.tabs.length - a.tabs.length); // already sorted, but ensure FFD

  const bins = []; // each bin = { domains: [], totalTabs: 0 }

  for (const entry of smallEntries) {
    const tabIds = entry.tabs.map(t => t.id);
    const color = nextColor();
    const domainSlot = createDomainSlot({ domain: entry.domain, tabIds, color, label: entry.domain });

    // First-fit: find a bin that can hold this domain
    let placed = false;
    for (const bin of bins) {
      if (bin.totalTabs + tabIds.length <= WINDOW_CAP) {
        bin.domains.push(domainSlot);
        bin.totalTabs += tabIds.length;
        placed = true;
        break;
      }
    }

    if (!placed) {
      bins.push({ domains: [domainSlot], totalTabs: tabIds.length });
    }
  }

  // Convert bins into WindowSlots
  for (const bin of bins) {
    windowSlots.push(createWindowSlot({
      domains: bin.domains,
      totalTabs: bin.totalTabs,
    }));
  }

  // ── SINGLE tabs: just record them, no grouping needed ──
  for (const entry of domainEntries) {
    if (entry.tier !== Tier.SINGLE) continue;
    singles.push({ domain: entry.domain, tabId: entry.tabs[0].id });
  }

  return createDesiredState({ windowSlots, singles });
}
