// feature-switches.test.js — Settings → Features: settings model, router
// gating, alarm schedules, and worker integration.

import { describe, expect, test } from 'bun:test';

import { installChromeMock } from '../helpers/chrome-mock.js';
import {
  FEATURE_KEYS,
  PORTABLE_SETTINGS_KEYS,
  SETTINGS_DEFAULTS,
  getSettings,
  isFeatureOn,
  mergeFeatures,
  saveSettings,
  validateSettingsPatch,
} from '../../core/settings.js';
// Background modules touch chrome.* at import time: install the mock first.
installChromeMock();
const {
  ACTION_FEATURES,
  createFeatureCache,
  createRouter,
  disabledFeatureForAction,
} = await import('../../core/background/router.js');
const {
  ALARM_AUTO_BOOKMARK,
  ALARM_AUTO_KEBAB,
  ALARM_AUTO_SAVE,
  ALARM_AUTO_STASH,
  ALARM_AUTO_SYNC_DRIVE,
  ALARM_RETENTION_CLEANUP,
  createAlarmHandler,
  desiredManagedAlarmPeriods,
} = await import('../../core/background/alarms.js');
const { runRetentionCleanup, driveHandlers } = await import('../../core/background/drive.js');
const { autoSaveIfEnabled } = await import('../../core/background/lifecycle.js');
const { tabHandlers } = await import('../../core/background/tabs.js');
const { sessionHandlers } = await import('../../core/background/sessions.js');
const { groupingHandlers } = await import('../../core/background/grouping.js');
const { stashHandlers } = await import('../../core/background/stash.js');
const { bookmarkHandlers } = await import('../../core/background/bookmarks.js');
const { settingsHandlers } = await import('../../core/background/settings.js');
const { aiHandlers } = await import('../../core/background/ai.js');
const { focusHandlers } = await import('../../core/background/focus.js');

const ALL_ON = Object.fromEntries(FEATURE_KEYS.map((key) => [key, true]));
const allOff = () => Object.fromEntries(FEATURE_KEYS.map((key) => [key, false]));

let importNonce = 0;
function freshWorker(label) {
  return import(`../../tabkebab-service-worker.js?features=${label}-${++importNonce}`);
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('feature switches: settings model', () => {
  test('defaults list every feature, all on, and are portable', () => {
    expect(FEATURE_KEYS).toEqual([
      'focus', 'ai', 'drive', 'bookmarks', 'automation', 'duplicates',
      'sessions', 'stash', 'windows', 'commandBar', 'search',
    ]);
    expect(SETTINGS_DEFAULTS.features).toEqual(ALL_ON);
    expect(PORTABLE_SETTINGS_KEYS).toContain('features');
    expect(validateSettingsPatch({}).features).toEqual(ALL_ON);
  });

  test('legacy settings without features (or with partial/malformed ones) load all-on', async () => {
    installChromeMock({ local: { tabkebabSettings: { theme: 'dark', autoKebabAfterHours: 0 } } });
    const legacy = await getSettings();
    expect(legacy.theme).toBe('dark');
    expect(legacy.features).toEqual(ALL_ON);

    installChromeMock({ local: { tabkebabSettings: { features: { ai: false } } } });
    expect((await getSettings()).features).toEqual({ ...ALL_ON, ai: false });

    // A downgrade (unknown switch) or corrupt values never lock the panel out.
    installChromeMock({ local: { tabkebabSettings: { features: { future: false, drive: 'no' } } } });
    expect((await getSettings()).features).toEqual(ALL_ON);
    installChromeMock({ local: { tabkebabSettings: { features: 'off' } } });
    expect((await getSettings()).features).toEqual(ALL_ON);
  });

  test('a features patch merges over the current switches', () => {
    const current = validateSettingsPatch({ features: { drive: false } });
    const next = validateSettingsPatch({ features: { ai: false } }, current);
    expect(next.features).toEqual({ ...ALL_ON, drive: false, ai: false });
    // Other settings saves leave the switches alone.
    expect(validateSettingsPatch({ theme: 'light' }, next).features).toEqual(next.features);
  });

  test('rejects unknown features, non-boolean values and non-object features', () => {
    expect(() => validateSettingsPatch({ features: { teleport: false } })).toThrow('unknown feature teleport');
    expect(() => validateSettingsPatch({ features: { ai: 'false' } })).toThrow('features.ai must be a boolean');
    expect(() => validateSettingsPatch({ features: { ai: 0 } })).toThrow('features.ai must be a boolean');
    expect(() => validateSettingsPatch({ features: true })).toThrow('features must be an object');
    expect(() => validateSettingsPatch({ features: [] })).toThrow('features must be an object');
    expect(() => validateSettingsPatch({ features: null })).toThrow('features must be an object');
  });

  test('saveSettings persists the merged switches', async () => {
    installChromeMock();
    const saved = await saveSettings({ features: { stash: false } });
    expect(saved.features).toEqual({ ...ALL_ON, stash: false });
    expect((await getSettings()).features.stash).toBe(false);
  });

  test('helpers treat missing switches as on', () => {
    expect(isFeatureOn({}, 'ai')).toBe(true);
    expect(isFeatureOn(null, 'ai')).toBe(true);
    expect(isFeatureOn({ features: { ai: false } }, 'ai')).toBe(false);
    expect(mergeFeatures(undefined)).toEqual(ALL_ON);
  });

  test('portable settings export carries the switches and import merges them per feature', async () => {
    installChromeMock({ local: { tabkebabSettings: { features: { drive: false } } } });
    const worker = await freshWorker('portable');
    const exported = await worker.handleMessage({ action: 'buildPortableExport', kind: 'settings' });
    expect(exported.settings.features).toEqual({ ...ALL_ON, drive: false });

    // An import that only mentions `ai` never flips the local Drive switch.
    const document = JSON.parse(JSON.stringify(exported));
    document.settings.features = { ai: false };
    await worker.handleMessage({ action: 'importPortableData', document });
    expect((await getSettings()).features).toEqual({ ...ALL_ON, drive: false, ai: false });

    // Hostile switches are rejected before anything is written.
    const hostile = JSON.parse(JSON.stringify(exported));
    hostile.settings.features = { ai: 'yes' };
    await expect(worker.handleMessage({ action: 'importPortableData', document: hostile })).rejects.toThrow();
    hostile.settings.features = { teleport: true };
    await expect(worker.handleMessage({ action: 'importPortableData', document: hostile })).rejects.toThrow();
  });

  test('a settings import keeps the Drive retention guards intact', async () => {
    installChromeMock({
      local: { tabkebabSettings: { neverDeleteFromDrive: true, driveRetentionDays: 90 } },
    });
    const worker = await freshWorker('guards');
    const exported = await worker.handleMessage({ action: 'buildPortableExport', kind: 'settings' });
    const document = JSON.parse(JSON.stringify(exported));
    document.settings.neverDeleteFromDrive = false;
    document.settings.driveRetentionDays = 1;
    document.settings.features = { drive: true };
    await worker.handleMessage({ action: 'importPortableData', document });
    const after = await getSettings();
    expect(after.neverDeleteFromDrive).toBe(true);
    expect(after.driveRetentionDays).toBe(90);
  });
});

describe('feature switches: router gating', () => {
  const ALL_HANDLER_MAPS = [
    tabHandlers, sessionHandlers, groupingHandlers, stashHandlers, bookmarkHandlers,
    driveHandlers, settingsHandlers, aiHandlers, focusHandlers,
  ];

  test('the action map only names registered actions and known features', () => {
    const registered = new Set(ALL_HANDLER_MAPS.flatMap((map) => Object.keys(map)));
    for (const [action, features] of Object.entries(ACTION_FEATURES)) {
      expect(registered.has(action)).toBe(true);
      for (const feature of features) expect(FEATURE_KEYS).toContain(feature);
    }
  });

  test('recovery, listing, export and running-Focus actions are never gated', () => {
    for (const action of [
      'listStashes', 'restoreStash', 'undoDeleteStash', 'listSessions', 'restoreSession',
      'undoDeleteSession', 'buildPortableExport', 'buildPortableSessionExport',
      'buildPortableStashExport', 'importPortableData', 'getSettings', 'saveSettings',
      'endFocus', 'pauseFocus', 'resumeFocus', 'extendFocus', 'getFocusState',
      'getAISettings', 'clearAICache', 'listLocalBookmarks', 'undoDriveSettings',
      'getTabs', 'getGroupedTabs', 'getWindowStats',
    ]) {
      expect(disabledFeatureForAction(action, allOff())).toBeNull();
    }
  });

  test('a disabled feature returns a clear error without running the handler', async () => {
    let features = { ...ALL_ON, stash: false };
    const router = createRouter({ getFeatures: () => features });
    const calls = [];
    router.registerHandlers({
      stashWindow: async () => { calls.push('stashWindow'); return { success: true }; },
      listStashes: async () => { calls.push('listStashes'); return []; },
      restoreStash: async () => { calls.push('restoreStash'); return { success: true }; },
    });

    await expect(router.dispatch({ action: 'stashWindow' }))
      .resolves.toEqual({ error: 'Feature "stash" is turned off in Settings' });
    await expect(router.dispatch({ action: 'listStashes' })).resolves.toEqual([]);
    await expect(router.dispatch({ action: 'restoreStash' })).resolves.toEqual({ success: true });
    expect(calls).toEqual(['listStashes', 'restoreStash']);

    features = { ...ALL_ON };
    await expect(router.dispatch({ action: 'stashWindow' })).resolves.toEqual({ success: true });
  });

  test('the command bar needs both AI and the command-bar switch', () => {
    expect(disabledFeatureForAction('executeNLCommand', { ...ALL_ON, commandBar: false })).toBe('commandBar');
    expect(disabledFeatureForAction('executeNLCommand', { ...ALL_ON, ai: false })).toBe('ai');
    expect(disabledFeatureForAction('summarizeTabs', { ...ALL_ON, commandBar: false })).toBeNull();
    expect(disabledFeatureForAction('startFocus', { ...ALL_ON, focus: false })).toBe('focus');
    expect(disabledFeatureForAction('endFocus', { ...ALL_ON, focus: false })).toBeNull();
  });

  test('with every feature on, dispatch enters handlers synchronously and unchanged', async () => {
    const router = createRouter({ getFeatures: () => ({ ...ALL_ON }) });
    const order = [];
    router.registerHandlers({
      stashWindow: async (msg, ctx) => { order.push('stash'); return { msg, ctx }; },
      getTabs: async () => { order.push('tabs'); return []; },
    });
    const pending = router.dispatch({ action: 'stashWindow' }, { now: 1 }, { focusReadiness: 'r' });
    router.dispatch({ action: 'getTabs' });
    expect(order).toEqual(['stash', 'tabs']); // FIFO, no await before the handler
    await expect(pending).resolves.toEqual({
      msg: { action: 'stashWindow' },
      ctx: { now: 1, focusReadiness: 'r' },
    });
  });

  test('gates through an async features load and treats unknown switches as on', async () => {
    const router = createRouter({ getFeatures: async () => ({ drive: false }) });
    router.registerHandlers({
      syncDriveState: async () => 'synced',
      createBookmarks: async () => 'bookmarked',
    });
    await expect(router.dispatch({ action: 'syncDriveState' }))
      .resolves.toEqual({ error: 'Feature "drive" is turned off in Settings' });
    await expect(router.dispatch({ action: 'createBookmarks' })).resolves.toBe('bookmarked');

    const ungated = createRouter();
    ungated.registerHandlers({ syncDriveState: async () => 'synced' });
    await expect(ungated.dispatch({ action: 'syncDriveState' })).resolves.toBe('synced');
  });

  test('feature cache loads once, then answers synchronously; failures read as all-on', async () => {
    let loads = 0;
    const cache = createFeatureCache(async () => { loads += 1; return { ai: false }; });
    const first = cache.get();
    expect(typeof first.then).toBe('function');
    await expect(first).resolves.toEqual({ ai: false });
    expect(cache.get()).toEqual({ ai: false });
    cache.set({ ai: true });
    expect(cache.get()).toEqual({ ai: true });
    expect(loads).toBe(1);

    const broken = createFeatureCache(async () => { throw new Error('storage down'); });
    await expect(broken.get()).resolves.toBeNull();
    expect(broken.get()).toBeNull();
  });

  test('worker: switches gate live and follow settings saves', async () => {
    installChromeMock({ local: { tabkebabSettings: { features: { duplicates: false } } } });
    const worker = await freshWorker('gating');
    await expect(worker.handleMessage({ action: 'findDuplicates' }))
      .resolves.toEqual({ error: 'Feature "duplicates" is turned off in Settings' });
    // Recovery listing stays allowed.
    expect(Array.isArray(await worker.handleMessage({ action: 'listSessions' }))).toBe(true);

    await worker.handleMessage({ action: 'saveSettings', settings: { features: { duplicates: true } } });
    const result = await worker.handleMessage({ action: 'findDuplicates' });
    expect(result?.error).toBeUndefined();

    await worker.handleMessage({ action: 'saveSettings', settings: { features: { focus: false } } });
    await expect(worker.handleMessage({ action: 'startFocus', profileId: 'coding', duration: 25 }))
      .resolves.toEqual({ error: 'Feature "focus" is turned off in Settings' });
  });
});

describe('feature switches: alarms', () => {
  const scheduled = {
    ...SETTINGS_DEFAULTS,
    autoKebabAfterHours: 3,
    autoStashAfterDays: 7,
    autoSyncToDriveIntervalHours: 6,
    autoBookmarkOnStash: true,
    bookmarkByDomains: true,
  };

  test('all on: the schedule is unchanged', () => {
    expect(desiredManagedAlarmPeriods(scheduled)).toEqual({
      [ALARM_AUTO_SAVE]: 24 * 60,
      [ALARM_AUTO_KEBAB]: 60,
      [ALARM_AUTO_STASH]: 360,
      [ALARM_AUTO_SYNC_DRIVE]: 360,
      [ALARM_RETENTION_CLEANUP]: 720,
      [ALARM_AUTO_BOOKMARK]: 720,
    });
  });

  test('each switch removes its own alarms', () => {
    const off = (feature) => desiredManagedAlarmPeriods({
      ...scheduled,
      features: { ...ALL_ON, [feature]: false },
    });
    expect(off('automation')).toMatchObject({
      [ALARM_AUTO_SAVE]: null, [ALARM_AUTO_KEBAB]: null, [ALARM_AUTO_STASH]: null,
      [ALARM_AUTO_SYNC_DRIVE]: 360, [ALARM_RETENTION_CLEANUP]: 720, [ALARM_AUTO_BOOKMARK]: 720,
    });
    expect(off('drive')).toMatchObject({
      [ALARM_AUTO_SYNC_DRIVE]: null, [ALARM_RETENTION_CLEANUP]: 720, [ALARM_AUTO_SAVE]: 24 * 60,
    });
    expect(off('bookmarks')).toMatchObject({ [ALARM_AUTO_BOOKMARK]: null, [ALARM_AUTO_STASH]: 360 });
    expect(off('stash')).toMatchObject({ [ALARM_AUTO_STASH]: null, [ALARM_AUTO_KEBAB]: 60 });
    expect(off('sessions')).toMatchObject({ [ALARM_AUTO_SAVE]: null });
    const both = desiredManagedAlarmPeriods({
      ...scheduled,
      features: { ...ALL_ON, automation: false, drive: false },
    });
    expect(both[ALARM_RETENTION_CLEANUP]).toBeNull();
  });

  test('worker: saving switches clears and restores real alarms', async () => {
    const harness = installChromeMock({
      local: { tabkebabSettings: { autoSyncToDriveIntervalHours: 6 } },
    });
    const worker = await freshWorker('alarms');
    const names = () => harness.snapshot().alarms.map((alarm) => alarm.name).sort();

    await worker.handleMessage({ action: 'saveSettings', settings: { theme: 'dark' } });
    expect(names()).toEqual([ALARM_AUTO_KEBAB, ALARM_AUTO_SAVE, ALARM_AUTO_SYNC_DRIVE, ALARM_RETENTION_CLEANUP].sort());

    await worker.handleMessage({
      action: 'saveSettings',
      settings: { features: { automation: false, drive: false } },
    });
    expect(names()).toEqual([]);

    await worker.handleMessage({
      action: 'saveSettings',
      settings: { features: { automation: true, drive: true } },
    });
    expect(names()).toEqual([ALARM_AUTO_KEBAB, ALARM_AUTO_SAVE, ALARM_AUTO_SYNC_DRIVE, ALARM_RETENTION_CLEANUP].sort());
  });

  test('an alarm that fires after its feature was switched off does nothing', async () => {
    const runs = [];
    const handle = createAlarmHandler({ onFocusTick: () => runs.push('tick') });
    const runners = {
      runAutoSave: async () => runs.push('save'),
      runAutoKebab: async () => runs.push('kebab'),
      runAutoStash: async () => runs.push('stash'),
      runAutoSync: async () => runs.push('sync'),
      runAutoBookmark: async () => runs.push('bookmark'),
      runRetention: async () => runs.push('retention'),
    };
    const off = { features: { ...ALL_ON, automation: false, drive: false, bookmarks: false } };
    for (const name of [ALARM_AUTO_SAVE, ALARM_AUTO_KEBAB, ALARM_AUTO_STASH, ALARM_AUTO_SYNC_DRIVE, ALARM_AUTO_BOOKMARK]) {
      await handle({ name }, { ...runners, loadSettings: async () => off });
    }
    expect(runs).toEqual([]);
    await handle({ name: ALARM_AUTO_KEBAB }, { ...runners, loadSettings: async () => ({ features: ALL_ON }) });
    await handle({ name: ALARM_AUTO_SAVE }, { ...runners, loadSettings: async () => { throw new Error('x'); } });
    expect(runs).toEqual(['kebab', 'save']);
  });

  test('retention never prunes auto-saves while Automation is off, nor touches Drive while Drive is off', async () => {
    installChromeMock();
    const old = (id) => ({ id, name: `[Auto] ${id}`, createdAt: 1, windows: [] });
    const deleted = [];
    const listed = [];
    const run = (features) => runRetentionCleanup({
      getSettings: async () => ({ ...SETTINGS_DEFAULTS, neverDeleteFromDrive: false, features }),
      getStorage: async (key) => (key === 'sessions'
        ? [old('a'), old('b'), old('c')]
        : { connected: true }),
      deleteSessions: async (ids) => { deleted.push(...ids); },
      now: () => 100 * 24 * 60 * 60 * 1000,
      listFiles: async () => { listed.push('list'); return []; },
      deleteFile: async () => {},
    });

    await run({ ...ALL_ON, automation: false, drive: false });
    expect(deleted).toEqual([]);
    expect(listed).toEqual([]);

    await run({ ...ALL_ON });
    expect(deleted).toEqual(['c']);
    expect(listed.length).toBeGreaterThan(0);
  });

  test('startup auto-save is skipped while Automation or Sessions is off', async () => {
    const saves = [];
    const autoSave = async () => { saves.push('save'); return 'saved'; };
    await autoSaveIfEnabled({ loadSettings: async () => ({ features: { ...ALL_ON, automation: false } }), autoSave });
    await autoSaveIfEnabled({ loadSettings: async () => ({ features: { ...ALL_ON, sessions: false } }), autoSave });
    expect(saves).toEqual([]);
    await expect(autoSaveIfEnabled({ loadSettings: async () => ({}), autoSave })).resolves.toBe('saved');
    await flush();
  });
});
