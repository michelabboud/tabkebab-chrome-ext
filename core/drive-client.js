// core/drive-client.js — Google Drive REST v3 client (visible TabKebab folder)

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_NAME = 'TabKebab';
const SYNC_FILENAME = 'tabkebab-sync.json';

// Subfolder names under TabKebab
const SUBFOLDER_SESSIONS = 'sessions';
const SUBFOLDER_STASHES = 'stashes';
const SUBFOLDER_BOOKMARKS = 'bookmarks';

// ── Auth ──────────────────────────────────────────────

async function getToken(interactive = false) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(token);
      }
    });
  });
}

async function driveRequest(url, options = {}, interactive = false) {
  let token = await getToken(interactive);

  let resp = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      ...(options.headers || {})
    }
  });

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

  if (!resp.ok) throw new Error(`Drive API error: ${resp.status}`);
  return resp;
}

export async function authenticate() {
  return getToken(true);
}

export async function disconnect() {
  try {
    const token = await getToken(false);
    await chrome.identity.removeCachedAuthToken({ token });
  } catch {
    // Already disconnected
  }
}

// ── Folder management ─────────────────────────────────

async function findFolder() {
  const q = `name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const resp = await driveRequest(
    `${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=files(id,name)&spaces=drive`
  );
  const data = await resp.json();
  return data.files?.[0] || null;
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
  return folder.id;
}

/**
 * Find or create a subfolder inside a parent folder.
 */
async function findSubfolder(parentId, subName) {
  const q = `name='${subName}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const resp = await driveRequest(
    `${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=files(id,name)&spaces=drive`
  );
  const data = await resp.json();
  return data.files?.[0] || null;
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
  return sub.id;
}

/**
 * Get the ID of a named subfolder under TabKebab root.
 * Creates TabKebab and subfolder if needed.
 */
export async function getSubfolderId(subName) {
  const rootId = await getOrCreateFolder();
  return getOrCreateSubfolder(rootId, subName);
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
  const q = `name='${filename}' and '${folderId}' in parents and trashed=false`;
  const resp = await driveRequest(
    `${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=files(id,name,modifiedTime)&spaces=drive`
  );
  const data = await resp.json();
  return data.files?.[0] || null;
}

async function writeFileToFolder(folderId, filename, content) {
  const body = JSON.stringify(content, null, 2);
  const existing = await findFileInFolder(folderId, filename);

  if (existing) {
    await driveRequest(`${UPLOAD_API}/files/${existing.id}?uploadType=media`, {
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

async function readFileById(fileId) {
  const resp = await driveRequest(`${DRIVE_API}/files/${fileId}?alt=media`);
  return resp.json();
}

async function deleteFileById(fileId) {
  await driveRequest(`${DRIVE_API}/files/${fileId}`, { method: 'DELETE' });
}

/**
 * List all files in a folder.
 */
async function listFilesInFolder(folderId) {
  const q = `'${folderId}' in parents and trashed=false and mimeType='application/json'`;
  const resp = await driveRequest(
    `${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=files(id,name,modifiedTime,size)&orderBy=modifiedTime desc&spaces=drive`
  );
  const data = await resp.json();
  return data.files || [];
}

// ── Public API: Sync ──────────────────────────────────

export async function findSyncFile() {
  const folderId = await getOrCreateFolder();
  return findFileInFolder(folderId, SYNC_FILENAME);
}

export async function readSyncFile(fileId) {
  return readFileById(fileId);
}

export async function writeSyncFile(content) {
  const folderId = await getOrCreateFolder();
  return writeFileToFolder(folderId, SYNC_FILENAME, content);
}

export async function deleteSyncFile() {
  const folderId = await getOrCreateFolder();
  const file = await findFileInFolder(folderId, SYNC_FILENAME);
  if (file) await deleteFileById(file.id);
}

// ── Public API: Export files (root folder) ───────────

export async function exportFileToDrive(filename, content) {
  const folderId = await getOrCreateFolder();
  return writeFileToFolder(folderId, filename, content);
}

export async function listDriveExports() {
  const folderId = await getOrCreateFolder();
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
 * Write a file to a specific subfolder under TabKebab.
 * @param {'sessions'|'stashes'|'bookmarks'} subfolder
 * @param {string} filename
 * @param {object} content
 */
export async function exportToSubfolder(subfolder, filename, content) {
  const folderId = await getSubfolderId(subfolder);
  return writeFileToFolder(folderId, filename, content);
}

/**
 * List files in a specific subfolder under TabKebab.
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
 * List ALL files across all subfolders + root for cleanup.
 * Returns files with their modifiedTime.
 */
export async function listAllDriveFiles() {
  const rootId = await getOrCreateFolder();
  const rootFiles = await listFilesInFolder(rootId);

  const subfolders = [SUBFOLDER_SESSIONS, SUBFOLDER_STASHES, SUBFOLDER_BOOKMARKS];
  const allFiles = [...rootFiles];

  for (const sub of subfolders) {
    try {
      const subId = await getOrCreateSubfolder(rootId, sub);
      const subFiles = await listFilesInFolder(subId);
      allFiles.push(...subFiles);
    } catch {
      // Subfolder may not exist yet
    }
  }

  return allFiles;
}
