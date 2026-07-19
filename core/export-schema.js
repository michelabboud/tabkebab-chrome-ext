// export-schema.js — pure, bounded, secret-free portable export schema

import {
  PORTABLE_SETTINGS_KEYS,
  SETTINGS_CONSTRAINTS,
  SETTINGS_DEFAULTS,
} from './settings.js';
import {
  MAX_DRIVE_TIMESTAMP,
  MAX_DRIVE_TOMBSTONE,
  MAX_DRIVE_TOMBSTONES_PER_KIND,
} from './drive-sync.js';

export const PORTABLE_EXPORT_VERSION = 2;
export const MAX_PORTABLE_IMPORT_BYTES = 25 * 1024 * 1024;
export const MAX_PORTABLE_SECTION_RECORDS = 10_000;
export const MAX_PORTABLE_TABS_PER_RECORD = 10_000;
export const MAX_PORTABLE_TOTAL_TABS = 100_000;
export const MAX_PORTABLE_STRING_LENGTH = 16_384;
export const MAX_PORTABLE_NESTING_DEPTH = 12;

const SECTION_ORDER = Object.freeze([
  'sessions',
  'stashes',
  'manualGroups',
  'keepAwakeDomains',
  'bookmarks',
  'settings',
  'focusProfilePrefs',
  'focusHistory',
  'aiSettings',
]);

const KIND_SECTIONS = Object.freeze({
  full: SECTION_ORDER,
  sessions: Object.freeze(['sessions']),
  stashes: Object.freeze(['stashes']),
  settings: Object.freeze(['settings']),
});

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const FORBIDDEN_PORTABLE_KEYS = new Set([
  'apiKey',
  'token',
  'credential',
  'installId',
  'focusState',
  'driveSync',
  'driveProfileName',
  'focusGroupOwnership',
  'tabkebabSettingsPrevious',
]);
const PROVIDER_IDS = Object.freeze(['chrome-ai', 'claude', 'custom', 'gemini', 'openai']);
const PROVIDER_ID_SET = new Set(PROVIDER_IDS);
const textEncoder = new TextEncoder();
let activeCanonicalStashValidation = null;

function fail(message) {
  throw new TypeError(`Invalid portable export: ${message}`);
}

function lexicalCompare(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function isCacheKey(key) {
  const lower = key.toLowerCase();
  return lower === 'cache' || lower.startsWith('cache') || lower.endsWith('cache') ||
    lower.includes('cached') || lower.startsWith('aidecryptedkey_');
}

function validateKey(key, path, forbidSensitive) {
  if (key.length > MAX_PORTABLE_STRING_LENGTH) {
    fail(`${path} contains a key above the ${MAX_PORTABLE_STRING_LENGTH.toLocaleString('en-US')} character limit`);
  }
  if (DANGEROUS_KEYS.has(key)) fail(`${path} contains a prototype-pollution key`);
  if (forbidSensitive && (FORBIDDEN_PORTABLE_KEYS.has(key) || isCacheKey(key))) {
    fail(`${path}.${key} is a forbidden secret or cache field`);
  }
}

function addBudget(budget, bytes) {
  budget.used += bytes;
  if (budget.used > MAX_PORTABLE_IMPORT_BYTES) {
    fail('document exceeds the 25 MiB cumulative in-memory budget');
  }
}

function addStringBudget(value, budget) {
  if (value.length > MAX_PORTABLE_STRING_LENGTH) {
    fail(`string exceeds the ${MAX_PORTABLE_STRING_LENGTH.toLocaleString('en-US')} character limit`);
  }
  addBudget(budget, textEncoder.encode(value).byteLength);
}

function ownKeys(value, path) {
  let keys;
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    fail(`${path} cannot be inspected safely`);
  }
  if (keys.some((key) => typeof key !== 'string')) fail(`${path} contains a symbol key`);
  return keys;
}

function ownDataValue(value, key, path, { required = false } = {}) {
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    fail(`${path}.${key} cannot be inspected safely`);
  }
  if (!descriptor) {
    if (required) fail(`${path} requires own ${key}`);
    return undefined;
  }
  if (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
    fail(`${path}.${key} must be an enumerable own data property`);
  }
  return descriptor.value;
}

function canonicalizeJsonValue(
  value,
  path,
  depth,
  ancestors,
  budget,
  forbidSensitive,
  sortKeys,
  allowAISecretsAtRoot,
  omitUndefinedObjectProperties,
) {
  if (depth > MAX_PORTABLE_NESTING_DEPTH) {
    fail(`${path} exceeds the nesting depth limit`);
  }

  if (value === null || typeof value === 'boolean') {
    addBudget(budget, 16);
    return value;
  }
  if (typeof value === 'string') {
    addBudget(budget, 16);
    addStringBudget(value, budget);
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(`${path} contains a non-finite number`);
    addBudget(budget, 16);
    return value;
  }
  if (typeof value !== 'object') fail(`${path} contains a non-JSON value`);
  if (ancestors.has(value)) fail(`${path} contains a cycle`);
  ancestors.add(value);

  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) fail(`${path} is not a JSON array`);
      if (value.length > MAX_PORTABLE_TOTAL_TABS) {
        fail(`${path} array exceeds the ${MAX_PORTABLE_TOTAL_TABS.toLocaleString('en-US')} traversal limit`);
      }
      const keys = ownKeys(value, path);
      const expected = new Set(['length']);
      for (let index = 0; index < value.length; index += 1) expected.add(String(index));
      if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) {
        fail(`${path} is sparse or contains non-JSON array properties`);
      }
      addBudget(budget, 16);
      const output = [];
      for (let index = 0; index < value.length; index += 1) {
        addBudget(budget, 16);
        const item = ownDataValue(value, String(index), path, { required: true });
        output.push(canonicalizeJsonValue(
          item,
          `${path}[${index}]`,
          depth + 1,
          ancestors,
          budget,
          forbidSensitive,
          sortKeys,
          allowAISecretsAtRoot,
          omitUndefinedObjectProperties,
        ));
      }
      return output;
    }

    if (!isPlainRecord(value)) fail(`${path} must be a plain object`);
    addBudget(budget, 16);
    const keys = ownKeys(value, path);
    if (keys.length > MAX_PORTABLE_TOTAL_TABS) {
      fail(`${path} object exceeds the ${MAX_PORTABLE_TOTAL_TABS.toLocaleString('en-US')} property traversal limit`);
    }
    if (sortKeys) keys.sort(lexicalCompare);
    const output = Object.create(null);
    for (const key of keys) {
      validateKey(key, path, forbidSensitive);
      const child = ownDataValue(value, key, path, { required: true });
      if (child === undefined && omitUndefinedObjectProperties) continue;
      addBudget(budget, 16);
      addStringBudget(key, budget);
      const childForbidsSensitive = forbidSensitive && !(
        allowAISecretsAtRoot && depth === 0 && key === 'aiSettings'
      );
      output[key] = canonicalizeJsonValue(
        child,
        `${path}.${key}`,
        depth + 1,
        ancestors,
        budget,
        childForbidsSensitive,
        sortKeys,
        allowAISecretsAtRoot,
        omitUndefinedObjectProperties,
      );
    }
    return output;
  } catch (error) {
    if (error instanceof TypeError && error.message.startsWith('Invalid portable export:')) throw error;
    fail(`${path} cannot be inspected safely`);
  } finally {
    ancestors.delete(value);
  }
}

function canonicalizeJson(value, {
  forbidSensitive = true,
  sortKeys = true,
  allowAISecretsAtRoot = false,
  omitUndefinedObjectProperties = false,
} = {}) {
  return canonicalizeJsonValue(
    value,
    'root',
    0,
    new Set(),
    { used: 0 },
    forbidSensitive,
    sortKeys,
    allowAISecretsAtRoot,
    omitUndefinedObjectProperties,
  );
}

function sortedNullMap(entries) {
  const output = Object.create(null);
  for (const [key, value] of [...entries].sort(([left], [right]) => lexicalCompare(left, right))) {
    output[key] = value;
  }
  return output;
}

function validateId(value, path) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PORTABLE_STRING_LENGTH) {
    fail(`${path} must be a non-empty bounded string ID`);
  }
  if (DANGEROUS_KEYS.has(value)) fail(`${path} is a prototype-pollution ID`);
  return value;
}

function validateTimestamp(value, path) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_DRIVE_TIMESTAMP) {
    fail(`${path} must be a non-negative safe-integer timestamp`);
  }
  return value;
}

function validateOptionalTimestamps(record, path) {
  for (const key of ['createdAt', 'modifiedAt', 'restoredAt', 'startedAt', 'endedAt']) {
    if (Object.hasOwn(record, key)) validateTimestamp(record[key], `${path}.${key}`);
  }
}

function validateTabArray(value, path) {
  if (!Array.isArray(value)) fail(`${path} must be an array`);
  for (let index = 0; index < value.length; index += 1) {
    const record = value[index];
    if (!isPlainRecord(record)) fail(`${path}[${index}] must be an object`);
    for (const key of ['url', 'title', 'favIconUrl', 'pendingUrl']) {
      if (Object.hasOwn(record, key) && typeof record[key] !== 'string') {
        fail(`${path}[${index}].${key} must be a string`);
      }
    }
  }
  return value.length;
}

function countWindowTabs(record, path) {
  let count = 0;
  if (Object.hasOwn(record, 'tabs')) count += validateTabArray(record.tabs, `${path}.tabs`);
  if (Object.hasOwn(record, 'windows')) {
    if (!Array.isArray(record.windows)) fail(`${path}.windows must be an array`);
    for (let index = 0; index < record.windows.length; index += 1) {
      const window = record.windows[index];
      if (!isPlainRecord(window)) fail(`${path}.windows[${index}] must be an object`);
      if (Object.hasOwn(window, 'tabCount') &&
          (!Number.isSafeInteger(window.tabCount) || window.tabCount < 0)) {
        fail(`${path}.windows[${index}].tabCount must be a non-negative integer`);
      }
      if (Object.hasOwn(window, 'tabs')) {
        count += validateTabArray(window.tabs, `${path}.windows[${index}].tabs`);
      }
    }
  }
  if (count > MAX_PORTABLE_TABS_PER_RECORD) {
    fail(`${path} exceeds the ${MAX_PORTABLE_TABS_PER_RECORD.toLocaleString('en-US')} tab limit`);
  }
  return count;
}

function validateSessionsCanonical(value) {
  if (!Array.isArray(value)) fail('sessions must be an array');
  if (value.length > MAX_PORTABLE_SECTION_RECORDS) {
    fail(`sessions exceed the ${MAX_PORTABLE_SECTION_RECORDS.toLocaleString('en-US')} record limit`);
  }
  const seen = new Set();
  const sessions = [];
  let totalTabs = 0;
  for (let index = 0; index < value.length; index += 1) {
    const record = value[index];
    if (!isPlainRecord(record)) fail(`sessions[${index}] must be an object`);
    if (!Object.hasOwn(record, 'id')) fail(`sessions[${index}] requires an own ID`);
    const id = validateId(record.id, `sessions[${index}].id`);
    if (seen.has(id)) fail(`sessions contain duplicate ID ${id}`);
    seen.add(id);
    validateOptionalTimestamps(record, `sessions[${index}]`);
    if (Object.hasOwn(record, 'version') &&
        (!Number.isSafeInteger(record.version) || record.version < 1)) {
      fail(`sessions[${index}].version must be a positive integer`);
    }
    totalTabs += countWindowTabs(record, `sessions[${index}]`);
    sessions.push(record);
  }
  sessions.sort((left, right) => lexicalCompare(left.id, right.id));
  return { value: sessions, totalTabs };
}

function validateStashesCanonical(value) {
  if (!Array.isArray(value)) fail('stashes must be an array');
  if (value.length > MAX_PORTABLE_SECTION_RECORDS) {
    fail(`stashes exceed the ${MAX_PORTABLE_SECTION_RECORDS.toLocaleString('en-US')} record limit`);
  }
  const seen = new Set();
  const stashes = [];
  let totalTabs = 0;
  for (let index = 0; index < value.length; index += 1) {
    const record = value[index];
    if (!isPlainRecord(record)) fail(`stashes[${index}] must be an object`);
    if (!Object.hasOwn(record, 'id')) fail(`stashes[${index}] requires an own ID`);
    const id = validateId(record.id, `stashes[${index}].id`);
    if (seen.has(id)) fail(`stashes contain duplicate ID ${id}`);
    seen.add(id);
    if (!Object.hasOwn(record, 'createdAt')) {
      fail(`stashes[${index}] requires an own createdAt for IndexedDB ordering`);
    }
    validateTimestamp(record.createdAt, `stashes[${index}].createdAt`);
    validateOptionalTimestamps(record, `stashes[${index}]`);
    totalTabs += countWindowTabs(record, `stashes[${index}]`);
    stashes.push(record);
  }
  if (totalTabs > MAX_PORTABLE_TOTAL_TABS) {
    fail(`stashes exceed the ${MAX_PORTABLE_TOTAL_TABS.toLocaleString('en-US')} total tab limit`);
  }
  stashes.sort((left, right) => lexicalCompare(left.id, right.id));
  return { value: stashes, totalTabs };
}

export function validateStashSection(value) {
  const internalContext = activeCanonicalStashValidation?.value === value
    ? activeCanonicalStashValidation
    : null;
  const canonical = internalContext ? value : canonicalizeJson(value);
  const result = validateStashesCanonical(canonical);
  if (internalContext) {
    internalContext.used = true;
    internalContext.totalTabs = result.totalTabs;
  }
  return result.value;
}

function validateManualGroupsCanonical(value) {
  if (!isPlainRecord(value)) fail('manualGroups must be a map');
  const keys = Object.keys(value);
  if (keys.length > MAX_PORTABLE_SECTION_RECORDS) {
    fail(`manualGroups exceed the ${MAX_PORTABLE_SECTION_RECORDS.toLocaleString('en-US')} record limit`);
  }
  const entries = [];
  let totalTabs = 0;
  for (const id of keys) {
    validateId(id, 'manualGroups key');
    const record = value[id];
    if (!isPlainRecord(record)) fail(`manualGroups.${id} must be an object`);
    validateOptionalTimestamps(record, `manualGroups.${id}`);
    if (Object.hasOwn(record, 'tabUrls')) {
      if (!Array.isArray(record.tabUrls)) fail(`manualGroups.${id}.tabUrls must be an array`);
      if (record.tabUrls.length > MAX_PORTABLE_TABS_PER_RECORD) {
        fail(`manualGroups.${id} exceeds the ${MAX_PORTABLE_TABS_PER_RECORD.toLocaleString('en-US')} URL limit`);
      }
      for (const url of record.tabUrls) {
        if (typeof url !== 'string') fail(`manualGroups.${id}.tabUrls must contain strings`);
      }
      totalTabs += record.tabUrls.length;
    }
    entries.push([id, record]);
  }
  return { value: sortedNullMap(entries), totalTabs };
}

function validateKeepAwakeCanonical(value) {
  if (!Array.isArray(value)) fail('keepAwakeDomains must be an array');
  if (value.length > MAX_PORTABLE_SECTION_RECORDS) {
    fail(`keepAwakeDomains exceed the ${MAX_PORTABLE_SECTION_RECORDS.toLocaleString('en-US')} record limit`);
  }
  const domains = new Set();
  for (const domain of value) {
    if (typeof domain !== 'string' || domain.length === 0) {
      fail('keepAwakeDomains must contain non-empty strings');
    }
    domains.add(domain);
  }
  return [...domains].sort(lexicalCompare);
}

function bookmarkIdentity(record, path) {
  if (Object.hasOwn(record, 'id')) return `id:${validateId(record.id, `${path}.id`)}`;
  for (const key of ['createdAt', 'date', 'time']) {
    if (!Object.hasOwn(record, key)) fail(`${path} legacy bookmark requires ${key}`);
  }
  validateTimestamp(record.createdAt, `${path}.createdAt`);
  if (typeof record.date !== 'string' || record.date.length === 0 ||
      typeof record.time !== 'string' || record.time.length === 0) {
    fail(`${path} legacy bookmark date/time must be non-empty strings`);
  }
  return `legacy:${record.createdAt}:${record.date.length}:${record.date}:${record.time.length}:${record.time}`;
}

function countBookmarkTabs(record, path) {
  if (!Object.hasOwn(record, 'formats')) return 0;
  if (!isPlainRecord(record.formats)) fail(`${path}.formats must be an object`);
  let count = 0;
  for (const [format, groups] of Object.entries(record.formats)) {
    if (!Array.isArray(groups)) fail(`${path}.formats.${format} must be an array`);
    for (let index = 0; index < groups.length; index += 1) {
      const group = groups[index];
      if (!isPlainRecord(group)) fail(`${path}.formats.${format}[${index}] must be an object`);
      if (Object.hasOwn(group, 'tabs')) {
        count += validateTabArray(group.tabs, `${path}.formats.${format}[${index}].tabs`);
      }
    }
  }
  if (count > MAX_PORTABLE_TABS_PER_RECORD) {
    fail(`${path} exceeds the ${MAX_PORTABLE_TABS_PER_RECORD.toLocaleString('en-US')} tab limit`);
  }
  return count;
}

function validateBookmarksCanonical(value) {
  if (!Array.isArray(value)) fail('bookmarks must be an array');
  if (value.length > MAX_PORTABLE_SECTION_RECORDS) {
    fail(`bookmarks exceed the ${MAX_PORTABLE_SECTION_RECORDS.toLocaleString('en-US')} record limit`);
  }
  const identities = new Set();
  const records = [];
  let totalTabs = 0;
  for (let index = 0; index < value.length; index += 1) {
    const record = value[index];
    if (!isPlainRecord(record)) fail(`bookmarks[${index}] must be an object`);
    validateOptionalTimestamps(record, `bookmarks[${index}]`);
    const identity = bookmarkIdentity(record, `bookmarks[${index}]`);
    if (identities.has(identity)) fail(`bookmarks contain duplicate identity ${identity}`);
    identities.add(identity);
    totalTabs += countBookmarkTabs(record, `bookmarks[${index}]`);
    records.push({ identity, record });
  }
  records.sort((left, right) => lexicalCompare(left.identity, right.identity));
  return { value: records.map(({ record }) => record), totalTabs };
}

function validateSettingValue(key, value) {
  const constraint = SETTINGS_CONSTRAINTS[key];
  if (constraint.type === 'boolean') {
    if (typeof value !== 'boolean') fail(`settings.${key} must be a boolean`);
    return;
  }
  if (constraint.type === 'integer') {
    if (!Number.isInteger(value) || value < constraint.min || value > constraint.max) {
      fail(`settings.${key} must be an integer from ${constraint.min} to ${constraint.max}`);
    }
    return;
  }
  if (constraint.enum && !constraint.enum.includes(value)) {
    fail(`settings.${key} must be one of ${constraint.enum.join(', ')}`);
  }
}

function validateSettingsCanonical(value) {
  if (!isPlainRecord(value)) fail('settings must be an object');
  const allowed = new Set(PORTABLE_SETTINGS_KEYS);
  const entries = [];
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`settings contain unknown key ${key}`);
    validateSettingValue(key, value[key]);
    entries.push([key, value[key]]);
  }
  return sortedNullMap(entries);
}

function assertSettingsRelationship(value) {
  const maxTabs = Object.hasOwn(value, 'maxTabsPerWindow')
    ? value.maxTabsPerWindow
    : SETTINGS_DEFAULTS.maxTabsPerWindow;
  const recommended = Object.hasOwn(value, 'recommendedTabsPerWindow')
    ? value.recommendedTabsPerWindow
    : SETTINGS_DEFAULTS.recommendedTabsPerWindow;
  if (recommended > maxTabs) fail('recommendedTabsPerWindow cannot exceed maxTabsPerWindow');
}

function validateFocusPrefsCanonical(value) {
  if (!isPlainRecord(value)) fail('focusProfilePrefs must be a map');
  const keys = Object.keys(value);
  if (keys.length > MAX_PORTABLE_SECTION_RECORDS) {
    fail(`focusProfilePrefs exceed the ${MAX_PORTABLE_SECTION_RECORDS.toLocaleString('en-US')} record limit`);
  }
  const entries = [];
  for (const id of keys) {
    validateId(id, 'focusProfilePrefs key');
    if (!isPlainRecord(value[id])) fail(`focusProfilePrefs.${id} must be an object`);
    entries.push([id, value[id]]);
  }
  return sortedNullMap(entries);
}

function focusHistoryIdentity(record, path) {
  if (Object.hasOwn(record, 'runId')) {
    return `run:${validateId(record.runId, `${path}.runId`)}`;
  }
  if (Object.hasOwn(record, 'id')) {
    return `id:${validateId(record.id, `${path}.id`)}`;
  }
  fail(`${path} requires an own runId or legacy ID`);
}

function validateFocusHistoryCanonical(value) {
  if (!Array.isArray(value)) fail('focusHistory must be an array');
  if (value.length > MAX_PORTABLE_SECTION_RECORDS) {
    fail(`focusHistory exceeds the ${MAX_PORTABLE_SECTION_RECORDS.toLocaleString('en-US')} record limit`);
  }
  const seen = new Set();
  const records = [];
  for (let index = 0; index < value.length; index += 1) {
    const record = value[index];
    if (!isPlainRecord(record)) fail(`focusHistory[${index}] must be an object`);
    const identity = focusHistoryIdentity(record, `focusHistory[${index}]`);
    if (seen.has(identity)) fail(`focusHistory contains duplicate identity ${identity}`);
    seen.add(identity);
    validateOptionalTimestamps(record, `focusHistory[${index}]`);
    records.push({ identity, record });
  }
  records.sort((left, right) => lexicalCompare(left.identity, right.identity));
  return records.map(({ record }) => record);
}

function assertOnlyKeys(value, allowed, path) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${path} contains unknown field ${key}`);
  }
}

function validateAISettingsCanonical(value) {
  if (!isPlainRecord(value)) fail('aiSettings must be an object');
  const rootKeys = new Set(['enabled', 'providerId', 'providerConfigs']);
  assertOnlyKeys(value, rootKeys, 'aiSettings');
  for (const key of rootKeys) {
    if (!Object.hasOwn(value, key)) fail(`aiSettings requires own ${key}`);
  }
  if (typeof value.enabled !== 'boolean') fail('aiSettings.enabled must be a boolean');
  if (value.providerId !== null && !PROVIDER_ID_SET.has(value.providerId)) {
    fail('aiSettings.providerId is invalid');
  }
  if (!isPlainRecord(value.providerConfigs)) fail('aiSettings.providerConfigs must be a map');
  const configEntries = [];
  for (const providerId of Object.keys(value.providerConfigs)) {
    if (!PROVIDER_ID_SET.has(providerId)) fail(`aiSettings contains unknown provider ${providerId}`);
    const config = value.providerConfigs[providerId];
    if (!isPlainRecord(config)) fail(`aiSettings.providerConfigs.${providerId} must be an object`);
    const allowed = new Set(providerId === 'custom' ? ['model', 'baseUrl'] : ['model']);
    assertOnlyKeys(config, allowed, `aiSettings.providerConfigs.${providerId}`);
    const entries = [];
    if (Object.hasOwn(config, 'model')) {
      if (typeof config.model !== 'string' || config.model.length === 0) {
        fail(`aiSettings.providerConfigs.${providerId}.model must be a non-empty string`);
      }
      entries.push(['model', config.model]);
    }
    if (Object.hasOwn(config, 'baseUrl')) {
      if (providerId !== 'custom' || typeof config.baseUrl !== 'string' || config.baseUrl.length === 0) {
        fail(`aiSettings.providerConfigs.${providerId}.baseUrl is invalid`);
      }
      entries.push(['baseUrl', config.baseUrl]);
    }
    configEntries.push([providerId, sortedNullMap(entries)]);
  }
  const output = Object.create(null);
  output.enabled = value.enabled;
  output.providerId = value.providerId;
  output.providerConfigs = sortedNullMap(configEntries);
  return output;
}

function boundedOwnString(record, key) {
  if (!isPlainRecord(record)) return null;
  const value = ownDataValue(record, key, 'aiSettings');
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_PORTABLE_STRING_LENGTH
    ? value
    : null;
}

export function sanitizeAISettings(aiSettings) {
  const source = isPlainRecord(aiSettings) ? aiSettings : Object.create(null);
  const enabled = ownDataValue(source, 'enabled', 'aiSettings') === true;
  const rawProviderId = ownDataValue(source, 'providerId', 'aiSettings');
  const providerId = PROVIDER_ID_SET.has(rawProviderId) ? rawProviderId : null;
  const rawConfigs = ownDataValue(source, 'providerConfigs', 'aiSettings');
  const configs = isPlainRecord(rawConfigs) ? rawConfigs : Object.create(null);
  const configEntries = [];
  for (const id of PROVIDER_IDS) {
    const config = ownDataValue(configs, id, 'aiSettings.providerConfigs');
    if (!isPlainRecord(config)) continue;
    const entries = [];
    const model = boundedOwnString(config, 'model');
    if (model !== null) entries.push(['model', model]);
    if (id === 'custom') {
      const baseUrl = boundedOwnString(config, 'baseUrl');
      if (baseUrl !== null) entries.push(['baseUrl', baseUrl]);
    }
    if (entries.length > 0) configEntries.push([id, sortedNullMap(entries)]);
  }
  const output = Object.create(null);
  output.enabled = enabled;
  output.providerId = providerId;
  output.providerConfigs = sortedNullMap(configEntries);
  return output;
}

function validateSectionsCanonical(input, { allowAISecrets = false } = {}) {
  if (!isPlainRecord(input)) fail('sections must be an object');
  const allowed = new Set(SECTION_ORDER);
  assertOnlyKeys(input, allowed, 'sections');
  const sections = Object.create(null);
  let totalTabs = 0;
  for (const section of SECTION_ORDER) {
    if (!Object.hasOwn(input, section)) continue;
    switch (section) {
      case 'sessions': {
        const result = validateSessionsCanonical(input.sessions);
        sections.sessions = result.value;
        totalTabs += result.totalTabs;
        break;
      }
      case 'stashes': {
        const previousContext = activeCanonicalStashValidation;
        const context = { value: input.stashes, used: false, totalTabs: null };
        activeCanonicalStashValidation = context;
        try {
          sections.stashes = validateStashSection(input.stashes);
        } finally {
          activeCanonicalStashValidation = previousContext;
        }
        if (!context.used || !Number.isSafeInteger(context.totalTabs)) {
          fail('stashes did not produce a bounded tab count');
        }
        totalTabs += context.totalTabs;
        break;
      }
      case 'manualGroups': {
        const result = validateManualGroupsCanonical(input.manualGroups);
        sections.manualGroups = result.value;
        totalTabs += result.totalTabs;
        break;
      }
      case 'keepAwakeDomains':
        sections.keepAwakeDomains = validateKeepAwakeCanonical(input.keepAwakeDomains);
        break;
      case 'bookmarks': {
        const result = validateBookmarksCanonical(input.bookmarks);
        sections.bookmarks = result.value;
        totalTabs += result.totalTabs;
        break;
      }
      case 'settings':
        sections.settings = validateSettingsCanonical(input.settings);
        assertSettingsRelationship(sections.settings);
        break;
      case 'focusProfilePrefs':
        sections.focusProfilePrefs = validateFocusPrefsCanonical(input.focusProfilePrefs);
        break;
      case 'focusHistory':
        sections.focusHistory = validateFocusHistoryCanonical(input.focusHistory);
        break;
      case 'aiSettings':
        if (allowAISecrets) {
          if (!isPlainRecord(input.aiSettings)) fail('aiSettings must be an object');
          sections.aiSettings = input.aiSettings;
        } else {
          sections.aiSettings = validateAISettingsCanonical(input.aiSettings);
        }
        break;
    }
    if (totalTabs > MAX_PORTABLE_TOTAL_TABS) {
      fail(`document exceeds the ${MAX_PORTABLE_TOTAL_TABS.toLocaleString('en-US')} total tab limit`);
    }
  }
  return sections;
}

function validateExportedAt(value) {
  if (typeof value !== 'string' || value.length === 0) fail('exportedAt must be an ISO timestamp');
  let canonical;
  try {
    canonical = new Date(value).toISOString();
  } catch {
    fail('exportedAt must be an ISO timestamp');
  }
  if (canonical !== value) fail('exportedAt must be a canonical ISO timestamp');
  return value;
}

function normalizeLegacyExportedAt(value, path = 'exportedAt') {
  if (typeof value === 'string') return validateExportedAt(value);
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_DRIVE_TIMESTAMP) {
    fail(`${path} must be a canonical ISO string or non-negative safe-integer timestamp`);
  }
  try {
    return new Date(value).toISOString();
  } catch {
    fail(`${path} is outside the representable date range`);
  }
}

function buildDocument(kind, exportedAt, sections) {
  const output = Object.create(null);
  output.version = PORTABLE_EXPORT_VERSION;
  output.kind = kind;
  output.exportedAt = exportedAt;
  for (const section of KIND_SECTIONS[kind]) output[section] = sections[section];
  return output;
}

function parseV2(root) {
  if (!Object.hasOwn(root, 'kind') || !Object.hasOwn(KIND_SECTIONS, root.kind)) {
    fail('kind must be full, sessions, stashes, or settings');
  }
  if (!Object.hasOwn(root, 'exportedAt')) fail('version 2 requires exportedAt');
  const requiredSections = KIND_SECTIONS[root.kind];
  const allowed = new Set(['version', 'kind', 'exportedAt', ...requiredSections]);
  assertOnlyKeys(root, allowed, 'root');
  for (const section of requiredSections) {
    if (!Object.hasOwn(root, section)) fail(`${root.kind} export requires ${section}`);
  }
  const rawSections = Object.create(null);
  for (const section of requiredSections) rawSections[section] = root[section];
  const sections = validateSectionsCanonical(rawSections);
  return buildDocument(root.kind, validateExportedAt(root.exportedAt), sections);
}

function emptyFullSections() {
  const sections = Object.create(null);
  sections.sessions = [];
  sections.stashes = [];
  sections.manualGroups = Object.create(null);
  sections.keepAwakeDomains = [];
  sections.bookmarks = [];
  sections.settings = Object.create(null);
  sections.focusProfilePrefs = Object.create(null);
  sections.focusHistory = [];
  sections.aiSettings = sanitizeAISettings(null);
  return sections;
}

function parseV1(root) {
  const keys = new Set(Object.keys(root));
  const exact = (expected) => keys.size === expected.length && expected.every((key) => keys.has(key));
  let kind;
  let rawSections;
  let exportedAt;
  if (exact(['version', 'exportedAt', 'sessions', 'manualGroups', 'keepAwakeDomains', 'stashes'])) {
    kind = 'full';
    exportedAt = normalizeLegacyExportedAt(root.exportedAt);
    rawSections = emptyFullSections();
    for (const section of ['sessions', 'stashes', 'manualGroups', 'keepAwakeDomains']) {
      rawSections[section] = root[section];
    }
  } else if (exact(['version', 'exportedAt', 'sessions'])) {
    kind = 'sessions';
    exportedAt = normalizeLegacyExportedAt(root.exportedAt);
    rawSections = Object.assign(Object.create(null), { sessions: root.sessions });
  } else if (exact(['version', 'exportedAt', 'stashes'])) {
    kind = 'stashes';
    exportedAt = normalizeLegacyExportedAt(root.exportedAt);
    rawSections = Object.assign(Object.create(null), { stashes: root.stashes });
  } else if (exact(['version', 'exportedAt', 'settings'])) {
    kind = 'settings';
    exportedAt = normalizeLegacyExportedAt(root.exportedAt);
    rawSections = Object.assign(Object.create(null), { settings: root.settings });
  } else if (exact(['version', 'savedAt', 'settings'])) {
    kind = 'settings';
    exportedAt = normalizeLegacyExportedAt(root.savedAt, 'savedAt');
    rawSections = Object.assign(Object.create(null), { settings: root.settings });
  } else {
    fail('version 1 document does not match a supported full or partial export');
  }
  const sections = validateSectionsCanonical(rawSections);
  return buildDocument(kind, exportedAt, sections);
}

function parseUnversionedLegacy(root) {
  const keys = new Set(Object.keys(root));
  const exact = (expected) => keys.size === expected.length && expected.every((key) => keys.has(key));
  let kind;
  let section;
  let exportedAt;
  if (exact(['exportedAt', 'sessions'])) {
    kind = 'sessions';
    section = 'sessions';
    exportedAt = normalizeLegacyExportedAt(root.exportedAt);
  } else if (exact(['exportedAt', 'stashes'])) {
    kind = 'stashes';
    section = 'stashes';
    exportedAt = normalizeLegacyExportedAt(root.exportedAt);
  } else if (exact(['savedAt', 'settings'])) {
    kind = 'settings';
    section = 'settings';
    exportedAt = normalizeLegacyExportedAt(root.savedAt, 'savedAt');
  } else {
    fail('unversioned document does not match a supported legacy Drive backup');
  }
  const rawSections = Object.assign(Object.create(null), { [section]: root[section] });
  return buildDocument(kind, exportedAt, validateSectionsCanonical(rawSections));
}

function parseCanonicalPortableRoot(root) {
  if (!isPlainRecord(root)) fail('root must be an object');
  if (!Object.hasOwn(root, 'version')) return parseUnversionedLegacy(root);
  if (root.version === PORTABLE_EXPORT_VERSION) return parseV2(root);
  if (root.version === 1) return parseV1(root);
  fail(`unsupported version ${String(root.version)}`);
}

export function parsePortableExportDocument(value) {
  return parseCanonicalPortableRoot(canonicalizeJson(value));
}

function rawSectionValues(kind, sections) {
  if (!Object.hasOwn(KIND_SECTIONS, kind)) fail('kind must be full, sessions, stashes, or settings');
  if (!isPlainRecord(sections)) fail('sections must be an object');
  const expected = KIND_SECTIONS[kind];
  const keys = ownKeys(sections, 'sections');
  if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) {
    fail(`${kind} export requires exactly its named sections`);
  }
  const output = Object.create(null);
  for (const section of expected) {
    const value = ownDataValue(sections, section, 'sections', { required: true });
    output[section] = section === 'aiSettings' ? sanitizeAISettings(value) : value;
  }
  return output;
}

export function createPortableExportDocument(kind, sections, exportedAt) {
  const raw = Object.create(null);
  raw.version = PORTABLE_EXPORT_VERSION;
  raw.kind = kind;
  raw.exportedAt = exportedAt;
  Object.assign(raw, rawSectionValues(kind, sections));
  return parseCanonicalPortableRoot(canonicalizeJson(raw, {
    omitUndefinedObjectProperties: true,
  }));
}

function normalizeSectionBundle(value, {
  allowAISecrets = false,
  sortKeys = true,
  omitUndefinedObjectProperties = false,
} = {}) {
  const canonical = canonicalizeJson(value, {
    allowAISecretsAtRoot: allowAISecrets,
    sortKeys,
    omitUndefinedObjectProperties,
  });
  return validateSectionsCanonical(canonical, { allowAISecrets });
}

function normalizeTombstones(value) {
  const canonical = canonicalizeJson(value, { forbidSensitive: false });
  if (!isPlainRecord(canonical)) fail('tombstones must be an object');
  assertOnlyKeys(canonical, new Set(['sessions', 'manualGroups']), 'tombstones');
  const output = { sessions: Object.create(null), manualGroups: Object.create(null) };
  for (const kind of ['sessions', 'manualGroups']) {
    const source = Object.hasOwn(canonical, kind) ? canonical[kind] : Object.create(null);
    if (!isPlainRecord(source)) fail(`tombstones.${kind} must be a map`);
    if (Object.keys(source).length > MAX_DRIVE_TOMBSTONES_PER_KIND) {
      fail(`tombstones.${kind} exceed the ${MAX_DRIVE_TOMBSTONES_PER_KIND.toLocaleString('en-US')} tombstone limit`);
    }
    const entries = [];
    for (const [id, timestamp] of Object.entries(source)) {
      validateId(id, `tombstones.${kind} key`);
      if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > MAX_DRIVE_TOMBSTONE) {
        fail(`tombstones.${kind}.${id} is invalid`);
      }
      entries.push([id, timestamp]);
    }
    output[kind] = sortedNullMap(entries);
  }
  return output;
}

function mergeRecordArrays(local, incoming, identity) {
  const merged = new Map();
  for (const record of incoming || []) merged.set(identity(record), record);
  for (const record of local || []) merged.set(identity(record), record);
  return [...merged.entries()]
    .sort(([left], [right]) => lexicalCompare(left, right))
    .map(([, record]) => record);
}

function mergeMaps(local, incoming) {
  const merged = new Map(Object.entries(incoming || {}));
  for (const entry of Object.entries(local || {})) merged.set(...entry);
  return sortedNullMap(merged.entries());
}

function entityTimestamp(entity) {
  if (Number.isSafeInteger(entity?.modifiedAt) && entity.modifiedAt >= 0) return entity.modifiedAt;
  if (Number.isSafeInteger(entity?.createdAt) && entity.createdAt >= 0) return entity.createdAt;
  return 0;
}

function reviveImportedSessions(local, incoming, tombstones, now) {
  const localIds = new Set((local || []).map((record) => record.id));
  return (incoming || []).map((record) => {
    if (localIds.has(record.id) || !Object.hasOwn(tombstones, record.id)) return record;
    const revived = Object.assign(Object.create(null), record);
    revived.modifiedAt = Math.max(entityTimestamp(record), tombstones[record.id] + 1, now);
    return revived;
  });
}

function reviveImportedGroups(local, incoming, tombstones, now) {
  const entries = [];
  for (const [id, record] of Object.entries(incoming || {})) {
    if (Object.hasOwn(local || {}, id) || !Object.hasOwn(tombstones, id)) {
      entries.push([id, record]);
      continue;
    }
    const revived = Object.assign(Object.create(null), record);
    revived.modifiedAt = Math.max(entityTimestamp(record), tombstones[id] + 1, now);
    entries.push([id, revived]);
  }
  return sortedNullMap(entries);
}

function mergeSettings(local, incoming) {
  const merged = new Map(Object.entries(local || {}));
  for (const [key, value] of Object.entries(incoming || {})) merged.set(key, value);
  const result = validateSettingsCanonical(sortedNullMap(merged.entries()));
  assertSettingsRelationship(result);
  return result;
}

function mergeAISettings(local, incoming) {
  if (!incoming) return local;
  const base = isPlainRecord(local) ? local : Object.create(null);
  const output = Object.assign(Object.create(null), base);
  output.enabled = incoming.enabled;
  output.providerId = incoming.providerId;
  const localConfigs = isPlainRecord(base.providerConfigs) ? base.providerConfigs : Object.create(null);
  const mergedConfigs = new Map(Object.entries(localConfigs));
  for (const [providerId, importedConfig] of Object.entries(incoming.providerConfigs)) {
    const current = isPlainRecord(localConfigs[providerId])
      ? Object.assign(Object.create(null), localConfigs[providerId])
      : Object.create(null);
    if (Object.hasOwn(importedConfig, 'model')) current.model = importedConfig.model;
    if (providerId === 'custom' && Object.hasOwn(importedConfig, 'baseUrl')) {
      current.baseUrl = importedConfig.baseUrl;
    }
    mergedConfigs.set(providerId, current);
  }
  output.providerConfigs = sortedNullMap(mergedConfigs.entries());
  return canonicalizeJson(output, { forbidSensitive: false, sortKeys: false });
}

export function mergePortableSections(existing, incoming, { tombstones, now }) {
  if (!Number.isSafeInteger(now) || now < 0 || now > MAX_DRIVE_TIMESTAMP) {
    fail('merge now must be a non-negative safe-integer timestamp');
  }
  const local = normalizeSectionBundle(existing, {
    allowAISecrets: true,
    omitUndefinedObjectProperties: true,
  });
  const preservedLocalAI = Object.hasOwn(local, 'aiSettings')
    ? canonicalizeJson(ownDataValue(existing, 'aiSettings', 'sections', { required: true }), {
      forbidSensitive: false,
      sortKeys: false,
      omitUndefinedObjectProperties: true,
    })
    : undefined;
  const imported = normalizeSectionBundle(incoming);
  const canonicalTombstones = normalizeTombstones(tombstones);
  const sections = Object.create(null);

  for (const section of SECTION_ORDER) {
    const hasLocal = Object.hasOwn(local, section);
    const hasIncoming = Object.hasOwn(imported, section);
    if (!hasLocal && !hasIncoming) continue;
    switch (section) {
      case 'sessions': {
        const revived = reviveImportedSessions(
          local.sessions || [],
          imported.sessions || [],
          canonicalTombstones.sessions,
          now,
        );
        sections.sessions = mergeRecordArrays(local.sessions, revived, (record) => record.id);
        break;
      }
      case 'stashes':
        sections.stashes = mergeRecordArrays(local.stashes, imported.stashes, (record) => record.id);
        break;
      case 'manualGroups': {
        const revived = reviveImportedGroups(
          local.manualGroups || Object.create(null),
          imported.manualGroups || Object.create(null),
          canonicalTombstones.manualGroups,
          now,
        );
        sections.manualGroups = mergeMaps(local.manualGroups, revived);
        break;
      }
      case 'keepAwakeDomains':
        sections.keepAwakeDomains = [...new Set([
          ...(local.keepAwakeDomains || []),
          ...(imported.keepAwakeDomains || []),
        ])].sort(lexicalCompare);
        break;
      case 'bookmarks':
        sections.bookmarks = mergeRecordArrays(
          local.bookmarks,
          imported.bookmarks,
          (record) => bookmarkIdentity(record, 'bookmarks merge record'),
        );
        break;
      case 'settings':
        sections.settings = mergeSettings(local.settings, imported.settings);
        break;
      case 'focusProfilePrefs':
        sections.focusProfilePrefs = mergeMaps(local.focusProfilePrefs, imported.focusProfilePrefs);
        break;
      case 'focusHistory':
        sections.focusHistory = mergeRecordArrays(
          local.focusHistory,
          imported.focusHistory,
          (record) => focusHistoryIdentity(record, 'focusHistory merge record'),
        );
        break;
      case 'aiSettings':
        sections.aiSettings = mergeAISettings(preservedLocalAI, imported.aiSettings);
        break;
    }
  }

  return normalizeSectionBundle(sections, { allowAISecrets: true, sortKeys: false });
}
