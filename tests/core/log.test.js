// log.test.js — Scoped `[TabKebab:<scope>]` console logger and its adoption
// across the background worker.

import { afterEach, describe, expect, test } from 'bun:test';
import { createLogger } from '../../core/log.js';
import { workerModulePaths, readWorkerModule } from '../helpers/worker-source.js';

const LEVELS = ['log', 'info', 'warn', 'error', 'debug'];
const original = Object.fromEntries(LEVELS.map((level) => [level, console[level]]));

afterEach(() => {
  for (const level of LEVELS) console[level] = original[level];
});

function capture() {
  const calls = [];
  for (const level of LEVELS) console[level] = (...args) => calls.push([level, ...args]);
  return calls;
}

describe('createLogger', () => {
  test('prefixes every level with [TabKebab:<scope>] and passes extra args through', () => {
    const calls = capture();
    const log = createLogger('drive');
    const error = new Error('boom');
    log.log('hello');
    log.info('info', 1);
    log.warn('sync failed:', error);
    log.error('bad', { a: 1 });
    log.debug('dbg');
    expect(calls).toEqual([
      ['log', '[TabKebab:drive] hello'],
      ['info', '[TabKebab:drive] info', 1],
      ['warn', '[TabKebab:drive] sync failed:', error],
      ['error', '[TabKebab:drive] bad', { a: 1 }],
      ['debug', '[TabKebab:drive] dbg'],
    ]);
    expect(calls[2][2]).toBe(error);
  });

  test('non-string first arguments keep the prefix as its own argument', () => {
    const calls = capture();
    const log = createLogger('worker');
    const error = new Error('x');
    log.warn(error);
    log.error();
    expect(calls).toEqual([['warn', '[TabKebab:worker]', error], ['error', '[TabKebab:worker]']]);
  });

  test('looks the console method up at call time (late console swaps are honoured)', () => {
    const log = createLogger('focus');
    const calls = capture();
    log.warn('late');
    expect(calls).toEqual([['warn', '[TabKebab:focus] late']]);
  });
});

describe('worker logging adoption', () => {
  const extraCoreModules = [
    'core/focus.js',
    'core/drive-client.js',
    'core/grouping.js',
    'core/engine/executor.js',
    'core/tab-restore.js',
  ];

  test('no worker module logs with the bare [TabKebab] prefix', () => {
    for (const path of [...workerModulePaths(), ...extraCoreModules]) {
      const source = readWorkerModule(path);
      expect({ path, bare: /\[TabKebab\]/.test(source) }).toEqual({ path, bare: false });
      expect({ path, rawConsole: /console\.(log|info|warn|error|debug)\(/.test(source) })
        .toEqual({ path, rawConsole: false });
    }
  });

  test('the entry point logs under the worker scope', () => {
    expect(readWorkerModule(workerModulePaths()[0])).toContain("createLogger('worker')");
  });
});
