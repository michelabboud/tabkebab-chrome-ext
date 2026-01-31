// core/engine/solver-ai.js — AI-powered Phase 2 solver (semantic grouping)

import { AIClient } from '../ai/ai-client.js';
import { Prompts } from '../ai/prompts.js';
import {
  COLOR_PALETTE, WINDOW_CAP,
  createDomainSlot, createWindowSlot, createDesiredState,
} from './types.js';

const BATCH_SIZE = 100; // Max tabs per AI request

/**
 * AI-powered solver: replaces domain-based grouping with semantic grouping.
 * Returns a DesiredState on success, or null on any failure
 * (caller should fall back to the deterministic solver).
 *
 * @param {Object} snapshot - The Phase 1 snapshot
 * @param {function} [onProgress] - Progress callback (detail string)
 * @returns {Promise<Object|null>} DesiredState or null
 */
export async function solveWithAI(snapshot, onProgress) {
  // Filter to real tabs (skip chrome://, extension pages, etc.)
  const tabs = snapshot.tabs.filter(t => {
    const url = t.url || '';
    return url.startsWith('http://') || url.startsWith('https://');
  });

  if (tabs.length === 0) return null;

  onProgress?.('Analyzing tabs with AI...');

  // Batch large tab sets
  const batches = [];
  for (let i = 0; i < tabs.length; i += BATCH_SIZE) {
    batches.push(tabs.slice(i, i + BATCH_SIZE));
  }

  let allGroups = [];

  for (let i = 0; i < batches.length; i++) {
    if (batches.length > 1) {
      onProgress?.(`AI analyzing batch ${i + 1}/${batches.length}...`);
    }

    const batch = batches[i];

    const response = await AIClient.complete({
      systemPrompt: Prompts.smartGrouping.system,
      userPrompt: Prompts.smartGrouping.buildUserPrompt(batch),
      maxTokens: 1024,
      temperature: 0.3,
      responseFormat: 'json',
    });

    if (!response.parsed?.groups || !Array.isArray(response.parsed.groups)) {
      return null; // Malformed response — fall back
    }

    // Map tabIndices back to actual tab IDs
    const groups = response.parsed.groups
      .filter(g => g.name && Array.isArray(g.tabIndices))
      .map(g => ({
        name: g.name,
        color: g.color || 'blue',
        tabIds: g.tabIndices
          .filter(idx => idx >= 0 && idx < batch.length)
          .map(idx => batch[idx].id)
          .filter(Boolean),
      }))
      .filter(g => g.tabIds.length > 0);

    allGroups.push(...groups);
  }

  // Merge groups with the same name across batches
  if (batches.length > 1) {
    const merged = new Map();
    for (const g of allGroups) {
      const key = g.name.toLowerCase().trim();
      if (merged.has(key)) {
        merged.get(key).tabIds.push(...g.tabIds);
      } else {
        merged.set(key, { ...g });
      }
    }
    allGroups = [...merged.values()];
  }

  if (allGroups.length === 0) return null;

  onProgress?.(`AI found ${allGroups.length} groups, building layout...`);

  // Convert AI groups into WindowSlots + DesiredState
  return buildDesiredState(allGroups, tabs);
}

/**
 * Convert AI-generated groups into a DesiredState using bin-packing.
 */
function buildDesiredState(aiGroups, allTabs) {
  const windowSlots = [];
  const singles = [];
  const assignedTabIds = new Set();

  // Sort groups by size descending for better bin-packing
  aiGroups.sort((a, b) => b.tabIds.length - a.tabIds.length);

  let colorIndex = 0;

  // Validate and assign colors
  const validColors = new Set(COLOR_PALETTE);

  const bins = []; // { domains: DomainSlot[], totalTabs: number }

  for (const group of aiGroups) {
    if (group.tabIds.length === 0) continue;

    for (const id of group.tabIds) assignedTabIds.add(id);

    const color = validColors.has(group.color)
      ? group.color
      : COLOR_PALETTE[colorIndex++ % COLOR_PALETTE.length];

    const domainSlot = createDomainSlot({
      domain: group.name,
      tabIds: group.tabIds,
      color,
      label: group.name,
    });

    if (group.tabIds.length > WINDOW_CAP) {
      // Very large group gets its own window
      windowSlots.push(createWindowSlot({
        domains: [domainSlot],
        totalTabs: group.tabIds.length,
      }));
    } else {
      // Bin-pack into shared windows
      let placed = false;
      for (const bin of bins) {
        if (bin.totalTabs + group.tabIds.length <= WINDOW_CAP) {
          bin.domains.push(domainSlot);
          bin.totalTabs += group.tabIds.length;
          placed = true;
          break;
        }
      }
      if (!placed) {
        bins.push({ domains: [domainSlot], totalTabs: group.tabIds.length });
      }
    }
  }

  for (const bin of bins) {
    windowSlots.push(createWindowSlot({
      domains: bin.domains,
      totalTabs: bin.totalTabs,
    }));
  }

  // Unassigned tabs become singles
  for (const tab of allTabs) {
    if (!assignedTabIds.has(tab.id)) {
      singles.push({ domain: tab._domain || 'unknown', tabId: tab.id });
    }
  }

  return createDesiredState({ windowSlots, singles });
}
