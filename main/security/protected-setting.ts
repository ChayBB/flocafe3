import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'node:crypto';
import { getSettingValue, upsertSettings } from '../db';

/**
 * Secrets that live in settings until OS-backed storage can hold them, the way the JWT secret
 * does: the row then carries only this marker, so a copied database or backup holds no key.
 */
export const PROTECTED_SETTING_MARKER = 'safe-storage:v1';

interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend?(): string;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

function secureStore(
  key: string,
  strict = false,
): { storage: SafeStorageLike; filePath: string } | null {
  try {
    const { app, safeStorage } = require('electron') as {
      app?: { isPackaged?: boolean; getPath(name: string): string };
      safeStorage?: SafeStorageLike;
    };
    if (!app || (!app.isPackaged && !(strict && process.platform === 'win32'))) return null;
    if (!safeStorage?.isEncryptionAvailable()) return null;
    if (
      strict &&
      process.platform === 'linux' &&
      safeStorage.getSelectedStorageBackend?.() === 'basic_text'
    )
      return null;
    return { storage: safeStorage, filePath: path.join(app.getPath('userData'), `${key}.enc`) };
  } catch {
    return null;
  }
}

function readFile(store: { storage: SafeStorageLike; filePath: string }): string {
  try {
    return store.storage.decryptString(fs.readFileSync(store.filePath)) || '';
  } catch {
    return '';
  }
}

function writeFile(store: { storage: SafeStorageLike; filePath: string }, value: string): boolean {
  const temp = `${store.filePath}.tmp`;
  try {
    fs.writeFileSync(temp, store.storage.encryptString(value), { mode: 0o600, flush: true });
    if (readFile({ ...store, filePath: temp }) !== value) return false;
    fs.renameSync(temp, store.filePath);
    return true;
  } catch {
    return false;
  } finally {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // A failed cleanup must not turn a successful write into a failure.
    }
  }
}

export class ProtectedStorageUnavailableError extends Error {}

function storageSlot(key: string, marker: string): string | null {
  if (marker === PROTECTED_SETTING_MARKER) return key;
  const match = /^safe-storage:v1:([a-f0-9-]{36})$/.exec(marker);
  return match ? `${key}.${match[1]}` : null;
}

function removeSlot(key: string | null, strict: boolean): void {
  const store = key && secureStore(key, strict);
  if (!store) return;
  try {
    fs.rmSync(store.filePath, { force: true });
  } catch {
    // An unreferenced encrypted file cannot change the active credential.
  }
}

/** Switches the encrypted slot only when the caller's SQLite transaction commits. */
export function commitProtectedSetting(
  key: string,
  value: string,
  commit: (marker: string) => void,
): void {
  const previous = storageSlot(key, getSettingValue(key) ?? '');
  const marker = `${PROTECTED_SETTING_MARKER}:${randomUUID()}`;
  const slot = storageSlot(key, marker)!;
  const store = secureStore(slot, true);
  if (!store || !writeFile(store, value)) throw new ProtectedStorageUnavailableError();
  try {
    commit(marker);
  } catch (error) {
    removeSlot(slot, true);
    throw error;
  }
  removeSlot(previous, true);
}

/**
 * The secret, or '' when none is set or the OS store no longer yields it (a backup restored on
 * another machine): callers then issue a new secret or ask to pair again. A plaintext value left
 * by an older version moves into the OS store on first read.
 */
export function readProtectedSetting(
  key: string,
  requireEncryption = false,
  migrate = true,
): string {
  const value = getSettingValue(key) ?? '';
  const slot = storageSlot(key, value);
  const store = secureStore(slot ?? key, requireEncryption);
  if (slot) return store ? readFile(store) : '';
  if (migrate && value && store && writeFile(store, value)) {
    upsertSettings({ [key]: PROTECTED_SETTING_MARKER });
    return value;
  }
  return requireEncryption ? '' : value;
}

/** Stores the secret in the OS store when there is one; '' clears it everywhere. */
export function writeProtectedSetting(key: string, value: string, requireEncryption = false): void {
  const previous = storageSlot(key, getSettingValue(key) ?? '');
  const store = secureStore(key, requireEncryption);
  if (!value) {
    upsertSettings({ [key]: '' });
    removeSlot(previous ?? key, requireEncryption);
    return;
  }
  if (store && writeFile(store, value)) {
    upsertSettings({ [key]: PROTECTED_SETTING_MARKER });
    if (previous && previous !== key) removeSlot(previous, requireEncryption);
    return;
  }
  if (requireEncryption) throw new ProtectedStorageUnavailableError();
  upsertSettings({ [key]: value });
}
