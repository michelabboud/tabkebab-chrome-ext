// Source-text helpers for invariants on the service worker, which is split
// into the tabkebab-service-worker.js entry point plus feature modules under
// core/background/. Every lookup throws when its marker is missing, so a
// renamed function or handler can never make an assertion pass vacuously.

import { readFileSync, readdirSync } from 'node:fs';

const ROOT = new URL('../../', import.meta.url);

export const WORKER_ENTRY = 'tabkebab-service-worker.js';
export const BACKGROUND_DIR = 'core/background/';

export function backgroundModulePaths() {
  return readdirSync(new URL(BACKGROUND_DIR, ROOT))
    .filter((name) => name.endsWith('.js'))
    .sort()
    .map((name) => `${BACKGROUND_DIR}${name}`);
}

export function workerModulePaths() {
  return [WORKER_ENTRY, ...backgroundModulePaths()];
}

export function readWorkerModule(path) {
  return readFileSync(new URL(path, ROOT), 'utf8');
}

/** The entry point and every background module, concatenated. */
export function readWorkerSource() {
  return workerModulePaths().map(readWorkerModule).join('\n');
}

/** Text from `startMarker` up to (not including) the next `endMarker`. */
export function sliceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error(`Marker not found: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (end < 0) throw new Error(`End marker not found after ${startMarker}: ${endMarker}`);
  return source.slice(start, end);
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Locate the message handler for `action`: an `  async <action>(` method in an
 * exported `<feature>Handlers` map of a background module. Returns null when
 * no module defines it; throws when more than one does.
 */
export function findHandler(action) {
  const pattern = new RegExp(`^  async ${escapeRegExp(action)}\\(`, 'm');
  const found = [];
  for (const path of backgroundModulePaths()) {
    const source = readWorkerModule(path);
    const match = pattern.exec(source);
    if (!match) continue;
    const mapStart = source.lastIndexOf('\nexport const ', match.index);
    const mapHeader = mapStart < 0 ? '' : source.slice(mapStart + 1, source.indexOf('\n', mapStart + 1));
    if (!/^export const \w+Handlers = \{$/.test(mapHeader)) continue;
    if (/^\};$/m.test(source.slice(mapStart, match.index))) continue;

    const rest = source.slice(match.index + match[0].length);
    const next = /^  async \w+\(|^\};$/m.exec(rest);
    if (!next) throw new Error(`Unterminated handler body: ${action}`);
    found.push({
      path,
      body: source.slice(match.index, match.index + match[0].length + next.index),
    });
  }
  if (found.length > 1) {
    throw new Error(`Handler ${action} is defined in ${found.map(({ path }) => path).join(', ')}`);
  }
  return found[0] ?? null;
}

/** Body of the handler for `action`; throws when there is none. */
export function handlerBody(action) {
  const handler = findHandler(action);
  if (!handler) throw new Error(`No message handler for ${action}`);
  return handler.body;
}
