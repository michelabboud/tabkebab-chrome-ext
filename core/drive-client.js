// core/drive-client.js — Google Drive REST v3 client (visible TabKebab folder)

import { isValidDriveFileId } from './drive-retention.js';
import { MAX_DRIVE_JSON_BYTES } from './drive-sync.js';
import { parseDriveSettingsDocument } from './settings.js';
import { createLogger } from './log.js';
const log = createLogger('drive');

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_NAME = 'TabKebab';
const SYNC_FILENAME = 'tabkebab-sync.json';
const SETTINGS_FILENAME = 'tabkebab-settings.json';

// Subfolder names under the profile folder
const SUBFOLDER_SESSIONS = 'sessions';
const SUBFOLDER_STASHES = 'stashes';
const SUBFOLDER_BOOKMARKS = 'bookmarks';
const SUBFOLDER_ARCHIVE = 'archive';

// ── Profile scoping ──────────────────────────────────

const DRIVE_PROFILE_NAME = /^[A-Za-z0-9 _-]+$/;

function validateProfileName(profileName) {
  if (
    typeof profileName !== 'string' ||
    profileName.length < 1 ||
    profileName.length > 50 ||
    profileName !== profileName.trim() ||
    !DRIVE_PROFILE_NAME.test(profileName)
  ) {
    throw new Error('Drive profile name is missing or invalid');
  }
  return profileName;
}

async function getProfileName() {
  const data = await chrome.storage.local.get('driveProfileName');
  return validateProfileName(data.driveProfileName);
}

function requireDriveFileId(fileId, context = 'Drive file') {
  if (!isValidDriveFileId(fileId)) throw new Error(`${context} has an invalid ID`);
  return fileId;
}

function encodedDriveFileId(fileId, context) {
  return encodeURIComponent(requireDriveFileId(fileId, context));
}

function validateListedFile(file) {
  if (!file || typeof file !== 'object' || Array.isArray(file)) {
    throw new Error('Drive file listing returned an invalid entry');
  }
  requireDriveFileId(file.id);
  if (typeof file.name !== 'string' || file.name.length === 0) {
    throw new Error(`Drive file ${file.id} has an invalid name`);
  }
  return file;
}

/**
 * Get the profile-scoped root folder: TabKebab/{profileName}/
 * All file operations use this instead of the bare TabKebab/ folder.
 */
async function getProfileFolderId() {
  const name = await getProfileName();
  if (!name) throw new Error('Drive profile not configured');
  const rootId = await getOrCreateFolder();
  return getOrCreateSubfolder(rootId, name);
}

// ── Auth ──────────────────────────────────────────────

async function getToken(interactive = false) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (typeof token !== 'string' || token.trim().length === 0) {
        reject(new Error('Drive authentication token is unavailable'));
      } else {
        resolve(token);
      }
    });
  });
}

// Longest server-requested backoff we will honour while holding the state
// mutation lock. Anything longer fails the request instead of sleeping.
export const MAX_DRIVE_RETRY_AFTER_MS = 60_000;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503]);
const MAX_RETRIES = 3;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parse a Retry-After header (RFC 9110: delta-seconds or HTTP-date) into a
 * delay in milliseconds. Returns null when absent or unparseable.
 */
export function parseRetryAfterMs(value, nowMs = Date.now()) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isSafeInteger(seconds) ? seconds * 1000 : Number.POSITIVE_INFINITY;
  }
  // HTTP-date always names a weekday/month; reject bare numbers like "-3"
  // that Date.parse would otherwise read as a year.
  if (!/[A-Za-z]{3}/.test(trimmed)) return null;
  const dateMs = Date.parse(trimmed);
  if (!Number.isFinite(dateMs)) return null;
  return Math.max(0, dateMs - nowMs);
}

function retryDelayMs(resp, attempt) {
  const requested = parseRetryAfterMs(resp.headers?.get?.('Retry-After') ?? null);
  if (requested === null) return 1000 * Math.pow(2, attempt);
  if (requested > MAX_DRIVE_RETRY_AFTER_MS) return null;
  return requested;
}

function driveError(status, extra = '') {
  const error = new Error(`Drive API error: ${status}${extra}`);
  error.status = status;
  return error;
}

/**
 * Perform one authenticated Drive request with bounded retries.
 *
 * 429 is retried for every method (the request was rejected before being
 * processed). 5xx is retried only for idempotent methods: a POST create may
 * have succeeded server-side, so blind retries would create duplicates. Such
 * failures surface as an error with `createMayHaveSucceeded` set so the
 * caller can re-look-up before retrying (see createOrRecover). Callers whose
 * POST is harmless to repeat pass `retryUnsafe: true`.
 */
async function driveRequest(url, options = {}, interactive = false) {
  const { retryUnsafe = false, ...fetchOptions } = options;
  const method = String(fetchOptions.method || 'GET').toUpperCase();
  const idempotent = method !== 'POST' || retryUnsafe;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let token = await getToken(interactive);

    let resp = await fetch(url, {
      ...fetchOptions,
      headers: {
        'Authorization': `Bearer ${token}`,
        ...(fetchOptions.headers || {})
      }
    });

    // Re-auth on 401
    if (resp.status === 401) {
      await chrome.identity.removeCachedAuthToken({ token });
      token = await getToken(interactive);
      resp = await fetch(url, {
        ...fetchOptions,
        headers: {
          'Authorization': `Bearer ${token}`,
          ...(fetchOptions.headers || {})
        }
      });
    }

    if (resp.ok) return resp;

    if (RETRYABLE_STATUSES.has(resp.status)) {
      const delayMs = retryDelayMs(resp, attempt);
      if (delayMs === null) {
        const error = driveError(resp.status, ' (Retry-After exceeds the 60s limit)');
        if (resp.status !== 429 && !idempotent) {
          // The create may still have been applied: let the caller look it
          // up, but never retry it (retryDelayMs null) before Retry-After.
          error.createMayHaveSucceeded = true;
          error.retryDelayMs = null;
        }
        throw error;
      }
      if (resp.status !== 429 && !idempotent) {
        const error = driveError(resp.status);
        error.createMayHaveSucceeded = true;
        error.retryDelayMs = delayMs;
        throw error;
      }
      if (attempt < MAX_RETRIES) {
        log.warn(`Drive API ${resp.status}, retry ${attempt + 1}/${MAX_RETRIES} in ${delayMs}ms`);
        await sleep(delayMs);
        continue;
      }
    }

    throw driveError(resp.status);
  }
}

/**
 * Run a non-idempotent create. When it fails in a way that may have created
 * the resource anyway, look it up first and only retry when it is absent.
 * Returns { file, recovered } where `recovered` means the lookup found it.
 */
async function createOrRecover(lookup, create) {
  for (let attempt = 0; ; attempt++) {
    try {
      return { file: await create(), recovered: false };
    } catch (error) {
      if (!error?.createMayHaveSucceeded || attempt >= MAX_RETRIES) throw error;
      const existing = await lookup();
      if (existing) return { file: existing, recovered: true };
      if (error.retryDelayMs === null) throw error;
      log.warn(`Drive create failed (${error.status}), retry ${attempt + 1}/${MAX_RETRIES}`);
      await sleep(error.retryDelayMs ?? 0);
    }
  }
}

function createdTimeOrder(file) {
  const parsed = typeof file.createdTime === 'string' ? Date.parse(file.createdTime) : NaN;
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

/**
 * Deterministic choice among duplicates: oldest createdTime (missing or
 * invalid sorts last), then lowest ID. Every device resolves the same
 * duplicate set to the same file.
 */
function pickCanonicalDuplicate(files) {
  return [...files].sort((left, right) => {
    const leftCreated = createdTimeOrder(left);
    const rightCreated = createdTimeOrder(right);
    if (leftCreated !== rightCreated) return leftCreated < rightCreated ? -1 : 1;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  })[0];
}

/**
 * List every page of a Drive files query, validating each entry.
 */
async function listAllMatches(query, fields, context, { orderBy = null } = {}) {
  const files = [];
  const seenPageTokens = new Set();
  let pageToken = null;

  while (true) {
    const url = new URL(`${DRIVE_API}/files`);
    url.searchParams.set('q', query);
    url.searchParams.set('fields', `nextPageToken,files(${fields})`);
    if (orderBy) url.searchParams.set('orderBy', orderBy);
    url.searchParams.set('spaces', 'drive');
    if (pageToken !== null) url.searchParams.set('pageToken', pageToken);

    const resp = await driveRequest(url.toString());
    const data = await resp.json();
    if (!data || typeof data !== 'object' || !Array.isArray(data.files)) {
      throw new Error(`${context} returned an invalid page`);
    }
    files.push(...data.files.map(validateListedFile));

    if (data.nextPageToken === undefined || data.nextPageToken === null) break;
    if (typeof data.nextPageToken !== 'string' || data.nextPageToken.length === 0) {
      throw new Error(`${context} returned an invalid page token`);
    }
    if (seenPageTokens.has(data.nextPageToken)) {
      throw new Error(`${context} repeated a page token`);
    }
    seenPageTokens.add(data.nextPageToken);
    pageToken = data.nextPageToken;
  }

  return files;
}

async function findUniqueDriveFile(query, fields, context) {
  const files = await listAllMatches(query, `${fields},createdTime`, `${context} lookup`);
  if (files.length === 0) return null;
  if (files.length > 1) {
    log.warn(`${context} has ${files.length} duplicates; using the oldest`);
  }
  return pickCanonicalDuplicate(files);
}

export async function authenticate() {
  return getToken(true);
}

export async function disconnect() {
  try {
    const token = await getToken(false);
    await chrome.identity.removeCachedAuthToken({ token });
  } catch (e) {
    log.warn('disconnect cleanup:', e);
  }
}

// ── Folder management ─────────────────────────────────

async function findFolder() {
  const q = `name='${FOLDER_NAME}' and 'root' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  return findUniqueDriveFile(q, 'id,name', 'Drive root folder');
}

async function createFolder() {
  const metadata = {
    name: FOLDER_NAME,
    mimeType: 'application/vnd.google-apps.folder'
  };
  const resp = await driveRequest(`${DRIVE_API}/files`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(metadata)
  });
  return resp.json();
}

async function getOrCreateFolder() {
  let folder = await findFolder();
  if (!folder) ({ file: folder } = await createOrRecover(findFolder, createFolder));
  return requireDriveFileId(folder?.id, 'Drive root folder');
}

/**
 * Find or create a subfolder inside a parent folder.
 */
async function findSubfolder(parentId, subName) {
  requireDriveFileId(parentId, 'Drive parent folder');
  const q = `name='${subName}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  return findUniqueDriveFile(q, 'id,name', `Drive ${subName} folder`);
}

async function createSubfolder(parentId, subName) {
  const metadata = {
    name: subName,
    mimeType: 'application/vnd.google-apps.folder',
    parents: [parentId],
  };
  const resp = await driveRequest(`${DRIVE_API}/files`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(metadata)
  });
  return resp.json();
}

async function getOrCreateSubfolder(parentId, subName) {
  let sub = await findSubfolder(parentId, subName);
  if (!sub) {
    ({ file: sub } = await createOrRecover(
      () => findSubfolder(parentId, subName),
      () => createSubfolder(parentId, subName),
    ));
  }
  return requireDriveFileId(sub?.id, 'Drive subfolder');
}

/**
 * Get the ID of a named subfolder under the profile folder.
 * Creates profile folder and subfolder if needed.
 */
export async function getSubfolderId(subName) {
  const profileId = await getProfileFolderId();
  return getOrCreateSubfolder(profileId, subName);
}

// Convenience getters for known subfolders
export async function getSessionsFolderId() {
  return getSubfolderId(SUBFOLDER_SESSIONS);
}

export async function getStashesFolderId() {
  return getSubfolderId(SUBFOLDER_STASHES);
}

export async function getBookmarksFolderId() {
  return getSubfolderId(SUBFOLDER_BOOKMARKS);
}

// ── File operations ───────────────────────────────────

async function findFileInFolder(folderId, filename) {
  requireDriveFileId(folderId, 'Drive parent folder');
  const q = `name='${filename}' and '${folderId}' in parents and trashed=false`;
  return findUniqueDriveFile(q, 'id,name,modifiedTime', `Drive file ${filename}`);
}

async function patchFileContent(fileId, body, contentType) {
  const encodedId = encodedDriveFileId(fileId, 'Drive overwrite target');
  await driveRequest(`${UPLOAD_API}/files/${encodedId}?uploadType=media`, {
    method: 'PATCH',
    headers: { 'Content-Type': contentType },
    body
  });
}

/**
 * Create-or-overwrite one named file in a folder. The multipart create is
 * not retried blindly: after an ambiguous failure the file is looked up and,
 * if it exists, overwritten in place so no duplicate is ever created.
 */
async function upsertFileInFolder(folderId, filename, body, contentType, { archive: shouldArchive = false } = {}) {
  const existing = await findFileInFolder(folderId, filename);

  if (existing) {
    // Archive before overwriting
    if (shouldArchive) {
      await archiveFile(existing.id, filename);
    }
    await patchFileContent(existing.id, body, contentType);
    return existing.id;
  }

  const { file, recovered } = await createOrRecover(
    () => findFileInFolder(folderId, filename),
    async () => {
      const metadata = { name: filename, parents: [folderId] };
      const form = new FormData();
      form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
      form.append('file', new Blob([body], { type: contentType }));
      const resp = await driveRequest(`${UPLOAD_API}/files?uploadType=multipart`, {
        method: 'POST',
        body: form
      });
      return resp.json();
    },
  );
  if (recovered) await patchFileContent(file.id, body, contentType);
  return file?.id;
}

async function writeFileToFolder(folderId, filename, content, options = {}) {
  return upsertFileInFolder(folderId, filename, JSON.stringify(content, null, 2), 'application/json', options);
}

/**
 * Server-side copy of a file to a target folder with a new name.
 * No download required — uses Drive's files.copy endpoint.
 */
async function copyFile(fileId, newName, targetFolderId) {
  const encodedId = encodedDriveFileId(fileId, 'Drive copy source');
  requireDriveFileId(targetFolderId, 'Drive copy target folder');
  const resp = await driveRequest(`${DRIVE_API}/files/${encodedId}/copy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: newName, parents: [targetFolderId] }),
    // A duplicated timestamped archive copy is harmless; losing it is not.
    retryUnsafe: true,
  });
  return resp.json();
}

/**
 * Archive a file to the profile's archive subfolder before overwriting.
 * Appends an ISO timestamp to the filename (before .json).
 */
async function archiveFile(fileId, originalName) {
  const profileId = await getProfileFolderId();
  const archiveId = await getOrCreateSubfolder(profileId, SUBFOLDER_ARCHIVE);
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dotIdx = originalName.lastIndexOf('.');
  const ext = dotIdx > 0 ? originalName.slice(dotIdx) : '';
  const base = ext ? originalName.slice(0, dotIdx) : originalName;
  const archiveName = `${base}-${ts}${ext}`;
  return copyFile(fileId, archiveName, archiveId);
}

function parseContentLength(response) {
  const raw = response.headers?.get?.('Content-Length');
  if (raw === null || raw === undefined) return null;
  if (!/^(0|[1-9]\d*)$/.test(raw)) throw new Error('Drive JSON returned an invalid Content-Length');
  const length = Number(raw);
  if (!Number.isSafeInteger(length)) throw new Error('Drive JSON returned an invalid Content-Length');
  if (length > MAX_DRIVE_JSON_BYTES) throw new Error('Drive JSON exceeds the 25 MiB limit');
  return length;
}

function decodeUtf8(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('Drive JSON is not valid UTF-8');
  }
}

function parseJsonText(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Drive JSON is invalid');
  }
}

async function cancelReader(reader) {
  if (typeof reader?.cancel !== 'function') return;
  try {
    await reader.cancel();
  } catch {
    // Best-effort cancellation must not mask the resource-limit failure.
  }
}

/**
 * Read one Drive JSON response without ever allowing response.json() to buffer
 * an unbounded body. Both the declared and actual UTF-8 byte lengths are capped.
 */
export async function readBoundedJsonResponse(response) {
  parseContentLength(response);

  const reader = response.body && typeof response.body.getReader === 'function'
    ? response.body.getReader()
    : null;
  if (reader) {
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        await cancelReader(reader);
        throw new Error('Drive JSON stream returned an invalid byte chunk');
      }
      total += value.byteLength;
      if (total > MAX_DRIVE_JSON_BYTES) {
        await cancelReader(reader);
        throw new Error('Drive JSON exceeds the 25 MiB limit');
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return parseJsonText(decodeUtf8(bytes));
  }

  if (typeof response.arrayBuffer === 'function') {
    const buffer = await response.arrayBuffer();
    if (!(buffer instanceof ArrayBuffer)) throw new Error('Drive JSON returned invalid bytes');
    if (buffer.byteLength > MAX_DRIVE_JSON_BYTES) throw new Error('Drive JSON exceeds the 25 MiB limit');
    return parseJsonText(decodeUtf8(new Uint8Array(buffer)));
  }

  if (typeof response.text === 'function') {
    const text = await response.text();
    if (typeof text !== 'string') throw new Error('Drive JSON returned invalid text');
    const bytes = new TextEncoder().encode(text);
    if (bytes.byteLength > MAX_DRIVE_JSON_BYTES) throw new Error('Drive JSON exceeds the 25 MiB limit');
    return parseJsonText(text);
  }

  throw new Error('Drive JSON response body is unavailable');
}

async function readFileById(fileId) {
  const encodedId = encodedDriveFileId(fileId, 'Drive read target');
  const resp = await driveRequest(`${DRIVE_API}/files/${encodedId}?alt=media`);
  return readBoundedJsonResponse(resp);
}

async function deleteFileById(fileId) {
  const encodedId = encodedDriveFileId(fileId, 'Drive delete target');
  await driveRequest(`${DRIVE_API}/files/${encodedId}`, { method: 'DELETE' });
}

/**
 * Move a file to the user's Drive trash (recoverable for 30 days) rather
 * than deleting it permanently.
 */
async function trashFileById(fileId) {
  const encodedId = encodedDriveFileId(fileId, 'Drive trash target');
  await driveRequest(`${DRIVE_API}/files/${encodedId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trashed: true })
  });
}

/**
 * List all files in a folder.
 */
async function listFilesInFolder(folderId) {
  requireDriveFileId(folderId, 'Drive listing folder');
  const q = `'${folderId}' in parents and trashed=false and (mimeType='application/json' or mimeType='text/html')`;
  return listAllMatches(q, 'id,name,modifiedTime,size', 'Drive file listing', { orderBy: 'modifiedTime desc' });
}

// ── Public API: Profiles ─────────────────────────────

/**
 * List all profile folders inside TabKebab/.
 * Returns [{id, name}, ...] excluding legacy non-profile subfolders.
 */
export async function listDriveProfiles() {
  const rootId = await getOrCreateFolder();
  const q = `'${rootId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const folders = await listAllMatches(q, 'id,name', 'Drive profile listing');
  const reserved = new Set([SUBFOLDER_SESSIONS, SUBFOLDER_STASHES, SUBFOLDER_BOOKMARKS, SUBFOLDER_ARCHIVE]);
  return folders.filter(f => !reserved.has(f.name));
}

/**
 * Read settings from another profile's folder (for cross-profile import).
 */
export async function readSettingsFromProfile(profileFolderId) {
  const file = await findFileInFolder(profileFolderId, SETTINGS_FILENAME);
  if (!file) return null;
  return parseDriveSettingsDocument(await readFileById(file.id));
}

// ── Public API: Sync ──────────────────────────────────

export async function findSyncFile() {
  const folderId = await getProfileFolderId();
  return findFileInFolder(folderId, SYNC_FILENAME);
}

export async function readSyncFile(fileId) {
  return readFileById(fileId);
}

export async function writeSyncFile(content) {
  const folderId = await getProfileFolderId();
  return writeFileToFolder(folderId, SYNC_FILENAME, content, { archive: true });
}

export async function deleteSyncFile() {
  const folderId = await getProfileFolderId();
  const file = await findFileInFolder(folderId, SYNC_FILENAME);
  if (file) await deleteFileById(file.id);
}

// ── Public API: Settings ──────────────────────────────

export async function findSettingsFile() {
  const folderId = await getProfileFolderId();
  return findFileInFolder(folderId, SETTINGS_FILENAME);
}

export async function readSettingsFile(fileId) {
  return parseDriveSettingsDocument(await readFileById(fileId));
}

export async function writeSettingsFile(content) {
  const folderId = await getProfileFolderId();
  return writeFileToFolder(folderId, SETTINGS_FILENAME, content, { archive: true });
}

// ── Public API: Export files (profile root) ──────────

export async function exportFileToDrive(filename, content) {
  const folderId = await getProfileFolderId();
  return writeFileToFolder(folderId, filename, content);
}

export async function readDriveExport(fileId) {
  return readFileById(fileId);
}

export async function deleteDriveExport(fileId) {
  return deleteFileById(fileId);
}

// ── Public API: Subfolder-based export ───────────────

/**
 * Write a file to a specific subfolder under the profile folder.
 * @param {'sessions'|'stashes'|'bookmarks'} subfolder
 * @param {string} filename
 * @param {object} content
 */
export async function exportToSubfolder(subfolder, filename, content) {
  const folderId = await getSubfolderId(subfolder);
  return writeFileToFolder(folderId, filename, content, { archive: true });
}

/**
 * Write a raw string file (e.g. HTML) to a specific subfolder.
 * @param {'sessions'|'stashes'|'bookmarks'} subfolder
 * @param {string} filename
 * @param {string} rawContent — raw file body (not JSON-stringified)
 * @param {string} mimeType — e.g. 'text/html'
 */
export async function exportRawToSubfolder(subfolder, filename, rawContent, mimeType) {
  const folderId = await getSubfolderId(subfolder);
  return upsertFileInFolder(folderId, filename, rawContent, mimeType, { archive: true });
}

/**
 * List files in a specific subfolder under the profile folder.
 */
export async function listSubfolderFiles(subfolder) {
  const folderId = await getSubfolderId(subfolder);
  return listFilesInFolder(folderId);
}

/**
 * Retire a Drive file by ID. Retention uses this, so files are moved to the
 * Drive trash (recoverable) instead of being permanently deleted.
 */
export async function deleteDriveFile(fileId) {
  return trashFileById(fileId);
}

/**
 * List ALL files across profile folder + its subfolders for cleanup.
 * Returns files with their modifiedTime.
 */
export async function listAllDriveFiles() {
  const profileId = await getProfileFolderId();
  const profileFiles = await listFilesInFolder(profileId);

  const subfolders = [SUBFOLDER_SESSIONS, SUBFOLDER_STASHES, SUBFOLDER_BOOKMARKS, SUBFOLDER_ARCHIVE];
  const allFiles = profileFiles.map(file => ({ ...file, scope: 'profile' }));

  for (const sub of subfolders) {
    const subId = await getOrCreateSubfolder(profileId, sub);
    const subFiles = await listFilesInFolder(subId);
    allFiles.push(...subFiles.map(file => ({ ...file, scope: sub })));
  }

  return allFiles;
}
