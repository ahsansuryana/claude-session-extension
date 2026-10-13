import { BundleError, migrateBundle } from './bundle';
import { storageGet, storageRemove, storageSet } from './storage';
import {
  STORAGE_KEYS,
  type SessionBundle,
  type VaultEntryMeta,
  type VaultIndex,
} from '../types/session';

/**
 * Per-profile session vault, stored in `chrome.storage.local`.
 *
 * Browser profiles have completely isolated extension storage, which is exactly
 * why a bundle has to be exported as a file (or moved via the future sync
 * server) to reach another profile. See BACKLOG.md.
 */

/** chrome.storage.local defaults to 10 MB in MV3; stay well under it. */
export const VAULT_QUOTA_BYTES = 8 * 1024 * 1024;

function bundleKey(id: string): string {
  return `${STORAGE_KEYS.bundlePrefix}${id}`;
}

async function readIndex(): Promise<VaultIndex> {
  const raw = await storageGet(STORAGE_KEYS.vaultIndex);
  const value = raw[STORAGE_KEYS.vaultIndex] as VaultIndex | undefined;
  if (!value || !Array.isArray(value.entries)) return { entries: [] };
  return value;
}

async function writeIndex(index: VaultIndex): Promise<void> {
  await storageSet({ [STORAGE_KEYS.vaultIndex]: index });
}

function byteLength(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length;
  } catch {
    return 0;
  }
}

export async function listVault(): Promise<VaultEntryMeta[]> {
  const { entries } = await readIndex();
  return [...entries].sort((a, b) => b.saved_at.localeCompare(a.saved_at));
}

export async function getVaultBundle(id: string): Promise<SessionBundle> {
  const raw = await storageGet(bundleKey(id));
  const stored = raw[bundleKey(id)];
  if (!stored) throw new BundleError('bad_shape', `no saved session with id ${id}`);
  return migrateBundle(stored as SessionBundle);
}

export async function getVaultMeta(id: string): Promise<VaultEntryMeta | null> {
  const { entries } = await readIndex();
  return entries.find((e) => e.bundle_id === id) ?? null;
}

/**
 * Store a bundle and evict oldest-first until the vault fits its quota.
 *
 * Eviction never removes the entry just written, even if it alone exceeds the
 * quota - losing the user's newest save silently would be worse than a failed
 * write.
 */
export async function putVaultBundle(
  bundle: SessionBundle,
  meta: VaultEntryMeta,
): Promise<VaultEntryMeta> {
  const index = await readIndex();
  const entries = index.entries.filter((e) => e.bundle_id !== meta.bundle_id);
  entries.push(meta);

  const sizes = new Map<string, number>(entries.map((e) => [e.bundle_id, byteLength(bundle)]));
  // Real stored bundles may differ in size from the incoming one, so measure
  // everything currently on disk.
  const all = await storageGet(entries.map((e) => bundleKey(e.bundle_id)));
  for (const e of entries) {
    if (e.bundle_id === meta.bundle_id) continue;
    const stored = all[bundleKey(e.bundle_id)];
    if (stored) sizes.set(e.bundle_id, byteLength(stored));
  }

  let total = [...sizes.values()].reduce((a, b) => a + b, 0);
  const evictable = entries
    .filter((e) => e.bundle_id !== meta.bundle_id)
    .sort((a, b) => a.saved_at.localeCompare(b.saved_at));

  const doomed: string[] = [];
  for (const candidate of evictable) {
    if (total <= VAULT_QUOTA_BYTES) break;
    total -= sizes.get(candidate.bundle_id) ?? 0;
    doomed.push(candidate.bundle_id);
  }
  if (doomed.length) {
    await storageRemove(doomed.map(bundleKey));
  }

  await storageSet({ [bundleKey(meta.bundle_id)]: bundle });
  const next = entries.filter((e) => !doomed.includes(e.bundle_id));
  await writeIndex({ entries: next });
  return meta;
}

export async function deleteVaultBundle(id: string): Promise<void> {
  const index = await readIndex();
  await storageRemove(bundleKey(id));
  await writeIndex({ entries: index.entries.filter((e) => e.bundle_id !== id) });
}

export async function clearVault(): Promise<void> {
  const index = await readIndex();
  await storageRemove(index.entries.map((e) => bundleKey(e.bundle_id)));
  await writeIndex({ entries: [] });
}