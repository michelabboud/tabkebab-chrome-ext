// keep-awake-defaults.js — Shared effective defaults for protected domains

export const DEFAULT_KEEP_AWAKE_DOMAINS = Object.freeze([
  'gmail.com',
  'outlook.com',
  'outlook.live.com',
  'mail.yahoo.com',
  'proton.me',
  'calendar.google.com',
  'outlook.office.com',
  'claude.ai',
  'chat.openai.com',
  'aistudio.google.com',
  'gemini.google.com',
  'codex.openai.com',
]);

export function createDefaultKeepAwakeDomains() {
  return [...DEFAULT_KEEP_AWAKE_DOMAINS];
}
