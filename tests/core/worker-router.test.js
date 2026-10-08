import { describe, expect, test } from 'bun:test';

import { createRouter } from '../../core/background/router.js';
import {
  WORKER_ENTRY,
  backgroundModulePaths,
  readWorkerModule,
} from '../helpers/worker-source.js';

describe('service-worker entry point', () => {
  test('registers every chrome event listener at module top level, in order, only in the entry point', () => {
    const entry = readWorkerModule(WORKER_ENTRY);
    const listeners = [...entry.matchAll(/^(.*)chrome\.(\w+(?:\.\w+)*)\.addListener\(/gm)];
    expect(listeners.map((match) => match[2])).toEqual([
      'runtime.onConnect',
      'runtime.onStartup',
      'runtime.onInstalled',
      'alarms.onAlarm',
      'tabs.onCreated',
      'tabs.onRemoved',
      'tabs.onUpdated',
      'runtime.onMessage',
      'storage.onChanged',
    ]);
    for (const match of listeners) expect(match[1]).toBe('');

    for (const path of backgroundModulePaths()) {
      expect(readWorkerModule(path)).not.toMatch(/\.addListener\(/);
    }
  });
});

describe('background message router', () => {
  test('refuses to register one action twice', () => {
    const router = createRouter();
    router.registerHandlers({ ping: async () => 'pong' });
    expect(() => router.registerHandlers({ ping: async () => 'other' })).toThrow('Duplicate message handler: ping');
  });

  test('passes overrides and runtime state, answers unknown actions, and rejects malformed messages', async () => {
    const router = createRouter();
    router.registerHandlers({ echo: async (msg, ctx) => ({ msg, ctx }) });

    await expect(router.dispatch({ action: 'echo' }, { now: 1 }, { focusReadiness: 'ready' }))
      .resolves.toEqual({ msg: { action: 'echo' }, ctx: { now: 1, focusReadiness: 'ready' } });
    await expect(router.dispatch({ action: 'missing' })).resolves.toEqual({ error: 'Unknown action' });
    await expect(router.dispatch({ action: 'constructor' })).resolves.toEqual({ error: 'Unknown action' });
    await expect(router.dispatch(null)).rejects.toThrow(TypeError);
    await expect(router.dispatch({ action: 'echo' }, null)).rejects.toThrow(TypeError);
  });
});
