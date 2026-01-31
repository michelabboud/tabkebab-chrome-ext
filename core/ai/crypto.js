// core/ai/crypto.js — API key encryption via Web Crypto (PBKDF2 + AES-GCM)
//
// Two modes:
// 1. User sets a passphrase → encrypt with that passphrase
// 2. No passphrase → encrypt with a per-install device key (auto-generated UUID)
//
// The raw API key is NEVER stored in plaintext.

const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const INSTALL_ID_KEY = 'installId';

// ── Install ID (per-profile device key) ──

export async function getInstallId() {
  const result = await chrome.storage.local.get(INSTALL_ID_KEY);
  if (result[INSTALL_ID_KEY]) return result[INSTALL_ID_KEY];

  const id = crypto.randomUUID();
  await chrome.storage.local.set({ [INSTALL_ID_KEY]: id });
  return id;
}

// ── Helpers ──

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function fromBase64(str) {
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

async function deriveKey(passphrase, salt) {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

// ── Public API ──

/**
 * Encrypt an API key. If no passphrase given, uses the install-level device key.
 * @param {string} plainKey - The raw API key
 * @param {string} [passphrase] - Optional user passphrase
 * @returns {Promise<{ciphertext: string, salt: string, iv: string, usesPassphrase: boolean}>}
 */
export async function encryptApiKey(plainKey, passphrase) {
  const usesPassphrase = !!passphrase;
  const secret = passphrase || await getInstallId();

  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(secret, salt);

  const encoder = new TextEncoder();
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoder.encode(plainKey)
  );

  return {
    ciphertext: toBase64(ciphertext),
    salt: toBase64(salt),
    iv: toBase64(iv),
    usesPassphrase,
  };
}

/**
 * Decrypt an API key. If the encrypted data used a passphrase, one must be provided.
 * Otherwise, the install-level device key is used automatically.
 * @param {{ciphertext: string, salt: string, iv: string, usesPassphrase: boolean}} encrypted
 * @param {string} [passphrase] - Required if usesPassphrase is true
 * @returns {Promise<string>} The decrypted API key
 */
export async function decryptApiKey(encrypted, passphrase) {
  const secret = encrypted.usesPassphrase ? passphrase : await getInstallId();
  if (!secret) throw new Error('Passphrase required to decrypt API key');

  const salt = new Uint8Array(fromBase64(encrypted.salt));
  const iv = new Uint8Array(fromBase64(encrypted.iv));
  const ciphertext = fromBase64(encrypted.ciphertext);
  const key = await deriveKey(secret, salt);

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ciphertext
  );

  return new TextDecoder().decode(decrypted);
}
