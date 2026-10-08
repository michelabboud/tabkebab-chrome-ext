// log.js — Scoped console logger for TabKebab's background code.
//
// Every message is prefixed with `[TabKebab:<scope>]` so TabKebab's output is
// easy to pick out of a shared DevTools console (service worker, side panel).
// Extra arguments pass through untouched, so Errors and objects still print
// expandable. The console method is looked up on every call, never captured,
// so tests that swap console.warn still see the output.

const LEVELS = ['log', 'info', 'warn', 'error', 'debug'];

/**
 * @param {string} scope Short area name, e.g. 'worker', 'focus', 'drive'.
 * @returns {{ log: Function, info: Function, warn: Function, error: Function, debug: Function, prefix: string }}
 */
export function createLogger(scope) {
  const prefix = `[TabKebab:${scope}]`;
  const logger = { prefix };
  for (const level of LEVELS) {
    logger[level] = (first, ...rest) => {
      if (typeof first === 'string') console[level](`${prefix} ${first}`, ...rest);
      else if (first === undefined && rest.length === 0) console[level](prefix);
      else console[level](prefix, first, ...rest);
    };
  }
  return Object.freeze(logger);
}
