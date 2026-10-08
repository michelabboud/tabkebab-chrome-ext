// core/background/bookmarks.js — Bookmark snapshots: createBookmarks, the
// Chrome bookmark tree export (depth budget, retention), and the standalone
// HTML export.

import { getWindowStats } from '../grouping.js';
import { getAllTabs, excludeIncognitoTabs, extractDomain } from '../tabs-api.js';
import { Storage } from '../storage.js';
import { getSettings, isFeatureOn } from '../settings.js';
import { exportToSubfolder, exportRawToSubfolder } from '../drive-client.js';
import { withStateMutationLock } from '../state-mutation-lock.js';
import { createLogger } from '../log.js';
const log = createLogger('bookmarks');

// ── Bookmark system ──

export function generateBookmarkHtml(bookmarkData) {
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

  // Highlighting uses text nodes only: page titles/URLs are untrusted and
  // must never be re-parsed as HTML.
  function setPlainText(el,text){
    while(el.firstChild)el.removeChild(el.firstChild);
    el.appendChild(document.createTextNode(text));
  }

  function clearHighlights(){
    allTabs.forEach(function(t){
      var ti=t.querySelector('.tab-title');
      var ur=t.querySelector('.tab-url');
      if(ti)setPlainText(ti,ti.textContent);
      if(ur)setPlainText(ur,ur.textContent);
    });
  }

  function highlightText(el,q){
    if(!el)return;
    var text=el.textContent;
    var idx=text.toLowerCase().indexOf(q);
    if(idx===-1)return;
    var mark=document.createElement('mark');
    mark.appendChild(document.createTextNode(text.slice(idx,idx+q.length)));
    while(el.firstChild)el.removeChild(el.firstChild);
    el.appendChild(document.createTextNode(text.slice(0,idx)));
    el.appendChild(mark);
    el.appendChild(document.createTextNode(text.slice(idx+q.length)));
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

export async function createBookmarksUnlocked(options = {}) {
  const settings = await getSettings();
  const byWindows = options.byWindows ?? settings.bookmarkByWindows;
  const byGroups = options.byGroups ?? settings.bookmarkByGroups;
  const byDomains = options.byDomains ?? settings.bookmarkByDomains;
  const destination = options.destination ?? settings.bookmarkDestination;
  const compressed = options.compressed ?? settings.compressedExport;

  if (!byWindows && !byGroups && !byDomains) return { error: 'No bookmark format selected' };

  // Callers that already captured tabs (stash paths) pass them in so exactly
  // those tabs are bookmarked. Incognito tabs are never persisted.
  const tabs = Array.isArray(options.tabs)
    ? excludeIncognitoTabs(options.tabs)
    : await getAllTabs({ allWindows: true, excludeIncognito: true });
  const date = new Date();
  const dateStr = date.toISOString().slice(0, 10);
  const timeStr = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

  const bookmarkData = {
    id: crypto.randomUUID(),
    date: dateStr,
    time: timeStr,
    createdAt: Date.now(),
    formats: {},
  };
  if (typeof options.stashName === 'string') bookmarkData.stashName = options.stashName;

  // Format 1: By windows (normalized numbering 1..N, windows without
  // persistable tabs are skipped)
  if (byWindows) {
    const order = [];
    try {
      const windowStats = await getWindowStats();
      for (const win of windowStats.windows) order.push(win.windowId);
    } catch (e) { log.warn('window stats failed:', e); }
    for (const t of tabs) if (!order.includes(t.windowId)) order.push(t.windowId);

    const windowBookmarks = [];
    for (const windowId of order) {
      const winTabs = tabs.filter(t => t.windowId === windowId);
      if (winTabs.length === 0) continue;
      windowBookmarks.push({
        name: `Window ${windowBookmarks.length + 1}`,
        tabs: winTabs.map(t => ({ title: t.title, url: t.url })),
      });
    }
    bookmarkData.formats.byWindows = windowBookmarks;
  }

  // Format 2: By groups (derived from the bookmarked tabs themselves)
  if (byGroups) {
    let chromeGroups = [];
    try {
      chromeGroups = await chrome.tabGroups.query({});
    } catch (e) { log.warn('tabGroups query failed:', e); }

    const buckets = new Map();
    for (const g of chromeGroups) buckets.set(g.id, { meta: g, tabs: [] });
    const ungrouped = [];
    for (const t of tabs) {
      if (t.groupId === undefined || t.groupId === null || t.groupId === -1) {
        ungrouped.push(t);
        continue;
      }
      if (!buckets.has(t.groupId)) buckets.set(t.groupId, { meta: null, tabs: [] });
      buckets.get(t.groupId).tabs.push(t);
    }

    const groups = [];
    for (const { meta, tabs: groupTabs } of buckets.values()) {
      if (groupTabs.length === 0) continue;
      groups.push({
        name: meta?.title || 'Untitled',
        color: meta?.color || 'grey',
        tabs: groupTabs.map(t => ({ title: t.title, url: t.url })),
      });
    }
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
  // A stash auto-bookmark covers only the stashed tabs: it writes the stash's
  // own Chrome folder and never touches the full-snapshot history (local list,
  // Drive JSON, Drive HTML), which it would otherwise overwrite or crowd out.
  // It also keeps the stash path free of network work.
  const isStash = typeof options.stashName === 'string';

  // Save to Chrome bookmarks
  if (destination === 'chrome' || destination === 'all') {
    try {
      const chromeResult = await saveToChromeBookmarks(bookmarkData, dateStr, {
        stashLabel: isStash ? `Stash ${timeStr}` : null,
      });
      results.created++;
      results.destinations.push('Chrome Bookmarks');
      results.chromeBookmarksCreated = chromeResult.created;
      if (chromeResult.truncated) {
        results.truncated = true;
        results.warning = `Chrome bookmark export stopped at ${MAX_BOOKMARKS_PER_EXPORT} bookmarks`;
      }
    } catch (err) {
      results.chromeError = err.message;
    }
  }

  // Save to IndexedDB (via storage)
  if (!isStash && (destination === 'indexeddb' || destination === 'all')) {
    try {
      const existing = (await Storage.get('tabkebabBookmarks')) || [];
      existing.unshift(bookmarkData);
      // Keep max 50
      if (existing.length > 50) existing.length = 50;
      await Storage.set('tabkebabBookmarks', existing);
      results.created++;
      results.destinations.push('Local Storage');
    } catch (e) { log.warn('bookmark local save failed:', e); }
  }

  // Save to Google Drive
  if (!isStash && isFeatureOn(settings, 'drive') && (destination === 'drive' || destination === 'all')) {
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
          } catch (e) { log.warn('HTML bookmark export failed:', e); }
        }
      }
    } catch (e) { log.warn('bookmark Drive save failed:', e); }
  }

  return results;
}

export async function createBookmarks(options = {}) {
  return withStateMutationLock(() => createBookmarksUnlocked(options));
}

// ── Chrome bookmark export ──

/** Folder levels below the bookmark bar the export may create (bar = 0). */
export const MAX_BOOKMARK_DEPTH = 4;
/** Newest YYYY-MM-DD folders kept under the TabKebab root. */
export const BOOKMARK_RETENTION_COUNT = 30;
/** Hard cap on bookmark nodes (folders + links) created by one export. */
export const MAX_BOOKMARKS_PER_EXPORT = 5000;

const BOOKMARK_ROOT_TITLE = 'TabKebab';
const BOOKMARK_ROOT_ID_KEY = 'bookmarkRootFolderId';
const BOOKMARK_TITLE_SEPARATOR = ' · ';
const BOOKMARK_DATE_FOLDER = /^\d{4}-\d{2}-\d{2}$/;
const BOOKMARK_SECTIONS = [
  ['byWindows', 'Windows'],
  ['byGroups', 'Groups'],
  ['byDomains', 'Domains'],
];
// Folder levels are dropped (merged into child titles) in this order when
// the depth budget is too small.
const BOOKMARK_FLATTEN_ORDER = ['section', 'item', 'stash', 'date'];

/** Folder levels that may still be created below a root at `rootDepth`. */
export function bookmarkDepthBudget(rootDepth, maxDepth = MAX_BOOKMARK_DEPTH) {
  const depth = Number.isInteger(rootDepth) && rootDepth >= 0 ? rootDepth : 0;
  return Math.max(0, maxDepth - depth);
}

/** Which of `kinds` (outermost first) stay folders within `budget` levels. */
export function planBookmarkFolderLevels(kinds, budget) {
  const kept = kinds.slice();
  for (const kind of BOOKMARK_FLATTEN_ORDER) {
    if (kept.length <= budget) break;
    const index = kept.indexOf(kind);
    if (index !== -1) kept.splice(index, 1);
  }
  while (kept.length > Math.max(0, budget)) kept.pop();
  return new Set(kept);
}

function joinBookmarkTitle(parts) {
  return parts.filter((part) => typeof part === 'string' && part.length > 0).join(BOOKMARK_TITLE_SEPARATOR);
}

/** Folder depth below the top-level folder (bookmark bar / other) it lives in. */
async function bookmarkNodeDepth(node) {
  let depth = 0;
  let current = node;
  for (let i = 0; i < 64 && current?.parentId; i++) {
    let parent;
    try {
      [parent] = await chrome.bookmarks.get(current.parentId);
    } catch {
      break;
    }
    if (!parent?.parentId) break; // parent is the tree root → current is top-level
    depth++;
    current = parent;
  }
  return depth;
}

/**
 * Find the TabKebab root folder: the stored id first (so a renamed or moved
 * folder is reused), then a title match, and only then create a new one.
 */
async function resolveBookmarkRoot(bar) {
  const storedId = await Storage.get(BOOKMARK_ROOT_ID_KEY);
  if (typeof storedId === 'string' && storedId.length > 0) {
    try {
      const [node] = await chrome.bookmarks.get(storedId);
      if (node && !node.url) return node;
    } catch {
      // Stored folder was deleted; fall through.
    }
  }

  let root = bar.children?.find((n) => !n.url && n.title === BOOKMARK_ROOT_TITLE) || null;
  if (!root) {
    try {
      const matches = await chrome.bookmarks.search({ title: BOOKMARK_ROOT_TITLE });
      root = matches.find((n) => !n.url && n.title === BOOKMARK_ROOT_TITLE) || null;
    } catch {
      root = null;
    }
  }
  if (!root) root = await chrome.bookmarks.create({ parentId: bar.id, title: BOOKMARK_ROOT_TITLE });
  await Storage.set(BOOKMARK_ROOT_ID_KEY, root.id);
  return root;
}

/** Keep only the newest `keep` YYYY-MM-DD folders directly under the root. */
async function pruneBookmarkDateFolders(rootId, keep = BOOKMARK_RETENTION_COUNT) {
  const children = await chrome.bookmarks.getChildren(rootId);
  const dated = children
    .filter((n) => !n.url && BOOKMARK_DATE_FOLDER.test(n.title))
    .sort((a, b) => (a.title < b.title ? 1 : a.title > b.title ? -1 : 0));
  let removed = 0;
  for (const folder of dated.slice(Math.max(0, keep))) {
    await chrome.bookmarks.removeTree(folder.id);
    removed++;
  }
  return removed;
}

export async function saveToChromeBookmarks(bookmarkData, dateStr, {
  stashLabel = null,
  maxDepth = MAX_BOOKMARK_DEPTH,
  maxBookmarks = MAX_BOOKMARKS_PER_EXPORT,
  retentionCount = BOOKMARK_RETENTION_COUNT,
} = {}) {
  const tree = await chrome.bookmarks.getTree();
  const bar = tree[0].children.find(n => n.id === '1') || tree[0].children[0]; // Bookmarks bar
  const root = await resolveBookmarkRoot(bar);
  const budget = bookmarkDepthBudget(await bookmarkNodeDepth(root), maxDepth);
  const kinds = stashLabel ? ['date', 'stash', 'section', 'item'] : ['date', 'section', 'item'];
  const kept = planBookmarkFolderLevels(kinds, budget);

  const state = { created: 0, truncated: false };
  const create = async (props) => {
    if (state.created >= maxBookmarks) {
      state.truncated = true;
      return null;
    }
    const node = await chrome.bookmarks.create(props);
    state.created++;
    return node;
  };

  // A cursor is where the next level goes: a parent folder plus the titles of
  // flattened levels above it, which prefix the next created title.
  const descend = async (cursor, kind, title, reuse) => {
    if (!kept.has(kind)) return { parentId: cursor.parentId, prefix: [...cursor.prefix, title] };
    const fullTitle = joinBookmarkTitle([...cursor.prefix, title]);
    if (reuse) {
      const existing = (await chrome.bookmarks.getChildren(cursor.parentId))
        .find((n) => !n.url && n.title === fullTitle);
      if (existing) return { parentId: existing.id, prefix: [] };
    }
    const node = await create({ parentId: cursor.parentId, title: fullTitle });
    return node ? { parentId: node.id, prefix: [] } : null;
  };

  let container = await descend({ parentId: root.id, prefix: [] }, 'date', dateStr, true);
  if (container && stashLabel) container = await descend(container, 'stash', stashLabel, true);

  if (container && !stashLabel) {
    // A snapshot replaces today's previous snapshot instead of appending a
    // second copy (the 12h alarm would otherwise duplicate the tree).
    const base = container.prefix.length > 0
      ? joinBookmarkTitle(container.prefix) + BOOKMARK_TITLE_SEPARATOR
      : '';
    const children = await chrome.bookmarks.getChildren(container.parentId);
    for (const child of children) {
      if (!child.title.startsWith(base)) continue;
      const rest = child.title.slice(base.length);
      const isSnapshotNode = BOOKMARK_SECTIONS.some(([, section]) => (
        rest === section || rest.startsWith(section + BOOKMARK_TITLE_SEPARATOR)
      ));
      if (!isSnapshotNode) continue;
      if (child.url) await chrome.bookmarks.remove(child.id);
      else await chrome.bookmarks.removeTree(child.id);
    }
  }

  if (container) {
    sections:
    for (const [key, sectionTitle] of BOOKMARK_SECTIONS) {
      const items = bookmarkData.formats[key];
      if (!items) continue;
      const sectionCursor = await descend(container, 'section', sectionTitle, false);
      if (!sectionCursor) break;
      for (const item of items) {
        const itemCursor = await descend(sectionCursor, 'item', item.name, false);
        if (!itemCursor) break sections;
        for (const tab of item.tabs) {
          const node = await create({
            parentId: itemCursor.parentId,
            title: joinBookmarkTitle([...itemCursor.prefix, tab.title || tab.url]),
            url: tab.url,
          });
          if (!node) break sections;
        }
      }
    }
  }

  try {
    await pruneBookmarkDateFolders(root.id, retentionCount);
  } catch (e) {
    log.warn('bookmark retention failed:', e);
  }

  return { created: state.created, truncated: state.truncated, depthBudget: budget };
}

// ── Message handlers ──

export const bookmarkHandlers = {
  async createBookmarks(msg) {
    return createBookmarks(msg.options || {});
  },

  async listLocalBookmarks() {
    const bookmarks = (await Storage.get('tabkebabBookmarks')) || [];
    return bookmarks;
  },
};
