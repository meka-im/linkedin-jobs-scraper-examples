import { InstallerError } from './errors.js';

export const OAUTH_SESSION_KEY = 'meka.n8n.installer.oauth';

export function createSessionStorageAdapter(storage) {
  return {
    get(key) {
      try {
        return storage.getItem(key);
      } catch {
        throw new InstallerError('SESSION_UNAVAILABLE', 'Browser session storage is unavailable.');
      }
    },
    set(key, value) {
      try {
        storage.setItem(key, value);
      } catch {
        throw new InstallerError('SESSION_UNAVAILABLE', 'Browser session storage is unavailable.');
      }
    },
    remove(key) {
      try {
        storage.removeItem(key);
      } catch {
        throw new InstallerError('SESSION_UNAVAILABLE', 'Browser session storage is unavailable.');
      }
    },
  };
}

export function createMemorySessionStore() {
  const values = new Map();
  return {
    get(key) {
      return values.get(key) ?? null;
    },
    set(key, value) {
      values.set(key, value);
    },
    remove(key) {
      values.delete(key);
    },
  };
}

export function saveOAuthSession(storage, session) {
  storage.set(OAUTH_SESSION_KEY, JSON.stringify(session));
}

export function loadOAuthSession(storage) {
  const raw = storage.get(OAUTH_SESSION_KEY);
  if (!raw) return null;
  storage.remove(OAUTH_SESSION_KEY);
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('invalid');
    }
    return parsed;
  } catch {
    throw new InstallerError(
      'OAUTH_SESSION_INVALID',
      'The saved sign-in attempt is invalid. Start the connection again.',
    );
  }
}

export function clearOAuthSession(storage) {
  storage.remove(OAUTH_SESSION_KEY);
}
