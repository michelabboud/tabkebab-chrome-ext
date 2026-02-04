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
import { exportToSubfolder, exportRawToSubfolder, listAllDriveFiles, deleteDriveFile, writeSettingsFile } from './core/drive-client.js';
import { getCachedFocusState, getFocusState, isBlockedDomain, handleDistraction, handleFocusTick, startFocus, endFocus, pauseFocus, resumeFocus, extendFocus, updateBadge, getFocusHistory, getAllProfiles } from './core/focus.js';

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
  } catch (e) { console.warn('[TabKebab] auto-save failed:', e);
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
const ALARM_FOCUS_TICK = 'focusTick';

// ── Alarm system ──

async function reconfigureAlarms(settings) {
  if (!settings) settings = await getSettings();

  // Clear all managed alarms
  const alarmNames = [ALARM_AUTO_SAVE, ALARM_AUTO_KEBAB, ALARM_AUTO_STASH, ALARM_AUTO_SYNC_DRIVE, ALARM_RETENTION_CLEANUP, ALARM_AUTO_BOOKMARK];
  for (const name of alarmNames) {
    try { await chrome.alarms.clear(name); } catch (e) { console.warn('[TabKebab] alarm clear failed:', name, e); }
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

      try { await chrome.tabs.discard(tab.id); } catch (e) { /* tab may be active or protected */ }
    }
  } catch (e) { console.warn('[TabKebab] auto-kebab failed:', e); }
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
  } catch (e) { console.warn('[TabKebab] auto-stash failed:', e); }
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

    // Write current settings to Drive
    try {
      await writeSettingsFile({ settings, savedAt: Date.now(), version: 1 });
    } catch (e) { console.warn('[TabKebab] settings write to Drive failed:', e); }
  } catch (e) { console.warn('[TabKebab] auto Drive sync failed:', e); }
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
              try { await deleteDriveFile(file.id); } catch (e) { console.warn('[TabKebab] Drive file cleanup failed:', file.id, e); }
            }
          }
        } catch (e) { console.warn('[TabKebab] Drive retention cleanup failed:', e); }
      }
    }
  } catch (e) { console.warn('[TabKebab] Drive retention cleanup failed:', e); }
}

// ── Bookmark system ──

function generateBookmarkHtml(bookmarkData) {
  const { date, time, formats } = bookmarkData;

  // Security-critical: escapes user-controlled data for safe HTML insertion
  const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const hostname = (url) => { try { return new URL(url).hostname; } catch { return ''; } };

  // Build tab nav buttons and panels
  const navItems = [];
  const panels = [];

  function buildGroups(items, hasColor, panelId) {
    // Pills row
    let html = '<div class="pills">';
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const pillDot = hasColor && item.color && item.color !== 'grey'
        ? `<span class="pill-dot" style="background:${esc(chromeColorHex(item.color))}"></span>` : '';
      html += `<button class="pill" data-target="${panelId}-g${i}">${pillDot}${esc(item.name)}<span class="pill-count">${item.tabs.length}</span></button>`;
    }
    html += '</div>';
    // Groups
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const colorDot = hasColor && item.color && item.color !== 'grey'
        ? `<span class="dot" style="background:${esc(chromeColorHex(item.color))}"></span>` : '';
      html += `<div class="group" id="${panelId}-g${i}"><div class="group-header" onclick="this.parentElement.classList.toggle('collapsed')">${colorDot}<span class="chevron"></span><span class="group-title">${esc(item.name)}</span><span class="badge">${item.tabs.length}</span></div><div class="group-body">`;
      for (const tab of item.tabs) {
        html += `<a class="tab" href="${esc(tab.url)}" target="_blank" data-search="${esc((tab.title + ' ' + tab.url).toLowerCase())}"><img class="fav" src="https://www.google.com/s2/favicons?domain=${esc(hostname(tab.url))}&sz=16" alt=""><span class="tab-title">${esc(tab.title)}</span><span class="tab-url">${esc(tab.url)}</span></a>`;
      }
      html += '</div></div>';
    }
    return html;
  }

  if (formats.byWindows) {
    const count = formats.byWindows.reduce((s, w) => s + w.tabs.length, 0);
    navItems.push({ id: 'windows', label: 'Windows', count });
    panels.push({ id: 'windows', html: buildGroups(formats.byWindows, false, 'win') });
  }
  if (formats.byGroups) {
    const count = formats.byGroups.reduce((s, g) => s + g.tabs.length, 0);
    navItems.push({ id: 'groups', label: 'Groups', count });
    panels.push({ id: 'groups', html: buildGroups(formats.byGroups, true, 'grp') });
  }
  if (formats.byDomains) {
    const count = formats.byDomains.reduce((s, d) => s + d.tabs.length, 0);
    navItems.push({ id: 'domains', label: 'Domains', count });
    panels.push({ id: 'domains', html: buildGroups(formats.byDomains, false, 'dom') });
  }

  const totalTabs = navItems.reduce((s, n) => s + n.count, 0);

  const navHtml = navItems.map((n, i) =>
    `<button class="nav-btn${i === 0 ? ' active' : ''}" data-panel="${n.id}">${esc(n.label)}<span class="nav-count">${n.count}</span></button>`
  ).join('');

  const panelsHtml = panels.map((p, i) =>
    `<div class="panel${i === 0 ? ' active' : ''}" id="panel-${p.id}">${p.html}</div>`
  ).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TabKebab Bookmarks — ${esc(date)}</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#f8f9fb;--card:#fff;--border:#e5e7eb;--text:#111827;--text2:#6b7280;--text3:#9ca3af;--accent:#2563eb;--accent-soft:rgba(37,99,235,.08);--accent-med:rgba(37,99,235,.15);--radius:10px;--shadow:0 1px 3px rgba(0,0,0,.06)}
@media(prefers-color-scheme:dark){:root{--bg:#0f0f10;--card:#1a1a1d;--border:#2a2a2e;--text:#f3f4f6;--text2:#9ca3af;--text3:#6b7280;--accent:#3b82f6;--accent-soft:rgba(59,130,246,.12);--accent-med:rgba(59,130,246,.22);--shadow:0 1px 3px rgba(0,0,0,.3)}}
body{font-family:'Segoe UI',-apple-system,BlinkMacSystemFont,system-ui,sans-serif;background:var(--bg);color:var(--text);font-size:14px;line-height:1.5;padding:0}
.header{position:sticky;top:0;z-index:100;background:var(--card);border-bottom:1px solid var(--border);padding:16px 24px 0;box-shadow:var(--shadow)}
.header-inner{max-width:960px;margin:0 auto}
.header h1{font-size:20px;font-weight:800;letter-spacing:-.02em;margin-bottom:2px}
.header .meta{font-size:13px;color:var(--text2)}
.search-box{margin-top:12px;position:relative}
.search-box input{width:100%;padding:10px 14px 10px 38px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);font-size:14px;font-family:inherit;outline:none;transition:border-color .15s,box-shadow .15s}
.search-box input:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
.search-box svg{position:absolute;left:12px;top:50%;transform:translateY(-50%);color:var(--text3);pointer-events:none}
.search-stats{font-size:12px;color:var(--text3);margin-top:6px;min-height:18px}
.tab-nav{display:flex;gap:2px;margin-top:14px;padding:0}
.nav-btn{flex:1;padding:10px 8px;background:none;border:none;border-bottom:3px solid transparent;color:var(--text2);font-size:13px;font-weight:600;font-family:inherit;cursor:pointer;transition:all .15s;display:flex;align-items:center;justify-content:center;gap:6px}
.nav-btn:hover{color:var(--text);background:var(--accent-soft)}
.nav-btn.active{color:var(--accent);border-bottom-color:var(--accent)}
.nav-count{background:var(--accent-soft);color:var(--accent);border-radius:100px;padding:1px 8px;font-size:11px;font-weight:700}
.nav-btn.active .nav-count{background:var(--accent-med)}
main{max-width:960px;margin:0 auto;padding:20px 24px 60px}
.panel{display:none}
.panel.active{display:block}
.group{border:1px solid var(--border);border-radius:var(--radius);background:var(--card);margin-bottom:6px;overflow:hidden;transition:box-shadow .15s}
.group:hover{box-shadow:var(--shadow)}
.group-header{display:flex;align-items:center;gap:8px;padding:10px 14px;cursor:pointer;user-select:none;transition:background .15s}
.group-header:hover{background:var(--accent-soft)}
.group-title{flex:1;font-weight:600;font-size:14px}
.badge{background:var(--accent-soft);color:var(--accent);border-radius:100px;padding:2px 10px;font-size:12px;font-weight:700;flex-shrink:0}
.dot{width:10px;height:10px;border-radius:50%;flex-shrink:0}
.chevron::before{content:'\\25BC';font-size:10px;color:var(--text3);transition:transform .2s;display:inline-block}
.collapsed .chevron::before{transform:rotate(-90deg)}
.group-body{border-top:1px solid var(--border)}
.collapsed .group-body{display:none}
.tab{display:flex;align-items:center;gap:10px;padding:8px 14px 8px 24px;text-decoration:none;color:var(--text);transition:background .1s;border-bottom:1px solid var(--border)}
.tab:last-child{border-bottom:none}
.tab:hover{background:var(--accent-soft)}
.tab.hidden{display:none}
.fav{width:16px;height:16px;border-radius:3px;flex-shrink:0}
.tab-title{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}
.tab-url{color:var(--text3);font-size:11px;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex-shrink:0}
mark{background:rgba(250,204,21,.4);color:inherit;border-radius:2px;padding:0 1px}
.no-results{text-align:center;padding:40px 20px;color:var(--text3);font-size:14px;display:none}
.group.group-hidden{display:none}
.pills{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px;padding:2px 0}
.pill{display:inline-flex;align-items:center;gap:5px;padding:5px 12px;border:1px solid var(--border);border-radius:100px;background:var(--card);color:var(--text);font-size:12px;font-weight:600;font-family:inherit;cursor:pointer;transition:all .15s;white-space:nowrap}
.pill:hover{border-color:var(--accent);background:var(--accent-soft);color:var(--accent)}
.pill-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
.pill-count{color:var(--text3);font-size:11px;font-weight:500}
.pill:hover .pill-count{color:var(--accent)}
.group.highlight{box-shadow:0 0 0 2px var(--accent);transition:box-shadow .3s}
@keyframes flash-highlight{0%{box-shadow:0 0 0 2px var(--accent)}100%{box-shadow:none}}
.group.flash{animation:flash-highlight .8s ease-out forwards;animation-delay:.4s}
@media(max-width:600px){.tab-url{display:none}.header{padding:12px 16px 0}main{padding:16px}.pills{gap:4px}.pill{padding:4px 10px;font-size:11px}}
</style>
</head>
<body>
<div class="header">
<div class="header-inner">
<h1>TabKebab Bookmarks</h1>
<div class="meta">${esc(date)} at ${esc(time)} &mdash; ${totalTabs} tabs</div>
<div class="search-box">
<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
<input type="text" id="search" placeholder="Search tabs..." autocomplete="off">
</div>
<div class="search-stats" id="search-stats"></div>
<nav class="tab-nav" id="tab-nav">${navHtml}</nav>
</div>
</div>
<main id="main">
${panelsHtml}
<div class="no-results" id="no-results">No tabs match your search.</div>
</main>
<script>
(function(){
  var input=document.getElementById('search');
  var stats=document.getElementById('search-stats');
  var noResults=document.getElementById('no-results');
  var allTabs=document.querySelectorAll('.tab');
  var allGroups=document.querySelectorAll('.group');
  var panels=document.querySelectorAll('.panel');
  var navBtns=document.querySelectorAll('.nav-btn');
  var navEl=document.getElementById('tab-nav');
  var allPills=document.querySelectorAll('.pills');
  var searching=false;

  // Tab navigation
  navBtns.forEach(function(btn){
    btn.addEventListener('click',function(){
      if(searching)return;
      navBtns.forEach(function(b){b.classList.remove('active')});
      btn.classList.add('active');
      panels.forEach(function(p){p.classList.toggle('active',p.id==='panel-'+btn.dataset.panel)});
    });
  });

  // Pill click → scroll to group + highlight
  document.querySelectorAll('.pill').forEach(function(pill){
    pill.addEventListener('click',function(){
      var target=document.getElementById(pill.dataset.target);
      if(!target)return;
      target.classList.remove('collapsed');
      target.scrollIntoView({behavior:'smooth',block:'start'});
      target.classList.remove('flash');
      target.classList.add('highlight');
      void target.offsetWidth;
      target.classList.add('flash');
      target.addEventListener('animationend',function(){
        target.classList.remove('highlight','flash');
      },{once:true});
    });
  });

  function clearHighlights(){
    allTabs.forEach(function(t){
      var ti=t.querySelector('.tab-title');
      var ur=t.querySelector('.tab-url');
      ti.innerHTML=ti.textContent;
      ur.innerHTML=ur.textContent;
    });
  }

  function highlightText(el,q){
    var text=el.textContent;
    var idx=text.toLowerCase().indexOf(q);
    if(idx===-1)return;
    el.innerHTML=text.slice(0,idx)+'<mark>'+text.slice(idx,idx+q.length)+'</mark>'+text.slice(idx+q.length);
  }

  input.addEventListener('input',function(){
    var q=this.value.toLowerCase().trim();
    clearHighlights();
    if(!q){
      searching=false;
      allTabs.forEach(function(t){t.classList.remove('hidden')});
      allGroups.forEach(function(g){g.classList.remove('collapsed');g.classList.remove('group-hidden')});
      // Restore tab view: show only the active panel
      panels.forEach(function(p){p.classList.remove('active')});
      var activeBtn=document.querySelector('.nav-btn.active');
      if(activeBtn){
        var id='panel-'+activeBtn.dataset.panel;
        var panel=document.getElementById(id);
        if(panel)panel.classList.add('active');
      }else if(panels.length>0){panels[0].classList.add('active')}
      navEl.style.opacity='';navEl.style.pointerEvents='';
      allPills.forEach(function(p){p.style.display=''});
      stats.textContent='';
      noResults.style.display='none';
      return;
    }
    // Show all panels during search
    searching=true;
    panels.forEach(function(p){p.classList.add('active')});
    navEl.style.opacity='.4';navEl.style.pointerEvents='none';
    allPills.forEach(function(p){p.style.display='none'});
    var shown=0;
    allTabs.forEach(function(t){
      var match=t.dataset.search.includes(q);
      t.classList.toggle('hidden',!match);
      if(match){
        shown++;
        highlightText(t.querySelector('.tab-title'),q);
        highlightText(t.querySelector('.tab-url'),q);
      }
    });
    allGroups.forEach(function(g){
      var vis=g.querySelectorAll('.tab:not(.hidden)').length;
      g.classList.toggle('group-hidden',vis===0);
      if(vis>0)g.classList.remove('collapsed');
    });
    stats.textContent=shown+' tab'+(shown!==1?'s':'')+' found';
    noResults.style.display=shown===0?'block':'none';
  });

  input.addEventListener('keydown',function(e){
    if(e.key==='Escape'){this.value='';this.dispatchEvent(new Event('input'));}
  });
})();
</script>
</body>
</html>`;
}

function chromeColorHex(color) {
  const map = { blue:'#1a73e8', red:'#d93025', yellow:'#f9ab00', green:'#188038', pink:'#e8305b', purple:'#a142f4', cyan:'#00796b', orange:'#e8710a' };
  return map[color] || map.blue;
}

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
    } catch (e) { console.warn('[TabKebab] tabGroups query failed:', e); }

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
    } catch (e) { console.warn('[TabKebab] bookmark local save failed:', e); }
  }

  // Save to Google Drive
  if (destination === 'drive' || destination === 'all') {
    try {
      const driveState = await Storage.get('driveSync');
      if (driveState?.connected) {
        const filename = `bookmarks-${dateStr}-${Date.now()}.json`;
        if (compressed) {
          await exportRawToSubfolder('bookmarks', filename, JSON.stringify(bookmarkData), 'application/json');
        } else {
          await exportToSubfolder('bookmarks', filename, bookmarkData);
        }
        results.created++;
        results.destinations.push('Google Drive');

        // Also upload HTML version if enabled
        if (settings.exportHtmlBookmarkToDrive) {
          try {
            const html = generateBookmarkHtml(bookmarkData);
            const htmlFilename = `bookmarks-${dateStr}.html`;
            await exportRawToSubfolder('bookmarks', htmlFilename, html, 'text/html');
          } catch (e) { console.warn('[TabKebab] HTML bookmark export failed:', e); }
        }
      }
    } catch (e) { console.warn('[TabKebab] bookmark Drive save failed:', e); }
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

  // By Windows: TabKebab -> date -> Windows -> Window N -> tabs
  if (bookmarkData.formats.byWindows) {
    const windowsFolder = await chrome.bookmarks.create({ parentId: dateFolder.id, title: 'Windows' });
    for (const win of bookmarkData.formats.byWindows) {
      const winFolder = await chrome.bookmarks.create({ parentId: windowsFolder.id, title: win.name });
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
    case ALARM_FOCUS_TICK:     handleFocusTick(); break;
  }
});

// Ensure alarms exist (service worker can restart)
(async () => {
  const alarm = await chrome.alarms.get(ALARM_AUTO_SAVE);
  if (!alarm) await reconfigureAlarms();

  // Restore focus alarm + badge if a session was active before SW restart
  const focusState = await getFocusState();
  if (focusState?.status === 'active') {
    const existing = await chrome.alarms.get(ALARM_FOCUS_TICK);
    if (!existing) await chrome.alarms.create(ALARM_FOCUS_TICK, { periodInMinutes: 1 });
    await updateBadge(focusState);
  }
})();

// Open side panel when extension icon is clicked
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// Notify side panel when tabs change
function notifyPanel() {
  chrome.runtime.sendMessage({ type: 'tabsChanged' }).catch(() => {
    // Side panel not open — ignore
  });
}

chrome.tabs.onCreated.addListener((tab) => {
  notifyPanel();
  // Focus mode: intercept new tabs opened to blocked URLs
  if (tab.pendingUrl || tab.url) {
    const url = tab.pendingUrl || tab.url;
    const state = getCachedFocusState();
    if (state?.status === 'active' && isBlockedDomain(url, state)) {
      handleDistraction(tab.id, url, state);
    }
  }
});
chrome.tabs.onRemoved.addListener(notifyPanel);
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'complete' || changeInfo.url) {
    notifyPanel();
  }
  // Focus mode: intercept navigation to blocked domains
  if (changeInfo.url) {
    const state = getCachedFocusState();
    if (state?.status === 'active' && isBlockedDomain(changeInfo.url, state)) {
      handleDistraction(tabId, changeInfo.url, state);
    }
  }
});

// Message handler — side panel communicates via chrome.runtime.sendMessage
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message).then(sendResponse).catch(err => {
    console.warn(`[TabKebab] handler error (${message?.action}):`, err);
    sendResponse({ error: err?.message || String(err) });
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

    case 'reopenTabs': {
      const created = [];
      for (const url of (msg.urls || [])) {
        try {
          const tab = await chrome.tabs.create({ url, active: false });
          created.push(tab.id);
        } catch (e) {
          console.warn('[TabKebab] Failed to reopen tab:', url, e);
        }
      }
      return { created: created.length };
    }

    case 'focusTab':
      await focusTab(msg.tabId);
      return { success: true };

    case 'saveSession':
      return saveSession(msg.name);

    case 'restoreSession': {
      const onProgress = ({ created, loaded, total }) => {
        chrome.runtime.sendMessage({
          action: 'restoreProgress',
          restoreId: msg.sessionId,
          created,
          loaded,
          total,
        }).catch(() => {});
      };
      return restoreSession(msg.sessionId, { ...msg.options, onProgress });
    }

    case 'listSessions':
      return listSessions();

    case 'deleteSession':
      await deleteSession(msg.sessionId);
      return { success: true };

    case 'undoDeleteSession': {
      const sessions = (await Storage.get('sessions')) || [];
      sessions.push(msg.session);
      sessions.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      await Storage.set('sessions', sessions);
      return { success: true };
    }

    case 'createTabGroup': {
      if (!Array.isArray(msg.tabIds) || msg.tabIds.length === 0 || !msg.tabIds.every(id => Number.isInteger(id))) {
        throw new Error('Invalid tabIds: expected non-empty array of integers');
      }
      const validColors = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
      const groupColor = validColors.includes(msg.color) ? msg.color : 'blue';
      const groupTitle = typeof msg.title === 'string' ? msg.title.slice(0, 200) : '';
      return createNativeGroup(msg.tabIds, groupTitle, groupColor);
    }

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

      if (!response.parsed || typeof response.parsed !== 'object') {
        return { error: 'Could not understand that command' };
      }

      const parsed = response.parsed;
      if (!parsed.action || typeof parsed.action !== 'string') {
        return { error: 'AI returned an invalid action' };
      }
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
    }

    // ── Stash ──

    case 'stashWindow': {
      const tabs = await getAllTabs({ allWindows: true });
      const windowTabs = tabs.filter(t => t.windowId === msg.windowId);
      if (windowTabs.length === 0) return { error: 'No tabs in window' };

      let chromeGroups = [];
      try { chromeGroups = await chrome.tabGroups.query({ windowId: msg.windowId }); } catch (e) { console.warn('[TabKebab] tabGroups query failed:', e); }

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
        try { await createBookmarks(); } catch (e) { console.warn('[TabKebab] auto-bookmark on stash failed:', e); }
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
      } catch (e) { console.warn('[TabKebab] stash failed:', e); }

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

      const onProgress = ({ created, loaded, total }) => {
        chrome.runtime.sendMessage({
          action: 'restoreProgress',
          restoreId: msg.stashId,
          created,
          loaded,
          total,
        }).catch(() => {});
      };

      const restoreResult = await restoreStashTabs(stash, { ...(msg.options || {}), onProgress });

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
      } else if (restoreResult.restoredCount > 0) {
        // Mark stash as restored (when not deleted)
        stash.restoredAt = Date.now();
        await saveStash(stash);
      }

      return restoreResult;
    }

    case 'deleteStash':
      await deleteStashDB(msg.stashId);
      return { success: true };

    case 'undoDeleteStash':
      await saveStash(msg.stash);
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
      const syncSettings = await getSettings();
      const bookmarks = (await Storage.get('tabkebabBookmarks')) || [];
      if (bookmarks.length > 0) {
        const bmPayload = { bookmarks, exportedAt: Date.now() };
        if (syncSettings.compressedExport) {
          await exportRawToSubfolder('bookmarks', `bookmarks-${dateStr}.json`, JSON.stringify(bmPayload), 'application/json');
        } else {
          await exportToSubfolder('bookmarks', `bookmarks-${dateStr}.json`, bmPayload);
        }
        results.bookmarks = bookmarks.length;

        // Also upload HTML from the most recent bookmark snapshot
        if (syncSettings.exportHtmlBookmarkToDrive && bookmarks[0]?.formats) {
          try {
            const html = generateBookmarkHtml(bookmarks[0]);
            await exportRawToSubfolder('bookmarks', `bookmarks-${dateStr}.html`, html, 'text/html');
          } catch (e) { console.warn('[TabKebab] HTML bookmark export in sync failed:', e); }
        }
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
          } catch (e) { console.warn('[TabKebab] Drive file delete failed:', file.id, e); }
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

    // ── Focus Mode ──

    case 'getFocusState':
      return getFocusState();

    case 'startFocus':
      return startFocus(msg);

    case 'endFocus':
      return endFocus();

    case 'pauseFocus':
      return pauseFocus();

    case 'resumeFocus':
      return resumeFocus();

    case 'extendFocus':
      return extendFocus(msg.minutes || 5);

    case 'getFocusHistory':
      return getFocusHistory();

    case 'getFocusProfiles':
      return getAllProfiles();

    default:
      return { error: `Unknown action: ${msg.action}` };
  }
}
