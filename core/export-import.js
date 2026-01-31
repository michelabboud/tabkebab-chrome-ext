// core/export-import.js — JSON file export/import

import { Storage } from './storage.js';
import { getAllStashes, importStashes } from './stash-db.js';

export async function exportData() {
  const sessions = (await Storage.get('sessions')) || [];
  const manualGroups = (await Storage.get('manualGroups')) || {};
  const keepAwakeDomains = (await Storage.get('keepAwakeDomains')) || [];
  const stashes = await getAllStashes();

  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    sessions,
    manualGroups,
    keepAwakeDomains,
    stashes,
  };

  downloadJson(payload, `tabkebab-export-${Date.now()}.json`);
}

export async function exportSession(sessionId) {
  const sessions = (await Storage.get('sessions')) || [];
  const session = sessions.find(s => s.id === sessionId);
  if (!session) throw new Error('Session not found');

  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    sessions: [session],
  };

  const safeName = (session.name || 'session').replace(/[^a-z0-9_-]/gi, '_').slice(0, 40);
  downloadJson(payload, `tabkebab-session-${safeName}-${Date.now()}.json`);
}

function downloadJson(payload, filename) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: 'application/json'
  });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export async function importData(file) {
  const text = await file.text();
  const data = JSON.parse(text);

  if (data.version !== 1) {
    throw new Error('Unsupported export file version');
  }

  if (data.sessions) {
    const existing = (await Storage.get('sessions')) || [];
    const existingIds = new Set(existing.map(s => s.id));
    const newSessions = data.sessions.filter(s => !existingIds.has(s.id));
    await Storage.set('sessions', [...newSessions, ...existing]);
  }

  if (data.manualGroups) {
    const existing = (await Storage.get('manualGroups')) || {};
    // Imported groups fill in missing keys; existing keys are preserved
    await Storage.set('manualGroups', { ...data.manualGroups, ...existing });
  }

  if (data.keepAwakeDomains) {
    const existing = (await Storage.get('keepAwakeDomains')) || [];
    const merged = new Set([...data.keepAwakeDomains, ...existing]);
    await Storage.set('keepAwakeDomains', [...merged]);
  }

  if (data.stashes && Array.isArray(data.stashes)) {
    await importStashes(data.stashes);
  }
}
