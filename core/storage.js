// core/storage.js — Async wrapper around chrome.storage.local

export const Storage = {
  async get(key) {
    const result = await chrome.storage.local.get(key);
    return result[key] ?? null;
  },

  async getMany(keys) {
    return chrome.storage.local.get(keys);
  },

  async set(key, value) {
    return chrome.storage.local.set({ [key]: value });
  },

  async setMany(values) {
    return chrome.storage.local.set(values);
  },

  async remove(key) {
    return chrome.storage.local.remove(key);
  },

  async removeMany(keys) {
    return chrome.storage.local.remove(keys);
  },

  async getAll() {
    return chrome.storage.local.get(null);
  },

  onChange(callback) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local') callback(changes);
    });
  }
};
