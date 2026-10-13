import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearResume,
  ImportLimitError,
  readResumeToken,
  resumeImport,
  bundleIdOf,
  runImport,
  type ImportProgress,
} from '../src/content/importRunner';
import { buildBundle, makeVaultMeta, parseBundle } from '../src/core/bundle';
import { putVaultBundle } from '../src/core/vault';
import { ROOT_MESSAGE_UUID, STORAGE_KEYS, type SessionBundle, type VaultEntryMeta } from '../src/types/session';
import type { ClaudeConversation } from '../src/types/claude';
import type { RpcOp } from '../src/types/protocol';

function installFakeStorage() {
  const data = new Map<string, unknown>();
  (globalThis as Record<string, unknown>).chrome = {
    storage: {
      local: {
        async get(keys: string | string[] | null) {
          const list = keys === null ? [...data.keys()] : Array.isArray(keys) ? keys : [keys as string];
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
  account_uuid: 'acct',
  account_email: 'old@example.com',
  organization_uuid: 'org-old',
  organization_name: 'Old',
  conversation_uuid: 'src-conv',
  conversation_name: 'Old session',
  model: 'claude-sonnet-5-5',
  created_at: '2026-10-13T02:00:00Z',
  updated_at: '2026-10-13T02:30:00Z',
  url: 'https://claude.ai/chat/src-conv',
};

function bundle(turns = 2): SessionBundle {
  const conv: ClaudeConversation = {
    uuid: 'src-conv',
    name: 'Old session',
    model: 'claude-sonnet-5-5',
    current_leaf_message_uuid: `m${turns - 1}`,
    chat_messages: Array.from({ length: turns }, (_, i) => ({
      uuid: `m${i}`,
      sender: (i % 2 === 0 ? 'human' : 'assistant') as 'human' | 'assistant',
      created_at: '2026-10-13T02:00:00Z',
      parent_message_uuid: i === 0 ? ROOT_MESSAGE_UUID : `m${i - 1}`,
      stop_reason: i % 2 === 1 ? 'end_turn' : null,
      content: [{ type: 'text' as const, text: `message ${i}`, citations: [] }],
    })),
  };
  return buildBundle({
    conversation: conv,
    source,
    includeThinking: true,
    includeTools: true,
  });
}

interface RpcCall { op: RpcOp; payload: Record<string, unknown> }

function fakeRpc(handlers: Partial<Record<RpcOp, (p: Record<string, unknown>) => unknown>>) {
  const calls: RpcCall[] = [];
  const fn = (async <T,>(op: RpcOp, payload: unknown): Promise<T> => {
    calls.push({ op, payload: payload as Record<string, unknown> });
    const handler = handlers[op];
    if (!handler) throw new Error(`unexpected op ${op}`);
    return handler(payload as Record<string, unknown>) as T;
  }) as unknown as typeof import('../src/bridge/port').call;
  return { fn, calls };
}

const DEFAULT_OK = {
  resolveActiveOrg: () => ({ org: 'org-new', orgName: 'New', accountUuid: 'a2', email: 'new@example.com' }),
  createConversation: () => ({ uuid: 'new-conv', name: 'Old session' }),
  updateConversation: () => ({ uuid: 'new-conv', name: 'Old session' }),
};

let storageNow: Map<string, unknown>;
beforeEach(() => {
  storageNow = installFakeStorage();

  // crypto.randomUUID exists in Node 19+; keep the test hermetic.
  let n = 0;
  Object.defineProperty(globalThis.crypto, 'randomUUID', {
    value: () => `uuid-${n++}`,
    configurable: true,
  });
});

describe('runImport', () => {
  it('creates a conversation and sends one prompt for a single-chunk session', async () => {
    const { fn, calls } = fakeRpc({
      ...DEFAULT_OK,
      complete: () => ({ assistantUuid: 'asst-1', humanUuid: 'human-1' }),
    });

    const progress: ImportProgress[] = [];
    const result = await runImport(bundle(2), { onProgress: (p) => progress.push(p) }, {
      call: fn,
      chunks: ['ONLY-CHUNK'],
    });

    expect(result).toEqual({ createdUuid: 'new-conv', chunksSent: 1 });
    // The title already matched, so no rename round-trip.
    expect(calls.map((c) => c.op)).toEqual([
      'resolveActiveOrg',
      'createConversation',
      'complete',
    ]);
    expect(calls[1]?.payload).toMatchObject({
      org: 'org-new',
      input: { name: 'Old session', model: 'claude-sonnet-5-5' },
    });
    expect(calls[2]?.payload).toMatchObject({
      org: 'org-new',
      uuid: 'new-conv',
      input: { prompt: 'ONLY-CHUNK', parentMessageUuid: ROOT_MESSAGE_UUID },
    });
    expect(progress.map((p) => p.phase)).toEqual([
      'validating',
      'creating',
      'importing',
      'done',
    ]);
  });

  it('renames the conversation when claude.ai retitled it from the first turn', async () => {
    const { fn, calls } = fakeRpc({
      ...DEFAULT_OK,
      // claude.ai auto-titles a conversation after its first user message.
      createConversation: () => ({ uuid: 'new-conv', name: 'first transcript line' }),
      complete: () => ({ assistantUuid: 'a', humanUuid: 'h' }),
    });

    await runImport(bundle(2), {}, { call: fn, chunks: ['C1'] });
    const update = calls.find((c) => c.op === 'updateConversation');
    expect(update?.payload).toMatchObject({
      org: 'org-new',
      uuid: 'new-conv',
      patch: { name: 'Old session' },
    });
  });

  it('chains chunks by parenting each onto the previous assistant message', async () => {
    let n = 0;
    const { fn, calls } = fakeRpc({
      ...DEFAULT_OK,
      complete: () => ({ assistantUuid: `asst-${++n}`, humanUuid: `human-${n}` }),
    });

    await runImport(bundle(2), {}, { call: fn, chunks: ['C1', 'C2', 'C3'] });

    const completions = calls.filter((c) => c.op === 'complete');
    expect(completions).toHaveLength(3);
    expect((completions[0]?.payload.input as Record<string, string>).parentMessageUuid).toBe(
      ROOT_MESSAGE_UUID,
    );
    expect((completions[1]?.payload.input as Record<string, string>).parentMessageUuid).toBe('asst-1');
    expect((completions[2]?.payload.input as Record<string, string>).parentMessageUuid).toBe('asst-2');
  });

  it('uses the explicit model override when given', async () => {
    const { fn, calls } = fakeRpc({
      ...DEFAULT_OK,
      complete: () => ({ assistantUuid: 'a', humanUuid: 'h' }),
    });
    await runImport(bundle(2), { model: 'claude-opus-4-5' }, { call: fn, chunks: ['X'] });
    expect((calls[1]?.payload.input as Record<string, string>).model).toBe('claude-opus-4-5');
  });

  it('rejects an empty transcript before creating anything', async () => {
    const { fn, calls } = fakeRpc(DEFAULT_OK);
    await expect(runImport(bundle(2), {}, { call: fn, chunks: [] })).rejects.toThrow(/empty transcript/);
    expect(calls).toHaveLength(0);
  });

  it('persists a resume token and pauses when the target profile is out of quota', async () => {
    let n = 0;
    const { fn } = fakeRpc({
      ...DEFAULT_OK,
      complete: () => {
        n++;
        if (n === 2) {
          const err = Object.assign(new Error('Target profile has reached its usage limit.'), {
            code: 'exceeded_limit',
          });
          throw err;
        }
        return { assistantUuid: 'asst-1', humanUuid: 'human-1' };
      },
    });

    const progress: ImportProgress[] = [];
    const err = await runImport(
      bundle(2),
      { onProgress: (p) => progress.push(p) },
      { call: fn, chunks: ['C1', 'C2', 'C3'] },
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ImportLimitError);
    const token = (err as ImportLimitError).token;
    expect(token.next_chunk).toBe(1);
    expect(token.chunk_total).toBe(3);
    expect(token.created_uuid).toBe('new-conv');
    expect(token.last_assistant_uuid).toBe('asst-1');
    expect(progress.at(-1)).toMatchObject({ phase: 'paused', limitReached: true });
    expect(await readResumeToken()).toMatchObject({ next_chunk: 1 });
  });

  it('does not create a second conversation when resuming', async () => {
    let n = 0;
    const { fn, calls } = fakeRpc({
      ...DEFAULT_OK,
      complete: () => ({ assistantUuid: `asst-${++n}`, humanUuid: 'h' }),
    });

    // Pause first.
    n = 0;
    const failing = fakeRpc({
      ...DEFAULT_OK,
      complete: () => {
        throw Object.assign(new Error('limit'), { code: 'exceeded_limit' });
      },
    });
    await runImport(bundle(2), {}, { call: failing.fn, chunks: ['C1', 'C2'] }).catch(() => undefined);
    expect(calls).toHaveLength(0);

    // Now resume against the same conversation.
    const result = await resumeImport(bundle(2), {}, { call: fn, chunks: ['C1', 'C2'] });
    expect(result).toEqual({ createdUuid: 'new-conv', chunksSent: 2 });
    expect(calls.map((c) => c.op)).not.toContain('createConversation');
    expect(calls.filter((c) => c.op === 'complete')).toHaveLength(2);
    expect((calls[0]?.payload.input as Record<string, string>).parentMessageUuid).toBe(
      ROOT_MESSAGE_UUID,
    );
  });

  it('clears the resume token on a non-limit failure', async () => {
    const { fn } = fakeRpc({
      ...DEFAULT_OK,
      complete: () => {
        throw new Error('network exploded');
      },
    });
    await expect(runImport(bundle(2), {}, { call: fn, chunks: ['C1'] })).rejects.toThrow('network exploded');
    expect(await readResumeToken()).toBeNull();
  });

  it('returns null when resuming with nothing stored', async () => {
    const { fn } = fakeRpc(DEFAULT_OK);
    expect(await resumeImport(bundle(2), {}, { call: fn, chunks: ['C1'] })).toBeNull();
  });

  it('clearResume discards the pending token', async () => {
    const data = (storageNow = installFakeStorage());
    data.set(STORAGE_KEYS.resumeToken, { org_uuid: 'o', created_uuid: 'c', next_chunk: 1 });
    expect(await readResumeToken()).toMatchObject({ next_chunk: 1 });
    await clearResume();
    expect(await readResumeToken()).toBeNull();
  });

  it('ignores a corrupt resume token', async () => {
    const data = (storageNow = installFakeStorage());
    data.set(STORAGE_KEYS.resumeToken, { nonsense: true });
    expect(await readResumeToken()).toBeNull();
  });

  it('stores the bundle in the vault under the token id before sending any chunk', async () => {
    // A run that dies on chunk 0 never reaches the end-of-run save, so the
    // early write is the only reason a resume can find the right transcript.
    // Reuse one bundle object: buildBundle stamps a fresh exported_at each call.
    const subject = bundle(2);
    let vaultDuringFirstComplete: VaultEntryMeta[] = [];
    const { fn } = fakeRpc({
      ...DEFAULT_OK,
      complete: () => {
        const raw = storageNow.get(STORAGE_KEYS.vaultIndex) as { entries: VaultEntryMeta[] };
        vaultDuringFirstComplete = raw.entries;
        throw Object.assign(new Error('limit'), { code: 'exceeded_limit' });
      },
    });

    await runImport(subject, {}, { call: fn, chunks: ['C1', 'C2'] }).catch(() => undefined);

    expect(vaultDuringFirstComplete).toHaveLength(1);
    expect(vaultDuringFirstComplete[0]?.bundle_id).toBe(bundleIdOf(subject));

    const token = await readResumeToken();
    expect(token?.bundle_id).toBe(bundleIdOf(subject));
  });

  it('derives a stable bundle id from the file contents', () => {
    // parseBundle preserves exported_at, so re-reading the same file yields the
    // same id - which is what lets a resume token find it later.
    const subject = bundle(2);
    const reparsed = parseBundle(JSON.stringify(subject));
    expect(bundleIdOf(reparsed)).toBe(bundleIdOf(subject));
  });

  it('resumes using the bundle stored under the token id, not the newest entry', async () => {
    // Two saved sessions; the token must resolve to its own.
    const other = bundle(2);
    other.session_name = 'Unrelated session';
    other.exported_at = '2026-02-02T00:00:00Z';
    await putVaultBundle(
      other,
      makeVaultMeta(other, 'other-id', 'saved', '2026-02-02T00:00:00Z', null),
    );

    const failing = fakeRpc({
      ...DEFAULT_OK,
      complete: () => {
        throw Object.assign(new Error('limit'), { code: 'exceeded_limit' });
      },
    });
    await runImport(bundle(2), {}, { call: failing.fn, chunks: ['C1', 'C2'] }).catch(() => undefined);

    const token = await readResumeToken();
    expect(token).not.toBeNull();

    const resumed = fakeRpc({
      ...DEFAULT_OK,
      complete: () => ({ assistantUuid: 'asst-r', humanUuid: 'human-r' }),
    });
    const result = await resumeImport(bundle(2), {}, { call: resumed.fn, chunks: ['C1', 'C2'] });

    expect(result?.createdUuid).toBe('new-conv');
    // The unrelated entry was never touched.
    const index = storageNow.get(STORAGE_KEYS.vaultIndex) as { entries: VaultEntryMeta[] };
    expect(index.entries.some((e) => e.bundle_id === 'other-id')).toBe(true);
  });

  it('stores the imported bundle in the vault', async () => {
    const { fn } = fakeRpc({
      ...DEFAULT_OK,
      complete: () => ({ assistantUuid: 'a', humanUuid: 'h' }),
    });
    await runImport(bundle(2), {}, { call: fn, chunks: ['C1'] });
    const raw = storageNow.get(STORAGE_KEYS.vaultIndex) as { entries: VaultEntryMeta[] };
    expect(raw.entries).toHaveLength(1);
    expect(raw.entries[0]).toMatchObject({
      origin: 'imported',
      conversation_uuid: 'new-conv',
      session_name: 'Old session',
    });
  });
});