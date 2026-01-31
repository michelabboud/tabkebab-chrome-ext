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
import { getSettings, saveSettings } from './core/settings.js';
import { listDriveExports, deleteDriveExport, exportToSubfolder, listAllDriveFiles, deleteDriveFile, listSubfolderFiles } from './core/drive-client.js';

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

async function autoSaveSession() {
  try {
    const tabs = await getAllTabs({ allWindows: true });
    // Skip auto-save if browser has no real tabs open
    if (tabs.length <= 1) return;

    const settings = await getSettings();
    const date = new Date();
    const dateStr = date.toLocaleDateString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
    const name = `${AUTO_SAVE_PREFIX}${dateStr}`;

    await saveSession(name, true);

    // Rolling retention by days
    const sessions = (await Storage.get('sessions')) || [];
    const autoSaves = sessions.filter(s => s.name.startsWith(AUTO_SAVE_PREFIX));
    const retentionMs = (settings.autoSaveRetentionDays || 7) * 24 * 60 * 60 * 1000;
    const cutoff = Date.now() - retentionMs;

    const idsToDelete = new Set();
    for (const s of autoSaves) {
      if ((s.createdAt || 0) < cutoff) {
        idsToDelete.add(s.id);
      }
    }

    // Always keep at least the 2 most recent regardless of age
    const recentIds = new Set(autoSaves.slice(0, 2).map(s => s.id));
    for (const id of recentIds) idsToDelete.delete(id);

    if (idsToDelete.size > 0) {
      const filtered = sessions.filter(s => !idsToDelete.has(s.id));
      await Storage.set('sessions', filtered);
    }
  } catch {
    // Auto-save should never crash the service worker
  }
}

// ── Alarm names ──

const ALARM_AUTO_SAVE = 'autoSaveSession';
const ALARM_AUTO_KEBAB = 'autoKebab';
const ALARM_AUTO_STASH = 'autoStash';
const ALARM_AUTO_SYNC_DRIVE = 'autoSyncDrive';
const ALARM_RETENTION_CLEANUP = 'retentionCleanup';
const ALARM_AUTO_BOOKMARK = 'autoBookmark';

// ── Alarm system ──

async function reconfigureAlarms(settings) {
  if (!settings) settings = await getSettings();

  // Clear all managed alarms
  const alarmNames = [ALARM_AUTO_SAVE, ALARM_AUTO_KEBAB, ALARM_AUTO_STASH, ALARM_AUTO_SYNC_DRIVE, ALARM_RETENTION_CLEANUP, ALARM_AUTO_BOOKMARK];
  for (const name of alarmNames) {
    try { await chrome.alarms.clear(name); } catch {}
  }

  // Auto-save session
  const saveInterval = (settings.autoSaveIntervalHours || 24) * 60;
  chrome.alarms.create(ALARM_AUTO_SAVE, { periodInMinutes: saveInterval });

  // Auto-kebab (hourly check)
  if (settings.autoKebabAfterHours > 0) {
    chrome.alarms.create(ALARM_AUTO_KEBAB, { periodInMinutes: 60 });
  }

  // Auto-stash (6h check)
  if (settings.autoStashAfterDays > 0) {
    chrome.alarms.create(ALARM_AUTO_STASH, { periodInMinutes: 360 });
  }

  // Auto-sync Drive
  if (settings.autoSyncToDriveIntervalHours > 0) {
    chrome.alarms.create(ALARM_AUTO_SYNC_DRIVE, { periodInMinutes: settings.autoSyncToDriveIntervalHours * 60 });
  }

  // Retention cleanup (12h)
  chrome.alarms.create(ALARM_RETENTION_CLEANUP, { periodInMinutes: 720 });

  // Auto-bookmark (daily check if any bookmark format enabled + auto on stash)
  if (settings.autoBookmarkOnStash && (settings.bookmarkByWindows || settings.bookmarkByGroups || settings.bookmarkByDomains)) {
    chrome.alarms.create(ALARM_AUTO_BOOKMARK, { periodInMinutes: 720 });
  }
}

// ── Automation handlers ──

async function autoKebabOldTabs() {
  try {
    const settings = await getSettings();
    if (settings.autoKebabAfterHours <= 0) return;

    const keepAwake = new Set(await getKeepAwakeList());
    const tabs = await getAllTabs({ allWindows: true });
    const thresholdMs = settings.autoKebabAfterHours * 60 * 60 * 1000;
    const cutoff = Date.now() - thresholdMs;

    for (const tab of tabs) {
      if (tab.active || tab.discarded) continue;
      if (tab.autoDiscardable === false) continue;
      if (keepAwake.has(extractDomain(tab.url))) continue;
      if ((tab.lastAccessed || Date.now()) > cutoff) continue;

      try { await chrome.tabs.discard(tab.id); } catch {}
    }
  } catch {}
}

async function autoStashOldTabs() {
  try {
    const settings = await getSettings();
    if (settings.autoStashAfterDays <= 0) return;

    const keepAwake = new Set(await getKeepAwakeList());
    const tabs = await getAllTabs({ allWindows: true });
    const thresholdMs = settings.autoStashAfterDays * 24 * 60 * 60 * 1000;
    const cutoff = Date.now() - thresholdMs;

    // Group old tabs by window
    const windowBuckets = new Map();
    for (const tab of tabs) {
      if (tab.active) continue;
      if (keepAwake.has(extractDomain(tab.url))) continue;
      if ((tab.lastAccessed || Date.now()) > cutoff) continue;
      if (tab.url.startsWith('chrome://')) continue;

      if (!windowBuckets.has(tab.windowId)) windowBuckets.set(tab.windowId, []);
      windowBuckets.get(tab.windowId).push(tab);
    }

    for (const [, oldTabs] of windowBuckets) {
      if (oldTabs.length === 0) continue;

      const stashTabs = oldTabs.map(t => ({
        url: t.url, title: t.title, favIconUrl: t.favIconUrl, pinned: t.pinned || false,
      }));

      const stashId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      const stash = {
        id: stashId,
        name: `[Auto-stash] ${oldTabs.length} idle tabs`,
        source: 'auto',
        sourceDetail: 'auto-stash',
        createdAt: Date.now(),
        tabCount: oldTabs.length,
        windows: [{ tabCount: stashTabs.length, tabs: stashTabs }],
      };

      await saveStash(stash);
      await closeTabs(oldTabs.map(t => t.id));
    }
  } catch {}
}

async function autoSyncDrive() {
  try {
    const settings = await getSettings();
    const driveState = await Storage.get('driveSync');
    if (!driveState?.connected) return;

    // Export sessions to Drive/sessions subfolder
    if (settings.autoExportSessionsToDrive) {
      const sessions = (await Storage.get('sessions')) || [];
      if (sessions.length > 0) {
        const filename = `sessions-${new Date().toISOString().slice(0, 10)}.json`;
        await exportToSubfolder('sessions', filename, { sessions, exportedAt: Date.now() });
      }
    }

    // Export stashes to Drive/stashes subfolder
    if (settings.autoExportStashesToDrive) {
      const stashes = await listStashesDB();
      if (stashes.length > 0) {
        const filename = `stashes-${new Date().toISOString().slice(0, 10)}.json`;
        await exportToSubfolder('stashes', filename, { stashes, exportedAt: Date.now() });
      }
    }

    await Storage.set('driveSync', { ...driveState, lastSyncedAt: Date.now() });
  } catch {}
}

async function runRetentionCleanup() {
  try {
    const settings = await getSettings();

    // Clean old auto-saves locally
    const retentionMs = (settings.autoSaveRetentionDays || 7) * 24 * 60 * 60 * 1000;
    const cutoff = Date.now() - retentionMs;
    const sessions = (await Storage.get('sessions')) || [];
    const autoSaves = sessions.filter(s => s.name.startsWith(AUTO_SAVE_PREFIX));
    const recentIds = new Set(autoSaves.slice(0, 2).map(s => s.id));
    const idsToDelete = new Set();

    for (const s of autoSaves) {
      if ((s.createdAt || 0) < cutoff && !recentIds.has(s.id)) {
        idsToDelete.add(s.id);
      }
    }

    if (idsToDelete.size > 0) {
      await Storage.set('sessions', sessions.filter(s => !idsToDelete.has(s.id)));
    }

    // Clean old Drive files
    if (!settings.neverDeleteFromDrive && settings.driveRetentionDays > 0) {
      const driveState = await Storage.get('driveSync');
      if (driveState?.connected) {
        try {
          const driveCutoff = Date.now() - (settings.driveRetentionDays * 24 * 60 * 60 * 1000);
          const allFiles = await listAllDriveFiles();
          for (const file of allFiles) {
            const fileTime = new Date(file.modifiedTime).getTime();
            if (fileTime < driveCutoff) {
              try { await deleteDriveFile(file.id); } catch {}
            }
          }
        } catch {}
      }
    }
  } catch {}
}

// ── Bookmark system ──

async function createBookmarks(options = {}) {
  const settings = await getSettings();
  const byWindows = options.byWindows ?? settings.bookmarkByWindows;
  const byGroups = options.byGroups ?? settings.bookmarkByGroups;
  const byDomains = options.byDomains ?? settings.bookmarkByDomains;
  const destination = options.destination ?? settings.bookmarkDestination;
  const compressed = options.compressed ?? settings.compressedExport;

  if (!byWindows && !byGroups && !byDomains) return { error: 'No bookmark format selected' };

  const tabs = await getAllTabs({ allWindows: true });
  const date = new Date();
  const dateStr = date.toISOString().slice(0, 10);
  const timeStr = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

  const bookmarkData = {
    date: dateStr,
    time: timeStr,
    createdAt: Date.now(),
    formats: {},
  };

  // Format 1: By windows (normalized numbering 1..N)
  if (byWindows) {
    const windowStats = await getWindowStats();
    const windowBookmarks = [];
    let windowNum = 1;
    for (const win of windowStats.windows) {
      const winTabs = tabs.filter(t => t.windowId === win.windowId);
      windowBookmarks.push({
        name: `Window ${windowNum}`,
        tabs: winTabs.map(t => ({ title: t.title, url: t.url })),
      });
      windowNum++;
    }
    bookmarkData.formats.byWindows = windowBookmarks;
  }

  // Format 2: By groups
  if (byGroups) {
    const groups = [];
    try {
      const chromeGroups = await chrome.tabGroups.query({});
      for (const g of chromeGroups) {
        const groupTabs = await chrome.tabs.query({ groupId: g.id });
        groups.push({
          name: g.title || 'Untitled',
          color: g.color,
          tabs: groupTabs.map(t => ({ title: t.title, url: t.url })),
        });
      }
    } catch {}

    // Ungrouped tabs
    const ungrouped = tabs.filter(t => !t.groupId || t.groupId === -1);
    if (ungrouped.length > 0) {
      groups.push({
        name: 'Ungrouped',
        color: 'grey',
        tabs: ungrouped.map(t => ({ title: t.title, url: t.url })),
      });
    }
    bookmarkData.formats.byGroups = groups;
  }

  // Format 3: By domains
  if (byDomains) {
    const domainMap = new Map();
    for (const t of tabs) {
      const domain = extractDomain(t.url) || 'other';
      if (!domainMap.has(domain)) domainMap.set(domain, []);
      domainMap.get(domain).push({ title: t.title, url: t.url });
    }
    const domainBookmarks = [];
    for (const [domain, domainTabs] of domainMap) {
      domainBookmarks.push({ name: domain, tabs: domainTabs });
    }
    domainBookmarks.sort((a, b) => b.tabs.length - a.tabs.length);
    bookmarkData.formats.byDomains = domainBookmarks;
  }

  const results = { created: 0, destinations: [] };

  // Save to Chrome bookmarks
  if (destination === 'chrome' || destination === 'all') {
    try {
      await saveToChromeBoomarks(bookmarkData, dateStr);
      results.created++;
      results.destinations.push('Chrome Bookmarks');
    } catch (err) {
      results.chromeError = err.message;
    }
  }

  // Save to IndexedDB (via storage)
  if (destination === 'indexeddb' || destination === 'all') {
    try {
      const existing = (await Storage.get('tabkebabBookmarks')) || [];
      existing.unshift(bookmarkData);
      // Keep max 50
      if (existing.length > 50) existing.length = 50;
      await Storage.set('tabkebabBookmarks', existing);
      results.created++;
      results.destinations.push('Local Storage');
    } catch {}
  }

  // Save to Google Drive
  if (destination === 'drive' || destination === 'all') {
    try {
      const driveState = await Storage.get('driveSync');
      if (driveState?.connected) {
        let content = bookmarkData;
        const filename = `bookmarks-${dateStr}-${Date.now()}.json`;
        await exportToSubfolder('bookmarks', filename, content);
        results.created++;
        results.destinations.push('Google Drive');
      }
    } catch {}
  }

  return results;
}

async function saveToChromeBoomarks(bookmarkData, dateStr) {
  // Find or create TabKebab root folder
  const tree = await chrome.bookmarks.getTree();
  const bar = tree[0].children.find(n => n.id === '1') || tree[0].children[0]; // Bookmarks bar

  let tkRoot = bar.children?.find(n => n.title === 'TabKebab');
  if (!tkRoot) {
    tkRoot = await chrome.bookmarks.create({ parentId: bar.id, title: 'TabKebab' });
  }

  // Date folder
  let dateFolder = (await chrome.bookmarks.getChildren(tkRoot.id)).find(n => n.title === dateStr);
  if (!dateFolder) {
    dateFolder = await chrome.bookmarks.create({ parentId: tkRoot.id, title: dateStr });
  }

  // By Windows: TabKebab -> date -> Window N -> tabs
  if (bookmarkData.formats.byWindows) {
    for (const win of bookmarkData.formats.byWindows) {
      const winFolder = await chrome.bookmarks.create({ parentId: dateFolder.id, title: win.name });
      for (const tab of win.tabs) {
        await chrome.bookmarks.create({ parentId: winFolder.id, title: tab.title, url: tab.url });
      }
    }
  }

  // By Groups: TabKebab -> date -> Groups -> group name -> tabs
  if (bookmarkData.formats.byGroups) {
    const groupsFolder = await chrome.bookmarks.create({ parentId: dateFolder.id, title: 'Groups' });
    for (const group of bookmarkData.formats.byGroups) {
      const gFolder = await chrome.bookmarks.create({ parentId: groupsFolder.id, title: group.name });
      for (const tab of group.tabs) {
        await chrome.bookmarks.create({ parentId: gFolder.id, title: tab.title, url: tab.url });
      }
    }
  }

  // By Domains: TabKebab -> date -> Domains -> domain -> tabs
  if (bookmarkData.formats.byDomains) {
    const domainsFolder = await chrome.bookmarks.create({ parentId: dateFolder.id, title: 'Domains' });
    for (const domain of bookmarkData.formats.byDomains) {
      const dFolder = await chrome.bookmarks.create({ parentId: domainsFolder.id, title: domain.name });
      for (const tab of domain.tabs) {
        await chrome.bookmarks.create({ parentId: dFolder.id, title: tab.title, url: tab.url });
      }
    }
  }
}

// ── Lifecycle Events ──

// Auto-save on browser startup
chrome.runtime.onStartup.addListener(() => {
  setTimeout(async () => {
    await autoSaveSession();
    await reconfigureAlarms();
  }, 5000);
});

// Auto-save on extension install/update
chrome.runtime.onInstalled.addListener(() => {
  setTimeout(async () => {
    await autoSaveSession();
    await reconfigureAlarms();
  }, 5000);
});

// Handle alarms
chrome.alarms.onAlarm.addListener((alarm) => {
  switch (alarm.name) {
    case ALARM_AUTO_SAVE:      autoSaveSession(); break;
    case ALARM_AUTO_KEBAB:     autoKebabOldTabs(); break;
    case ALARM_AUTO_STASH:     autoStashOldTabs(); break;
    case ALARM_AUTO_SYNC_DRIVE: autoSyncDrive(); break;
    case ALARM_RETENTION_CLEANUP: runRetentionCleanup(); break;
    case ALARM_AUTO_BOOKMARK:  createBookmarks(); break;
  }
});

// Ensure alarms exist (service worker can restart)
(async () => {
  const alarm = await chrome.alarms.get(ALARM_AUTO_SAVE);
  if (!alarm) await reconfigureAlarms();
})();

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

    // ── Settings ──

    case 'getSettings':
      return getSettings();

    case 'saveSettings': {
      const saved = await saveSettings(msg.settings);
      await reconfigureAlarms(saved);
      return saved;
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

      // Auto-bookmark on stash if enabled
      const settings = await getSettings();
      if (settings.autoBookmarkOnStash && (settings.bookmarkByWindows || settings.bookmarkByGroups || settings.bookmarkByDomains)) {
        try { await createBookmarks(); } catch {}
      }

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

      // Read removeStashAfterRestore from settings if not overridden in message
      const removeOverride = msg.deleteAfterRestore;
      let shouldRemove;
      if (removeOverride !== undefined) {
        shouldRemove = removeOverride;
      } else {
        const settings = await getSettings();
        shouldRemove = settings.removeStashAfterRestore;
      }

      if (shouldRemove !== false) {
        await deleteStashDB(msg.stashId);
      }

      return restoreResult;
    }

    case 'deleteStash':
      await deleteStashDB(msg.stashId);
      return { success: true };

    case 'importStashes':
      return importStashesDB(msg.stashes || []);

    // ── Drive Operations ──

    case 'exportStashToDrive': {
      const stash = await getStash(msg.stashId);
      if (!stash) throw new Error('Stash not found');
      const filename = `stash-${stash.name.replace(/[^a-zA-Z0-9]/g, '-')}-${Date.now()}.json`;
      await exportToSubfolder('stashes', filename, stash);
      return { success: true };
    }

    case 'syncStashesToDrive': {
      const stashes = await listStashesDB();
      if (stashes.length === 0) return { synced: 0 };
      const filename = `stashes-${new Date().toISOString().slice(0, 10)}.json`;
      await exportToSubfolder('stashes', filename, { stashes, exportedAt: Date.now() });
      return { synced: stashes.length };
    }

    case 'syncAllToDrive': {
      const results = { sessions: 0, stashes: 0, bookmarks: 0 };
      const dateStr = new Date().toISOString().slice(0, 10);

      // Sessions → Drive/sessions/
      const sessions = (await Storage.get('sessions')) || [];
      if (sessions.length > 0) {
        await exportToSubfolder('sessions', `sessions-${dateStr}.json`, { sessions, exportedAt: Date.now() });
        results.sessions = sessions.length;
      }

      // Stashes → Drive/stashes/
      const stashes = await listStashesDB();
      if (stashes.length > 0) {
        await exportToSubfolder('stashes', `stashes-${dateStr}.json`, { stashes, exportedAt: Date.now() });
        results.stashes = stashes.length;
      }

      // Bookmarks → Drive/bookmarks/
      const bookmarks = (await Storage.get('tabkebabBookmarks')) || [];
      if (bookmarks.length > 0) {
        await exportToSubfolder('bookmarks', `bookmarks-${dateStr}.json`, { bookmarks, exportedAt: Date.now() });
        results.bookmarks = bookmarks.length;
      }

      return results;
    }

    case 'cleanDriveFiles': {
      const days = msg.days || 30;
      const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
      const allFiles = await listAllDriveFiles();
      let deleted = 0;
      for (const file of allFiles) {
        const fileTime = new Date(file.modifiedTime).getTime();
        if (fileTime < cutoff) {
          try {
            await deleteDriveFile(file.id);
            deleted++;
          } catch {}
        }
      }
      return { deleted };
    }

    // ── Bookmarks ──

    case 'createBookmarks':
      return createBookmarks(msg.options || {});

    case 'listLocalBookmarks': {
      const bookmarks = (await Storage.get('tabkebabBookmarks')) || [];
      return bookmarks;
    }

    default:
      return { error: `Unknown action: ${msg.action}` };
  }
}
