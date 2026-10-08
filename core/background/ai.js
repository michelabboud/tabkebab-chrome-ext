// core/background/ai.js — AI settings and provider actions, tab
// summarization, keep-awake classification, natural-language commands, and
// the Chrome built-in AI panel port.

import { AIClient } from '../ai/ai-client.js';
import { chromeAIBrokerClient } from '../ai/chrome-ai-broker-client.js';
import { CHROME_AI_PORT_NAME } from '../ai/chrome-ai-protocol.js';
import { ProviderId } from '../ai/provider.js';
import { Prompts } from '../ai/prompts.js';
import {
  filterTabs,
  executeNLAction,
  isValidTabFilter,
  NL_MUTATING_ACTIONS,
  buildNLConfirmation,
  nlActionRequiresConfirmation,
  overBroadFilterReason,
  sanitizeGroupColor,
  sanitizeGroupName,
} from '../nl-executor.js';
import { getAllTabs, extractDomain } from '../tabs-api.js';
import { withStateMutationLock } from '../state-mutation-lock.js';
import {
  MAX_RUNTIME_PORTABLE_STRING,
  isPlainRecord,
  requireExactRuntimeFields,
  requireRuntimeString,
} from './router.js';

// ── Chrome built-in AI panel port ──

export function attachChromeAIPort(port, client = chromeAIBrokerClient) {
  if (port?.name !== CHROME_AI_PORT_NAME) return false;
  client.attachPort(port);
  return true;
}

// ── AI request validation ──

const AI_PROVIDER_IDS = new Set(Object.values(ProviderId));

function requireAIProviderId(value) {
  if (typeof value !== 'string' || !AI_PROVIDER_IDS.has(value)) {
    throw new TypeError('AI provider is invalid');
  }
  return value;
}

function requireAIPassphrase(value, { optional = false } = {}) {
  if (optional && value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_RUNTIME_PORTABLE_STRING) {
    throw new TypeError(optional
      ? 'AI passphrase must be null or a non-empty bounded string'
      : 'AI passphrase must be a non-empty bounded string');
  }
  return value;
}

function normalizeAIModels(models) {
  if (!Array.isArray(models) || models.length > 1_000) {
    throw new TypeError('AI model list must be a bounded array');
  }
  const normalized = [];
  for (let index = 0; index < models.length; index += 1) {
    if (!Object.hasOwn(models, index)) {
      throw new TypeError('AI model list must be a dense array');
    }
    const model = models[index];
    if (!isPlainRecord(model)) throw new TypeError('AI model must be an object');
    const id = requireRuntimeString(model.id, 'AI model ID');
    const name = requireRuntimeString(model.name, 'AI model name');
    normalized.push({ id, name });
  }
  return normalized;
}

// ── Natural-language command helpers ──

function filterDestructiveTabs(tabs, filter) {
  const hasTitlePredicate = isPlainRecord(filter) &&
    Object.prototype.hasOwnProperty.call(filter, 'titleContains');
  const navigationSafeTabs = [];
  for (const tab of tabs) {
    const pendingUrl = typeof tab?.pendingUrl === 'string' ? tab.pendingUrl.trim() : '';
    if (!pendingUrl) {
      navigationSafeTabs.push(tab);
      continue;
    }
    // Chrome exposes the destination URL during navigation but retains the
    // committed page title. Destructive title predicates therefore have no
    // authoritative value to evaluate until navigation settles.
    if (hasTitlePredicate) continue;
    navigationSafeTabs.push({ ...tab, url: pendingUrl, pendingUrl: '' });
  }
  return filterTabs(navigationSafeTabs, filter);
}

function filterNLMatches(action, tabs, filter) {
  return action === 'close'
    ? filterDestructiveTabs(tabs, filter)
    : filterTabs(tabs, filter);
}

// Only fields the worker itself derived or validated are round-tripped to the
// panel for confirmation. AI-authored prose (e.g. `confirmation`) is dropped.
function buildConfirmableCommand(parsed, matchingTabs) {
  const command = {
    action: parsed.action,
    filter: { ...parsed.filter },
    tabIds: matchingTabs.map((tab) => tab.id),
  };
  if (parsed.action === 'group') {
    command.groupName = sanitizeGroupName(parsed.groupName);
    command.color = sanitizeGroupColor(parsed.color);
  }
  return command;
}

function isValidNLConfirmation(parsedCommand) {
  if (!isPlainRecord(parsedCommand) || !NL_MUTATING_ACTIONS.includes(parsedCommand.action)) {
    return false;
  }
  if (!isValidTabFilter(parsedCommand.filter)) return false;
  if (!Array.isArray(parsedCommand.tabIds) || parsedCommand.tabIds.length === 0) return false;
  if (!parsedCommand.tabIds.every((tabId) => Number.isInteger(tabId) && tabId >= 0)) return false;
  return new Set(parsedCommand.tabIds).size === parsedCommand.tabIds.length;
}

// ── Message handlers ──

export const aiHandlers = {
  // ── AI Settings ──

  async getAISettings(msg, ctx) {
    const { aiClient = AIClient } = ctx;
    requireExactRuntimeFields(msg, ['action'], 'AI settings request');
    return aiClient.getPublicSettings();
  },

  async needsAIPassphrase(msg, ctx) {
    const { aiClient = AIClient } = ctx;
    requireExactRuntimeFields(
      msg,
      ['action', 'providerId'],
      'AI passphrase-status request',
    );
    const providerId = requireAIProviderId(msg.providerId);
    return { needsPassphrase: Boolean(await aiClient.needsPassphrase(providerId)) };
  },

  async unlockAIApiKey(msg, ctx) {
    const { aiClient = AIClient } = ctx;
    requireExactRuntimeFields(
      msg,
      ['action', 'providerId', 'passphrase'],
      'AI unlock request',
    );
    const providerId = requireAIProviderId(msg.providerId);
    const passphrase = requireAIPassphrase(msg.passphrase);
    return withStateMutationLock(async () => {
      await aiClient.unlockApiKey(providerId, passphrase);
      return { unlocked: true };
    });
  },

  async saveAISettings(msg, ctx) {
    const { aiClient = AIClient } = ctx;
    requireExactRuntimeFields(
      msg,
      ['action', 'settings', 'keyUpdates', 'passphrase'],
      'AI settings save request',
    );
    const passphrase = requireAIPassphrase(msg.passphrase, { optional: true });
    return withStateMutationLock(async () => {
      const result = await aiClient.saveConfiguration(msg.settings, msg.keyUpdates, passphrase);
      if (result?.saved !== true || typeof result.unlocked !== 'boolean') {
        throw new TypeError('AI settings save returned an invalid result');
      }
      return { saved: true, unlocked: result.unlocked };
    });
  },

  async isAIAvailable(msg, ctx) {
    const { aiClient = AIClient } = ctx;
    requireExactRuntimeFields(msg, ['action'], 'AI availability request');
    return { available: Boolean(await aiClient.isAvailable()) };
  },

  async testAIConnection(msg, ctx) {
    const { aiClient = AIClient } = ctx;
    requireExactRuntimeFields(
      msg,
      ['action', 'providerId'],
      'AI connection-test request',
    );
    const providerId = requireAIProviderId(msg.providerId);
    return { success: Boolean(await aiClient.testConnection(providerId)) };
  },

  async clearAICache(msg, ctx) {
    const { aiClient = AIClient } = ctx;
    requireExactRuntimeFields(msg, ['action'], 'AI cache-clear request');
    await aiClient.clearCache();
    return { success: true };
  },

  async listModels(msg, ctx) {
    const { aiClient = AIClient } = ctx;
    requireExactRuntimeFields(msg, ['action', 'providerId'], 'AI model-list request');
    const providerId = requireAIProviderId(msg.providerId);
    const models = await aiClient.listModels(providerId);
    return { models: normalizeAIModels(models) };
  },

  // ── AI Tab Summarization ──

  async summarizeTabs(msg) {
    const allTabs = await getAllTabs({ allWindows: true });
    const targetTabs = allTabs.filter(t => msg.tabIds.includes(t.id));

    if (targetTabs.length === 0) {
      return { summaries: [] };
    }

    // Batch in chunks of 50
    const BATCH = 50;
    const allSummaries = [];

    for (let i = 0; i < targetTabs.length; i += BATCH) {
      const batch = targetTabs.slice(i, i + BATCH);
      const response = await AIClient.complete({
        systemPrompt: Prompts.tabSummary.system,
        userPrompt: Prompts.tabSummary.buildUserPrompt(batch),
        maxTokens: 1024,
        temperature: 0.2,
        responseFormat: 'json',
      });

      if (response.parsed?.summaries && Array.isArray(response.parsed.summaries)) {
        for (const s of response.parsed.summaries) {
          if (typeof s.index !== 'number' || s.index < 0 || s.index >= batch.length) continue;
          const tab = batch[s.index];
          if (tab && typeof s.summary === 'string') {
            allSummaries.push({ tabId: tab.id, summary: s.summary });
          }
        }
      }
    }

    return { summaries: allSummaries };
  },

  // ── AI Natural Language Commands ──

  async executeNLCommand(msg) {
    const promptTabs = await getAllTabs({ allWindows: true });
    const tabContext = Prompts.nlCommand.buildTabContext(promptTabs);

    const response = await AIClient.complete({
      systemPrompt: Prompts.nlCommand.system,
      userPrompt: Prompts.nlCommand.buildUserPrompt(msg.command, tabContext),
      maxTokens: 512,
      temperature: 0.1,
      responseFormat: 'json',
    });

    if (!response.parsed || typeof response.parsed !== 'object') {
      return { error: 'Could not understand that command' };
    }

    const parsed = response.parsed;
    if (!parsed.action || typeof parsed.action !== 'string') {
      return { error: 'AI returned an invalid action' };
    }
    const liveTabs = await getAllTabs({ allWindows: true });
    const matchingTabs = filterNLMatches(parsed.action, liveTabs, parsed.filter);

    if (matchingTabs.length === 0) {
      return { error: 'No tabs matched that description' };
    }

    if (NL_MUTATING_ACTIONS.includes(parsed.action)) {
      const broad = overBroadFilterReason(parsed.filter, matchingTabs.length, liveTabs.length);
      if (broad) return { error: broad };
    }

    // Destructive and wide-reaching actions require confirmation. The text is
    // derived from the live match set, never from AI-authored prose.
    if (nlActionRequiresConfirmation(parsed.action, matchingTabs)) {
      return {
        confirmation: buildNLConfirmation(parsed.action, matchingTabs, parsed),
        parsedCommand: buildConfirmableCommand(parsed, matchingTabs),
      };
    }

    // Small, single-window, non-destructive actions execute immediately
    return executeNLAction(parsed, matchingTabs);
  },

  async confirmNLCommand(msg) {
    const { parsedCommand } = msg;
    if (!isValidNLConfirmation(parsedCommand)) {
      return { error: 'Invalid command confirmation' };
    }

    const approvedIds = new Set(parsedCommand.tabIds);
    const allTabs = await getAllTabs({ allWindows: true });
    const matchingTabs = filterNLMatches(parsedCommand.action, allTabs, parsedCommand.filter)
      .filter((tab) => approvedIds.has(tab.id));
    if (matchingTabs.length === 0) {
      return { error: 'No tabs matched that description' };
    }

    return executeNLAction({
      action: parsedCommand.action,
      groupName: parsedCommand.groupName,
      color: parsedCommand.color,
      tabIds: matchingTabs.map((tab) => tab.id),
    }, matchingTabs);
  },

  // ── AI keep-awake suggestions ──

  async classifyKeepAwake() {
    const allTabs = await getAllTabs({ allWindows: true });
    const response = await AIClient.complete({
      systemPrompt: Prompts.keepAwake.system,
      userPrompt: Prompts.keepAwake.buildUserPrompt(allTabs),
      maxTokens: 1024,
      temperature: 0.2,
      responseFormat: 'json',
    });

    if (!response.parsed?.keepAwake || !Array.isArray(response.parsed.keepAwake)) {
      return { suggestions: [] };
    }

    // Deduplicate by domain
    const seen = new Set();
    const suggestions = [];
    for (const item of response.parsed.keepAwake) {
      if (!item || typeof item !== 'object') continue;
      const tab = (typeof item.index === 'number' && item.index >= 0 && item.index < allTabs.length)
        ? allTabs[item.index] : null;
      const domain = tab ? extractDomain(tab.url) : (typeof item.domain === 'string' ? item.domain : null);
      if (domain && !seen.has(domain)) {
        seen.add(domain);
        suggestions.push({ domain, reason: item.reason || '' });
      }
    }

    return { suggestions };
  },
};
