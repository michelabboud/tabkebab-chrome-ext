// core/drive-client.js — Google Drive REST v3 client (appDataFolder only)

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const SYNC_FILENAME = 'taborganizer-sync.json';

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

export async function findSyncFile() {
  const resp = await driveRequest(
    `${DRIVE_API}/files?spaces=appDataFolder&q=name='${SYNC_FILENAME}'&fields=files(id,name,modifiedTime)`
  );
  const data = await resp.json();
  return data.files?.[0] || null;
}

export async function readSyncFile(fileId) {
  const resp = await driveRequest(`${DRIVE_API}/files/${fileId}?alt=media`);
  return resp.json();
}

export async function writeSyncFile(content) {
  const existing = await findSyncFile();
  const body = JSON.stringify(content);

  if (existing) {
    await driveRequest(`${UPLOAD_API}/files/${existing.id}?uploadType=media`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body
    });
  } else {
    const metadata = { name: SYNC_FILENAME, parents: ['appDataFolder'] };
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    form.append('file', new Blob([body], { type: 'application/json' }));

    await driveRequest(`${UPLOAD_API}/files?uploadType=multipart`, {
      method: 'POST',
      body: form
    });
  }
}

export async function deleteSyncFile() {
  const existing = await findSyncFile();
  if (existing) {
    await driveRequest(`${DRIVE_API}/files/${existing.id}`, { method: 'DELETE' });
  }
}
