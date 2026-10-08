// core/background/settings.js — Settings get/save, Drive settings
// import/undo, and portable (file) export/import actions.

import { Storage } from '../storage.js';
import { getSettings, preserveDriveRetentionGuards, saveSettings, validateSettingsPatch } from '../settings.js';
import { withStateMutationLock } from '../state-mutation-lock.js';
import {
  PORTABLE_KIND_SECTIONS,
  applyPortableImport,
  buildPortableExportPayload,
} from '../export-import.js';
import {
  createPortableExportDocument,
  parsePortableExportDocument,
} from '../export-schema.js';
import { requireExactRuntimeFields, requirePortableRecordId } from './router.js';
import { reconfigureAlarms } from './alarms.js';
import { createLogger } from '../log.js';
const log = createLogger('settings');

function requirePortableKind(kind) {
  if (typeof kind !== 'string' || !Object.hasOwn(PORTABLE_KIND_SECTIONS, kind)) {
    throw new TypeError('Portable export kind must be full, sessions, stashes, or settings');
  }
  return kind;
}

// ── Message handlers ──

export const settingsHandlers = {
  async buildPortableExport(msg, ctx) {
    const { buildPortableExportPayload: buildPortableExportOperation = buildPortableExportPayload } = ctx;
    requireExactRuntimeFields(msg, ['action', 'kind'], 'Portable export request');
    const kind = requirePortableKind(msg.kind);
    return withStateMutationLock(() => buildPortableExportOperation(kind));
  },

  async buildPortableSessionExport(msg, ctx) {
    const { buildPortableExportPayload: buildPortableExportOperation = buildPortableExportPayload } = ctx;
    requireExactRuntimeFields(
      msg,
      ['action', 'sessionId'],
      'Portable session export request',
    );
    const sessionId = requirePortableRecordId(msg.sessionId, 'Session ID');
    return withStateMutationLock(async () => {
      const document = await buildPortableExportOperation('sessions');
      const session = document.sessions.find((record) => record.id === sessionId);
      if (!session) throw new Error('Session not found');
      return createPortableExportDocument(
        'sessions',
        { sessions: [session] },
        document.exportedAt,
      );
    });
  },

  async buildPortableStashExport(msg, ctx) {
    const { buildPortableExportPayload: buildPortableExportOperation = buildPortableExportPayload } = ctx;
    requireExactRuntimeFields(
      msg,
      ['action', 'stashId'],
      'Portable stash export request',
    );
    const stashId = requirePortableRecordId(msg.stashId, 'Stash ID');
    return withStateMutationLock(async () => {
      const document = await buildPortableExportOperation('stashes');
      const stash = document.stashes.find((record) => record.id === stashId);
      if (!stash) throw new Error('Stash not found');
      return createPortableExportDocument(
        'stashes',
        { stashes: [stash] },
        document.exportedAt,
      );
    });
  },

  async importPortableData(msg, ctx) {
    const {
      getSettings: loadSettings = getSettings,
      parsePortableDocument: parsePortableDocumentOperation = parsePortableExportDocument,
      applyPortableImport: applyPortableImportOperation = applyPortableImport,
      reconfigureAlarms: reconfigureAlarmsOperation = reconfigureAlarms,
    } = ctx;
    requireExactRuntimeFields(msg, ['action', 'document'], 'Portable import request');
    return withStateMutationLock(async () => {
      const parsedDocument = parsePortableDocumentOperation(msg.document);
      const result = await applyPortableImportOperation(parsedDocument);
      if (!PORTABLE_KIND_SECTIONS[parsedDocument.kind].includes('settings')) return result;
      try {
        const persistedSettings = await loadSettings();
        await reconfigureAlarmsOperation(persistedSettings);
        return result;
      } catch (error) {
        log.error(
          'Portable import committed, but alarm reconfiguration failed:',
          error,
        );
        return {
          ...result,
          committed: true,
          warning: 'Data was imported, but automation schedules could not be refreshed. Restart TabKebab before relying on automatic actions.',
        };
      }
    });
  },

  async getSettings() {
    return getSettings();
  },

  async saveSettings(msg, ctx) {
    const { saveSettings: saveSettingsOperation = saveSettings } = ctx;
    return withStateMutationLock(async () => {
      const saved = await saveSettingsOperation(msg.settings);
      await reconfigureAlarms(saved);
      return saved;
    });
  },

  async importDriveSettings(msg) {
    return withStateMutationLock(async () => {
      const current = await getSettings();
      const replacement = preserveDriveRetentionGuards(
        current,
        validateSettingsPatch(msg.settings, current),
      );
      await Storage.setMany({
        tabkebabSettings: replacement,
        tabkebabSettingsPrevious: current,
      });
      await reconfigureAlarms(replacement);
      return replacement;
    });
  },

  async undoDriveSettings() {
    return withStateMutationLock(async () => {
      const previous = await Storage.get('tabkebabSettingsPrevious');
      if (!previous) throw new Error('No previous settings to restore');
      const restored = await saveSettings(previous);
      await Storage.remove('tabkebabSettingsPrevious');
      await reconfigureAlarms(restored);
      return restored;
    });
  },
};
