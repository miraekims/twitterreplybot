// Tiny chrome.storage.local wrapper.
export const storage = {
  async get(key, def = null) {
    const r = await chrome.storage.local.get(key);
    return key in r ? r[key] : def;
  },
  async set(key, value) {
    await chrome.storage.local.set({ [key]: value });
  },
  async update(key, fn, def = null) {
    const cur = await storage.get(key, def);
    const next = fn(cur);
    await storage.set(key, next);
    return next;
  },
  async remove(key) {
    await chrome.storage.local.remove(key);
  },
};
