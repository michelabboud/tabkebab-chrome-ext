// service-worker.js — Background service worker (Manifest V3)

import { getAllTabsGroupedByDomain, applyDomainGroupsToChrome, applySmartGroupsToChrome, getWindowStats, consolidateWindows } from './core/grouping.js';
import { findDuplicates } from './core/duplicates.js';
import { saveSession, restoreSession, listSessions, deleteSession } from './core/sessions.js';
import { getAllTabs, focusTab, closeTabs, createNativeGroup, ungroupTabs, extractDomain } from './core/tabs-api.js';
import { AIClient } from './core/ai/ai-client.js';
import { Prompts } from './core/ai/prompts.js';
import { filterTabs, executeNLAction } from './core/nl-executor.js';
import { Storage } from './core/storage.js';
import { saveStash, listStashes as listStashesDB, getStash, deleteStash as deleteStashDB, restoreStashTabs, importStashes as importStashesDB } from './core/stash-db.js';

// ── Keep Awake Defaults ──

const DEFAULT_KEEP_AWAKE_DOMAINS = [
  'gmail.com', 'outlook.com', 'outlook.live.com', 'mail.yahoo.com', 'proton.me',
  'calendar.google.com', 'outlook.office.com',
  'claude.ai', 'chat.openai.com', 'aistudio.google.com', 'gemini.google.com', 'codex.openai.com',
];

async function getKeepAwakeList() {
  let list = await Storage.get('keepAwakeDomains');
  if (list === null) {
    list = [...DEFAULT_KEEP_AWAKE_DOMAINS];
    await Storage.set('keepAwakeDomains', list);
  }
  return list;
}

// ── Auto-save Sessions ──

const AUTO_SAVE_PREFIX = '[Auto] ';
const AUTO_SAVE_ALARM = 'autoSaveSession';
const AUTO_SAVE_INTERVAL_MIN = 60 * 24; // 24 hours

async function autoSaveSession() {
  try {
    const tabs = await getAllTabs({ allWindows: true });
    // Skip auto-save if browser has no real tabs open
    if (tabs.length <= 1) return;

    const date = new Date();
    const dateStr = date.toLocaleDateString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
    const name = `${AUTO_SAVE_PREFIX}${dateStr}`;

    await saveSession(name, true);

    // Rolling retention: keep only the 2 most recent auto-saves
    const sessions = (await Storage.get('sessions')) || [];
    const autoSaves = sessions.filter(s => s.name.startsWith(AUTO_SAVE_PREFIX));

    if (autoSaves.length > 2) {
      // autoSaves are already newest-first (sessions.unshift in saveSession)
      const toDelete = autoSaves.slice(2);
      const idsToDelete = new Set(toDelete.map(s => s.id));
      const filtered = sessions.filter(s => !idsToDelete.has(s.id));
      await Storage.set('sessions', filtered);
    }
  } catch {
    // Auto-save should never crash the service worker
  }
}

// Auto-save on browser startup
chrome.runtime.onStartup.addListener(() => {
  // Small delay to let tabs finish loading
  setTimeout(autoSaveSession, 5000);
});

// Auto-save on extension install/update
chrome.runtime.onInstalled.addListener(() => {
  setTimeout(autoSaveSession, 5000);
  // Set up the recurring 24h alarm
  chrome.alarms.create(AUTO_SAVE_ALARM, { periodInMinutes: AUTO_SAVE_INTERVAL_MIN });
});

// Handle the 24h alarm
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === AUTO_SAVE_ALARM) {
    autoSaveSession();
  }
});

// Ensure alarm exists (service worker can restart, losing onInstalled)
chrome.alarms.get(AUTO_SAVE_ALARM, (alarm) => {
  if (!alarm) {
    chrome.alarms.create(AUTO_SAVE_ALARM, { periodInMinutes: AUTO_SAVE_INTERVAL_MIN });
  }
});

// Open side panel when extension icon is clicked
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// Notify side panel when tabs change
function notifyPanel() {
  chrome.runtime.sendMessage({ type: 'tabsChanged' }).catch(() => {
    // Side panel not open — ignore
  });
}

chrome.tabs.onCreated.addListener(notifyPanel);
chrome.tabs.onRemoved.addListener(notifyPanel);
chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  if (changeInfo.status === 'complete' || changeInfo.url) {
    notifyPanel();
  }
});

// Message handler — side panel communicates via chrome.runtime.sendMessage
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message).then(sendResponse).catch(err => {
    sendResponse({ error: err.message });
  });
  return true; // keep channel open for async response
});

async function handleMessage(msg) {
  switch (msg.action) {
    case 'getTabs':
      return getAllTabs({ allWindows: msg.allWindows ?? true });

    case 'getGroupedTabs':
      return getAllTabsGroupedByDomain();

    case 'applyDomainGroups': {
      const result = await applyDomainGroupsToChrome((progress) => {
        // Send progress updates to the side panel
        chrome.runtime.sendMessage({
          type: 'groupingProgress',
          ...progress
        }).catch(() => {});
      });
      return { success: true, ...result };
    }

    case 'findDuplicates':
      return findDuplicates();

    case 'closeTabs':
      await closeTabs(msg.tabIds);
      return { success: true };

    case 'focusTab':
      await focusTab(msg.tabId);
      return { success: true };

    case 'saveSession':
      return saveSession(msg.name);

    case 'restoreSession':
      return restoreSession(msg.sessionId, msg.options);

    case 'listSessions':
      return listSessions();

    case 'deleteSession':
      await deleteSession(msg.sessionId);
      return { success: true };

    case 'createTabGroup':
      return createNativeGroup(msg.tabIds, msg.title, msg.color);

    case 'ungroupTabs':
      await ungroupTabs(msg.tabIds);
      return { success: true };

    case 'setGroupCollapsed':
      await chrome.tabGroups.update(msg.groupId, { collapsed: msg.collapsed });
      return { success: true };

    case 'getChromeGroups': {
      const groups = await chrome.tabGroups.query({});
      const result = [];
      for (const g of groups) {
        const tabs = await chrome.tabs.query({ groupId: g.id });
        result.push({
          id: g.id,
          title: g.title || 'Untitled',
          color: g.color,
          collapsed: g.collapsed,
          windowId: g.windowId,
          tabs: tabs.map(t => ({
            id: t.id, title: t.title, url: t.url, favIconUrl: t.favIconUrl,
          })),
        });
      }
      return result;
    }

    case 'getWindowStats':
      return getWindowStats();

    case 'consolidateWindows': {
      const result = await consolidateWindows((progress) => {
        chrome.runtime.sendMessage({
          type: 'consolidationProgress',
          ...progress
        }).catch(() => {});
      });
      return { success: true, ...result };
    }

    // ── AI Settings ──

    case 'getAISettings':
      return AIClient.getSettings();

    case 'saveAISettings':
      await AIClient.saveSettings(msg.settings);
      return { success: true };

    case 'setAIApiKey':
      await AIClient.setApiKey(msg.providerId, msg.plainKey, msg.passphrase || undefined);
      return { success: true };

    case 'isAIAvailable':
      return { available: await AIClient.isAvailable() };

    case 'testAIConnection': {
      const success = await AIClient.testConnection(msg.providerId, msg.config);
      return { success };
    }

    case 'clearAICache':
      await AIClient.clearCache();
      return { success: true };

    case 'listModels': {
      const models = await AIClient.listModels(msg.providerId, msg.config);
      return { models };
    }

    // ── AI Smart Grouping ──

    case 'applySmartGroups': {
      const result = await applySmartGroupsToChrome((progress) => {
        chrome.runtime.sendMessage({
          type: 'groupingProgress',
          ...progress
        }).catch(() => {});
      });
      return { success: true, ...result };
    }

    // ── AI Tab Summarization ──

    case 'summarizeTabs': {
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

        if (response.parsed?.summaries) {
          for (const s of response.parsed.summaries) {
            const tab = batch[s.index];
            if (tab) {
              allSummaries.push({ tabId: tab.id, summary: s.summary });
            }
          }
        }
      }

      return { summaries: allSummaries };
    }

    // ── AI Natural Language Commands ──

    case 'executeNLCommand': {
      const allTabs = await getAllTabs({ allWindows: true });
      const tabContext = Prompts.nlCommand.buildTabContext(allTabs);

      const response = await AIClient.complete({
        systemPrompt: Prompts.nlCommand.system,
        userPrompt: Prompts.nlCommand.buildUserPrompt(msg.command, tabContext),
        maxTokens: 512,
        temperature: 0.1,
        responseFormat: 'json',
      });

      if (!response.parsed) {
        return { error: 'Could not understand that command' };
      }

      const parsed = response.parsed;
      const matchingTabs = filterTabs(allTabs, parsed.filter || {});

      if (matchingTabs.length === 0) {
        return { error: 'No tabs matched that description' };
      }

      // Destructive actions require confirmation
      if (parsed.action === 'close') {
        return {
          confirmation: parsed.confirmation || `Close ${matchingTabs.length} tab(s)?`,
          parsedCommand: { ...parsed, tabIds: matchingTabs.map(t => t.id) },
        };
      }

      // Non-destructive actions execute immediately
      return executeNLAction(parsed, matchingTabs);
    }

    case 'confirmNLCommand': {
      const { parsedCommand } = msg;
      const allTabs = await getAllTabs({ allWindows: true });
      const matchingTabs = allTabs.filter(t => parsedCommand.tabIds.includes(t.id));
      return executeNLAction(parsedCommand, matchingTabs);
    }

    // ── Tab Sleep (Kebab) ──

    case 'getKeepAwakeList':
      return getKeepAwakeList();

    case 'saveKeepAwakeList':
      if (msg.domains === null) {
        await Storage.remove('keepAwakeDomains');
      } else {
        await Storage.set('keepAwakeDomains', msg.domains);
      }
      return { success: true };

    case 'toggleKeepAwakeDomain': {
      const list = await getKeepAwakeList();
      const idx = list.indexOf(msg.domain);
      if (idx >= 0) {
        list.splice(idx, 1);
        await Storage.set('keepAwakeDomains', list);
        return { isKeepAwake: false };
      } else {
        list.push(msg.domain);
        await Storage.set('keepAwakeDomains', list);
        return { isKeepAwake: true };
      }
    }

    case 'discardTabs': {
      const keepAwake = new Set(await getKeepAwakeList());
      let tabs = await getAllTabs({ allWindows: true });

      // Scope filtering
      if (msg.scope === 'domain') {
        tabs = tabs.filter(t => extractDomain(t.url) === msg.domain);
      } else if (msg.scope === 'group') {
        tabs = tabs.filter(t => t.groupId === msg.groupId);
      } else if (msg.scope === 'window') {
        tabs = tabs.filter(t => t.windowId === msg.windowId);
      }
      // scope === 'all' — no filter

      let discarded = 0;
      let skipped = 0;
      const errors = [];

      for (const tab of tabs) {
        // Skip: active tab, already discarded, keep-awake domain, autoDiscardable === false
        if (tab.active) { skipped++; continue; }
        if (tab.discarded) { skipped++; continue; }
        if (keepAwake.has(extractDomain(tab.url))) { skipped++; continue; }
        if (tab.autoDiscardable === false) { skipped++; continue; }

        try {
          await chrome.tabs.discard(tab.id);
          discarded++;
        } catch (err) {
          errors.push({ tabId: tab.id, error: err.message });
        }
      }

      return { discarded, skipped, errors };
    }

    case 'setKeepAwake': {
      let tabs = await getAllTabs({ allWindows: true });

      if (msg.scope === 'domain') {
        tabs = tabs.filter(t => extractDomain(t.url) === msg.domain);
      } else if (msg.scope === 'group') {
        tabs = tabs.filter(t => t.groupId === msg.groupId);
      }

      const value = !msg.keepAwake; // autoDiscardable is the inverse of keep-awake
      for (const tab of tabs) {
        try {
          await chrome.tabs.update(tab.id, { autoDiscardable: value });
        } catch { /* ignore */ }
      }

      // For domain scope, also persist to keep-awake list
      if (msg.scope === 'domain' && msg.domain) {
        const list = await getKeepAwakeList();
        const idx = list.indexOf(msg.domain);
        if (msg.keepAwake && idx < 0) {
          list.push(msg.domain);
          await Storage.set('keepAwakeDomains', list);
        } else if (!msg.keepAwake && idx >= 0) {
          list.splice(idx, 1);
          await Storage.set('keepAwakeDomains', list);
        }
      }

      return { success: true };
    }

    case 'classifyKeepAwake': {
      const allTabs = await getAllTabs({ allWindows: true });
      const response = await AIClient.complete({
        systemPrompt: Prompts.keepAwake.system,
        userPrompt: Prompts.keepAwake.buildUserPrompt(allTabs),
        maxTokens: 1024,
        temperature: 0.2,
        responseFormat: 'json',
      });

      if (!response.parsed?.keepAwake) {
        return { suggestions: [] };
      }

      // Deduplicate by domain
      const seen = new Set();
      const suggestions = [];
      for (const item of response.parsed.keepAwake) {
        const tab = allTabs[item.index];
        const domain = tab ? extractDomain(tab.url) : item.domain;
        if (domain && !seen.has(domain)) {
          seen.add(domain);
          suggestions.push({ domain, reason: item.reason || '' });
        }
      }

      return { suggestions };
    }

    // ── Stash ──

    case 'stashWindow': {
      const tabs = await getAllTabs({ allWindows: true });
      const windowTabs = tabs.filter(t => t.windowId === msg.windowId);
      if (windowTabs.length === 0) return { error: 'No tabs in window' };

      let chromeGroups = [];
      try { chromeGroups = await chrome.tabGroups.query({ windowId: msg.windowId }); } catch {}

      const groupMeta = new Map();
      for (const g of chromeGroups) {
        groupMeta.set(g.id, { title: g.title || '', color: g.color || 'grey', collapsed: g.collapsed || false });
      }

      const stashTabs = [];
      const groupIds = new Set();
      for (const t of windowTabs) {
        const saved = { url: t.url, title: t.title, favIconUrl: t.favIconUrl, pinned: t.pinned || false };
        if (t.groupId !== undefined && t.groupId !== -1) {
          saved.groupId = t.groupId;
          groupIds.add(t.groupId);
        }
        stashTabs.push(saved);
      }

      const groups = [];
      for (const gid of groupIds) {
        const meta = groupMeta.get(gid);
        if (meta) groups.push({ id: gid, ...meta });
      }

      const stashId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      const stash = {
        id: stashId,
        name: `Window ${msg.windowNumber || '?'} (${windowTabs.length} tabs)`,
        source: 'window',
        sourceDetail: String(msg.windowId),
        createdAt: Date.now(),
        tabCount: windowTabs.length,
        windows: [{ tabCount: stashTabs.length, tabs: stashTabs, ...(groups.length > 0 ? { groups } : {}) }],
      };

      await saveStash(stash);
      const closableIds = windowTabs.filter(t => !t.url.startsWith('chrome://')).map(t => t.id);
      if (closableIds.length > 0) await closeTabs(closableIds);

      return { success: true, stash };
    }

    case 'stashGroup': {
      const groupTabs = await chrome.tabs.query({ groupId: msg.groupId });
      if (groupTabs.length === 0) return { error: 'No tabs in group' };

      let groupInfo = { title: 'Untitled', color: 'grey', collapsed: false };
      try {
        const g = await chrome.tabGroups.get(msg.groupId);
        groupInfo = { title: g.title || 'Untitled', color: g.color || 'grey', collapsed: g.collapsed || false };
      } catch {}

      const stashTabs = groupTabs.map(t => ({
        url: t.url, title: t.title, favIconUrl: t.favIconUrl,
        pinned: t.pinned || false, groupId: msg.groupId,
      }));

      const stashId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      const stash = {
        id: stashId,
        name: `${groupInfo.title} [group] (${groupTabs.length} tabs)`,
        source: 'group',
        sourceDetail: groupInfo.title,
        createdAt: Date.now(),
        tabCount: groupTabs.length,
        windows: [{
          tabCount: stashTabs.length,
          tabs: stashTabs,
          groups: [{ id: msg.groupId, ...groupInfo }],
        }],
      };

      await saveStash(stash);
      const closableIds = groupTabs.filter(t => !t.url.startsWith('chrome://')).map(t => t.id);
      if (closableIds.length > 0) await closeTabs(closableIds);

      return { success: true, stash };
    }

    case 'stashDomain': {
      const allTabs = await getAllTabs({ allWindows: true });
      const domainTabs = allTabs.filter(t => extractDomain(t.url) === msg.domain);
      if (domainTabs.length === 0) return { error: 'No tabs for domain' };

      const windowMap = new Map();
      for (const t of domainTabs) {
        if (!windowMap.has(t.windowId)) windowMap.set(t.windowId, []);
        windowMap.get(t.windowId).push({
          url: t.url, title: t.title, favIconUrl: t.favIconUrl, pinned: t.pinned || false,
        });
      }

      const windows = [];
      for (const [, wTabs] of windowMap) {
        windows.push({ tabCount: wTabs.length, tabs: wTabs });
      }

      const stashId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      const stash = {
        id: stashId,
        name: `${msg.domain} (${domainTabs.length} tabs)`,
        source: 'domain',
        sourceDetail: msg.domain,
        createdAt: Date.now(),
        tabCount: domainTabs.length,
        windows,
      };

      await saveStash(stash);
      const closableIds = domainTabs.filter(t => !t.url.startsWith('chrome://')).map(t => t.id);
      if (closableIds.length > 0) await closeTabs(closableIds);

      return { success: true, stash };
    }

    case 'listStashes':
      return listStashesDB();

    case 'restoreStash': {
      const stash = await getStash(msg.stashId);
      if (!stash) throw new Error('Stash not found');

      const restoreResult = await restoreStashTabs(stash, msg.options || {});

      if (msg.deleteAfterRestore !== false) {
        await deleteStashDB(msg.stashId);
      }

      return restoreResult;
    }

    case 'deleteStash':
      await deleteStashDB(msg.stashId);
      return { success: true };

    case 'importStashes':
      return importStashesDB(msg.stashes || []);

    default:
      return { error: `Unknown action: ${msg.action}` };
  }
}
