import { describe, beforeEach, expect, it } from 'vitest';
import {
  clearVault,
  deleteVaultBundle,
  getVaultBundle,
  getVaultMeta,
  listVault,
  putVaultBundle,
  VAULT_QUOTA_BYTES,
} from '../src/core/vault';
import { buildBundle, makeVaultMeta } from '../src/core/bundle';
import type { ClaudeConversation } from '../src/types/claude';
import { ROOT_MESSAGE_UUID, type SessionBundle } from '../src/types/session';

/** Minimal in-memory chrome.storage.local.local substitute. */
function installFakeStorage() {
  const data = new Map<string, unknown>();
  (globalThis as Record<string, unknown>).chrome = {
    storage: {
      local: {
        async get(keys: string | string[] | null) {
          const list =
            keys === null
              ? [...data.keys()]
              : Array.isArray(keys)
                ? keys
                : [keys as string];
          const out: Record<string, unknown> = {};
          for (const k of list) if (data.has(k)) out[k] = data.get(k);
          return out;
        },
        async set(items: Record<string, unknown>) {
          for (const [k, v] of Object.entries(items)) data.set(k, v);
        },
        async remove(keys: string | string[]) {
          for (const k of Array.isArray(keys) ? keys : [keys]) data.delete(k);
        },
      },
    },
  };
  return data;
}

const source = {
  account_uuid: 'a',
  account_email: 'a@b.c',
  organization_uuid: 'o',
  organization_name: 'O',
  conversation_uuid: 'c',
  conversation_name: 'Session',
  model: 'claude-sonnet-5-5',
  created_at: '2026-10-13T02:56:00Z',
  updated_at: '2026-10-13T02:56:00Z',
  url: 'https://claude.ai/chat/c',
};

function bundleWith(bodyLen: number): SessionBundle {
  const conv: ClaudeConversation = {
    uuid: 'c',
    name: 'Session',
    model: 'claude-sonnet-5-5',
    current_leaf_message_uuid: 'm0',
    chat_messages: [
      {
        uuid: 'm0',
        sender: 'human',
        created_at: '2026-10-13T02:56:00Z',
        parent_message_uuid: ROOT_MESSAGE_UUID,
        content: [{ type: 'text', text: 'x'.repeat(bodyLen), citations: [] }],
      },
    ],
  };
  return buildBundle({
    conversation: conv,
    source,
    includeThinking: true,
    includeTools: true,
  });
}

/** Build a bundle with a real payload of `bodyLen` bytes.
 *
 * `buildBundle` truncates individual blocks at 24k by design, so quota tests
 * need to bypass it to produce genuinely large stored objects.
 */
function bigBundle(bodyLen: number, name = 'Session'): SessionBundle {
  const base = bundleWith(1);
  return {
    ...base,
    session_name: name,
    turns: [
      {
        index: 0,
        role: 'user',
        source_uuid: 'm0',
        created_at: '2026-10-13T02:56:00Z',
        blocks: [{ type: 'text', text: 'x'.repeat(bodyLen), citations: [] }],
      },
    ],
    stats: { ...base.stats, chars: bodyLen },
  };
}

beforeEach(() => {
  installFakeStorage();
});

describe('vault', () => {
  it('starts empty', async () => {
    expect(await listVault()).toEqual([]);
  });

  it('round-trips a bundle', async () => {
    const b = bundleWith(50);
    await putVaultBundle(b, makeVaultMeta(b, 'id-1', 'saved', '2026-10-13T03:00:00Z', 'c'));
    const loaded = await getVaultBundle('id-1');
    expect(loaded.turns).toEqual(b.turns);
    expect(await getVaultMeta('id-1')).toMatchObject({ session_name: 'Session' });
  });

  it('sorts newest first', async () => {
    for (const [id, at] of [
      ['a', '2026-01-01T00:00:00Z'],
      ['b', '2026-03-01T00:00:00Z'],
      ['c', '2026-02-01T00:00:00Z'],
    ] as const) {
      const b = bundleWith(10);
      await putVaultBundle(b, makeVaultMeta(b, id, 'saved', at, 'c'));
    }
    expect((await listVault()).map((e) => e.bundle_id)).toEqual(['b', 'c', 'a']);
  });

  it('replaces an entry with the same id instead of duplicating it', async () => {
    const b1 = bundleWith(10);
    await putVaultBundle(b1, makeVaultMeta(b1, 'id-1', 'saved', '2026-01-01T00:00:00Z', 'c'));
    const b2 = { ...b1, session_name: 'Renamed' };
    await putVaultBundle(b2, makeVaultMeta(b2, 'id-1', 'saved', '2026-01-01T00:00:00Z', 'c'));
    const list = await listVault();
    expect(list).toHaveLength(1);
    expect((await getVaultBundle('id-1')).session_name).toBe('Renamed');
  });

  it('evicts the oldest entries when over quota', async () => {
    // Five ~2 MB bundles total ~10 MB, over the 8 MB budget.
    for (let i = 0; i < 5; i++) {
      const b = bigBundle(2_000_000, `Session ${i}`);
      await putVaultBundle(
        b,
        makeVaultMeta(b, `id-${i}`, 'saved', `2026-01-0${i + 1}T00:00:00Z`, 'c'),
      );
    }
    const list = await listVault();
    expect(list.length).toBeLessThan(5);
    // The newest survives; the oldest are gone.
    expect(list[0]?.bundle_id).toBe('id-4');
    expect(list.some((e) => e.bundle_id === 'id-0')).toBe(false);
    expect(list.map((e) => e.bundle_id)).toEqual(['id-4', 'id-3', 'id-2', 'id-1']);
  });

  it('keeps the newest entry even when it alone exceeds the quota', async () => {
    const big = bigBundle(VAULT_QUOTA_BYTES + 1000);
    await putVaultBundle(big, makeVaultMeta(big, 'huge', 'saved', '2026-01-01T00:00:00Z', 'c'));
    expect((await listVault()).map((e) => e.bundle_id)).toEqual(['huge']);
    expect((await getVaultBundle('huge')).turns).toHaveLength(1);
  });

  it('does not evict when everything fits', async () => {
    for (let i = 0; i < 3; i++) {
      const b = bigBundle(1000, `S${i}`);
      await putVaultBundle(b, makeVaultMeta(b, `id-${i}`, 'saved', `2026-01-0${i + 1}T00:00:00Z`, 'c'));
    }
    expect(await listVault()).toHaveLength(3);
  });

  it('deletes one entry', async () => {
    const b = bundleWith(10);
    await putVaultBundle(b, makeVaultMeta(b, 'id-1', 'saved', '2026-01-01T00:00:00Z', 'c'));
    await deleteVaultBundle('id-1');
    expect(await listVault()).toEqual([]);
    await expect(getVaultBundle('id-1')).rejects.toThrow();
  });

  it('clears everything including stored payloads', async () => {
    const data = installFakeStorage();
    for (const id of ['a', 'b']) {
      const b = bundleWith(10);
      await putVaultBundle(b, makeVaultMeta(b, id, 'saved', '2026-01-01T00:00:00Z', 'c'));
    }
    await clearVault();
    expect(await listVault()).toEqual([]);
    expect([...data.keys()].filter((k) => k.startsWith('sext.bundle.'))).toEqual([]);
  });

  it('surfaces a readable error for a corrupt stored bundle', async () => {
    const data = installFakeStorage();
    data.set('sext.bundle.bad', { format: 'wrong', version: 1 });
    await expect(getVaultBundle('bad')).rejects.toThrow(/bad_format/);
  });
});