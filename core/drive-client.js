// core/drive-client.js — Google Drive REST v3 client (visible TabKebab folder)

import { isValidDriveFileId } from './drive-retention.js';

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

async function driveRequest(url, options = {}, interactive = false) {
  const MAX_RETRIES = 3;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let token = await getToken(interactive);

    let resp = await fetch(url, {
      ...options,
      headers: {
        'Authorization': `Bearer ${token}`,
        ...(options.headers || {})
      }
    });

    // Re-auth on 401
    if (resp.status === 401) {
      await chrome.identity.removeCachedAuthToken({ token });
      token = await getToken(interactive);
      resp = await fetch(url, {
        ...options,
        headers: {
          'Authorization': `Bearer ${token}`,
          ...(options.headers || {})
        }
      });
    }

    if (resp.ok) return resp;

    // Retry on transient errors (429, 500, 502, 503)
    const retryable = [429, 500, 502, 503];
    if (retryable.includes(resp.status) && attempt < MAX_RETRIES) {
      const retryAfter = resp.headers.get('Retry-After');
      const delayMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : (1000 * Math.pow(2, attempt));
      console.warn(`[TabKebab] Drive API ${resp.status}, retry ${attempt + 1}/${MAX_RETRIES} in ${delayMs}ms`);
      await new Promise(r => setTimeout(r, delayMs));
      continue;
    }

    throw new Error(`Drive API error: ${resp.status}`);
  }
}

async function findUniqueDriveFile(query, fields, context) {
  const url = new URL(`${DRIVE_API}/files`);
  url.searchParams.set('q', query);
  url.searchParams.set('fields', `nextPageToken,files(${fields})`);
  url.searchParams.set('pageSize', '2');
  url.searchParams.set('spaces', 'drive');
  const resp = await driveRequest(url.toString());
  const data = await resp.json();
  if (!data || typeof data !== 'object' || !Array.isArray(data.files)) {
    throw new Error(`${context} lookup returned an invalid page`);
  }
  if (data.nextPageToken != null || data.files.length > 1) {
    throw new Error(`${context} lookup is ambiguous: multiple matches`);
  }
  if (data.files.length === 0) return null;
  return validateListedFile(data.files[0]);
}

export async function authenticate() {
  return getToken(true);
}

export async function disconnect() {
  try {
    const token = await getToken(false);
    await chrome.identity.removeCachedAuthToken({ token });
  } catch (e) {
    console.warn('[TabKebab] disconnect cleanup:', e);
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
  if (!folder) folder = await createFolder();
  return requireDriveFileId(folder.id, 'Drive root folder');
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
  if (!sub) sub = await createSubfolder(parentId, subName);
  return requireDriveFileId(sub.id, 'Drive subfolder');
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

async function writeFileToFolder(folderId, filename, content, { archive: shouldArchive = false } = {}) {
  const body = JSON.stringify(content, null, 2);
  const existing = await findFileInFolder(folderId, filename);

  if (existing) {
    // Archive before overwriting
    if (shouldArchive) {
      await archiveFile(existing.id, filename);
    }
    const fileId = encodedDriveFileId(existing.id, 'Drive overwrite target');
    await driveRequest(`${UPLOAD_API}/files/${fileId}?uploadType=media`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body
    });
    return existing.id;
  } else {
    const metadata = { name: filename, parents: [folderId] };
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    form.append('file', new Blob([body], { type: 'application/json' }));

    const resp = await driveRequest(`${UPLOAD_API}/files?uploadType=multipart`, {
      method: 'POST',
      body: form
    });
    const data = await resp.json();
    return data.id;
  }
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
    body: JSON.stringify({ name: newName, parents: [targetFolderId] })
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

async function readFileById(fileId) {
  const encodedId = encodedDriveFileId(fileId, 'Drive read target');
  const resp = await driveRequest(`${DRIVE_API}/files/${encodedId}?alt=media`);
  return resp.json();
}

async function deleteFileById(fileId) {
  const encodedId = encodedDriveFileId(fileId, 'Drive delete target');
  await driveRequest(`${DRIVE_API}/files/${encodedId}`, { method: 'DELETE' });
}

/**
 * List all files in a folder.
 */
async function listFilesInFolder(folderId) {
  requireDriveFileId(folderId, 'Drive listing folder');
  const q = `'${folderId}' in parents and trashed=false and (mimeType='application/json' or mimeType='text/html')`;
  const files = [];
  const seenPageTokens = new Set();
  let pageToken = null;

  while (true) {
    const url = new URL(`${DRIVE_API}/files`);
    url.searchParams.set('q', q);
    url.searchParams.set('fields', 'nextPageToken,files(id,name,modifiedTime,size)');
    url.searchParams.set('orderBy', 'modifiedTime desc');
    url.searchParams.set('spaces', 'drive');
    if (pageToken !== null) url.searchParams.set('pageToken', pageToken);

    const resp = await driveRequest(url.toString());
    const data = await resp.json();
    if (!data || typeof data !== 'object' || !Array.isArray(data.files)) {
      throw new Error('Drive file listing returned an invalid page');
    }
    files.push(...data.files.map(validateListedFile));

    if (data.nextPageToken === undefined || data.nextPageToken === null) break;
    if (typeof data.nextPageToken !== 'string' || data.nextPageToken.length === 0) {
      throw new Error('Drive file listing returned an invalid page token');
    }
    if (seenPageTokens.has(data.nextPageToken)) {
      throw new Error('Drive file listing repeated a page token');
    }
    seenPageTokens.add(data.nextPageToken);
    pageToken = data.nextPageToken;
  }

  return files;
}

// ── Public API: Profiles ─────────────────────────────

/**
 * List all profile folders inside TabKebab/.
 * Returns [{id, name}, ...] excluding legacy non-profile subfolders.
 */
export async function listDriveProfiles() {
  const rootId = await getOrCreateFolder();
  const q = `'${rootId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const resp = await driveRequest(
    `${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=files(id,name)&spaces=drive`
  );
  const data = await resp.json();
  const reserved = new Set([SUBFOLDER_SESSIONS, SUBFOLDER_STASHES, SUBFOLDER_BOOKMARKS, SUBFOLDER_ARCHIVE]);
  return (data.files || []).filter(f => !reserved.has(f.name));
}

/**
 * Read settings from another profile's folder (for cross-profile import).
 */
export async function readSettingsFromProfile(profileFolderId) {
  const file = await findFileInFolder(profileFolderId, SETTINGS_FILENAME);
  if (!file) return null;
  return readFileById(file.id);
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
  return readFileById(fileId);
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

export async function listDriveExports() {
  const folderId = await getProfileFolderId();
  const q = `'${folderId}' in parents and trashed=false and mimeType='application/json'`;
  const resp = await driveRequest(
    `${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=files(id,name,modifiedTime,size)&orderBy=modifiedTime desc&spaces=drive`
  );
  const data = await resp.json();
  return data.files || [];
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
  const existing = await findFileInFolder(folderId, filename);

  if (existing) {
    await archiveFile(existing.id, filename);
    const fileId = encodedDriveFileId(existing.id, 'Drive overwrite target');
    await driveRequest(`${UPLOAD_API}/files/${fileId}?uploadType=media`, {
      method: 'PATCH',
      headers: { 'Content-Type': mimeType },
      body: rawContent
    });
    return existing.id;
  } else {
    const metadata = { name: filename, parents: [folderId] };
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    form.append('file', new Blob([rawContent], { type: mimeType }));

    const resp = await driveRequest(`${UPLOAD_API}/files?uploadType=multipart`, {
      method: 'POST',
      body: form
    });
    const data = await resp.json();
    return data.id;
  }
}

/**
 * List files in a specific subfolder under the profile folder.
 */
export async function listSubfolderFiles(subfolder) {
  const folderId = await getSubfolderId(subfolder);
  return listFilesInFolder(folderId);
}

/**
 * Delete a Drive file by ID.
 */
export async function deleteDriveFile(fileId) {
  return deleteFileById(fileId);
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
