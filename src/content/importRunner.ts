import { call } from '../bridge/port';
import { buildPromptChunks } from '../core/chunker';
import { makeVaultMeta } from '../core/bundle';
import { getSettings, type Settings } from '../core/settings';
import { storageGet, storageRemove, storageSet } from '../core/storage';
import { putVaultBundle } from '../core/vault';
import { ROOT_MESSAGE_UUID, STORAGE_KEYS, type ImportResumeToken, type SessionBundle } from '../types/session';
import { describe } from './saveDialog';

export type ImportPhase =
  | 'validating'
  | 'creating'
  | 'importing'
  | 'paused'
  | 'done'
  | 'failed';

export interface ImportProgress {
  phase: ImportPhase;
  chunkIndex: number;
  chunkTotal: number;
  sessionName: string;
  createdUuid: string | null;
  error: string | null;
  /** True when the failure was a quota wall rather than a real bug. */
  limitReached: boolean;
}

export interface ImportOptions {
  /** Override the target model instead of the bundle's recorded model. */
  model?: string | null;
  /** Override the chunk ceiling. */
  maxPromptChars?: number;
  onProgress?: (p: ImportProgress) => void;
  /**
   * Fired as soon as the conversation exists and its first chunk has landed.
   *
   * The caller uses this to navigate, matching claude.ai's own behaviour of
   * jumping to `/chat/{uuid}` the instant a turn is sent rather than after the
   * whole exchange. The import keeps running after this fires.
   */
  onCreated?: (createdUuid: string) => void;
}

export interface ImportResult {
  createdUuid: string;
  chunksSent: number;
}

export class ImportLimitError extends Error {
  readonly token: ImportResumeToken;
  constructor(message: string, token: ImportResumeToken) {
    super(message);
    this.name = 'ImportLimitError';
    this.token = token;
  }
}

function isLimitError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'exceeded_limit'
  );
}

async function writeToken(token: ImportResumeToken | null): Promise<void> {
  const key = STORAGE_KEYS.resumeToken;
  if (token === null) {
    await storageRemove(key);
  } else {
    await storageSet({ [key]: token });
  }
}

export async function readResumeToken(): Promise<ImportResumeToken | null> {
  const raw = await storageGet(STORAGE_KEYS.resumeToken);
  const token = raw[STORAGE_KEYS.resumeToken];
  if (!token || typeof token !== 'object') return null;
  const t = token as Partial<ImportResumeToken>;
  if (typeof t.created_uuid !== 'string' || typeof t.org_uuid !== 'string') return null;
  return {
    bundle_id: String(t.bundle_id ?? ''),
    session_name: String(t.session_name ?? ''),
    model: String(t.model ?? ''),
    org_uuid: t.org_uuid,
    created_uuid: t.created_uuid,
    next_chunk: Number(t.next_chunk ?? 0),
    chunk_total: Number(t.chunk_total ?? 0),
    last_assistant_uuid: typeof t.last_assistant_uuid === 'string' ? t.last_assistant_uuid : null,
    started_at: String(t.started_at ?? ''),
  };
}

/**
 * Deterministic id so a resume token can find its bundle again.
 *
 * The bundle is stored under this id *before* the first chunk is sent, which is
 * what makes resume possible at all: a run that dies on chunk 0 never reaches
 * the "save to vault" step, so without an early write the token would point at
 * nothing.
 */
export function bundleIdOf(bundle: SessionBundle): string {
  return `${bundle.source.conversation_uuid}:${bundle.exported_at}`;
}

export interface ImportDeps {
  /** Injected in tests; defaults to the page bridge. */
  call?: typeof call;
  settings?: Settings;
  /** Injected in tests. */
  chunks?: string[];
}

/**
 * Import a session into the current profile.
 *
 * The claude.ai API has no message-write endpoint, so a session is transplanted
 * by posting its rendered transcript as one or more `completion.prompt` values.
 * Each prompt appends a human turn plus an assistant reply; the next prompt
 * parents onto the assistant message the previous one produced.
 *
 * If the target profile runs out of quota partway through, a resume token is
 * persisted so `resumeImport` can continue against the SAME conversation rather
 * than creating a half-duplicated new one.
 */
export async function runImport(
  bundle: SessionBundle,
  opts: ImportOptions = {},
  deps: ImportDeps = {},
): Promise<ImportResult> {
  const rpc = deps.call ?? call;
  const settings = opts.maxPromptChars
    ? { ...(deps.settings ?? (await getSettings())), maxPromptChars: opts.maxPromptChars }
    : deps.settings ?? (await getSettings());

  const chunks =
    deps.chunks ?? buildPromptChunks(bundle, { maxChars: settings.maxPromptChars });

  const report = (p: ImportProgress): void => opts.onProgress?.(p);
  const base = {
    sessionName: bundle.session_name,
    createdUuid: null as string | null,
    error: null as string | null,
    limitReached: false,
  };

  report({ ...base, phase: 'validating', chunkIndex: 0, chunkTotal: chunks.length });

  if (chunks.length === 0) {
    throw new Error('This session produced an empty transcript.');
  }

  const org = await rpc<{ org: string; orgName: string; email: string }>('resolveActiveOrg', {});
  const model = opts.model || settings.defaultModel || bundle.source.model || 'claude-sonnet-5-5';

  report({ ...base, phase: 'creating', chunkIndex: 0, chunkTotal: chunks.length });

  const created = await rpc<{ uuid: string; name?: string }>('createConversation', {
    org: org.org,
    input: { name: bundle.session_name, model },
  });

  let createdUuid = created.uuid;

  // Persist the bundle up front so a run that dies mid-import can be resumed
  // from the right transcript rather than guessed at.
  const bundleId = bundleIdOf(bundle);
  await putVaultBundle(
    bundle,
    makeVaultMeta(bundle, bundleId, 'imported', new Date().toISOString(), createdUuid),
  );

  let parent: string = ROOT_MESSAGE_UUID;
  let sent = 0;

  try {
    for (let i = 0; i < chunks.length; i++) {
      report({ ...base, phase: 'importing', chunkIndex: i, chunkTotal: chunks.length, createdUuid });

      const result = await rpc<{ assistantUuid: string }>('complete', {
        org: org.org,
        uuid: createdUuid,
        input: { prompt: chunks[i] as string, parentMessageUuid: parent, model },
      });

      parent = result.assistantUuid;
      sent = i + 1;

      // The conversation now has real content, so it is safe to navigate to.
      // Waiting for every chunk would strand the user on /new for the whole
      // import - and strand them there entirely if a quota wall pauses it.
      if (i === 0) opts.onCreated?.(createdUuid);

      await writeToken({
        bundle_id: bundleId,
        session_name: bundle.session_name,
        model,
        org_uuid: org.org,
        created_uuid: createdUuid,
        next_chunk: sent,
        chunk_total: chunks.length,
        last_assistant_uuid: parent,
        started_at: new Date().toISOString(),
      });
    }
  } catch (error) {
    if (isLimitError(error)) {
      const token: ImportResumeToken = {
        bundle_id: bundleId,
        session_name: bundle.session_name,
        model,
        org_uuid: org.org,
        created_uuid: createdUuid,
        next_chunk: sent,
        chunk_total: chunks.length,
        last_assistant_uuid: parent === ROOT_MESSAGE_UUID ? null : parent,
        started_at: new Date().toISOString(),
      };
      await writeToken(token);
      report({
        ...base,
        phase: 'paused',
        chunkIndex: sent,
        chunkTotal: chunks.length,
        createdUuid,
        limitReached: true,
        error: describe(error),
      });
      throw new ImportLimitError(
        `This profile hit its usage limit after ${sent} of ${chunks.length} part(s).`,
        token,
      );
    }
    await writeToken(null);
    report({
      ...base,
      phase: 'failed',
      chunkIndex: sent,
      chunkTotal: chunks.length,
      createdUuid,
      error: describe(error),
    });
    throw error;
  }

  await writeToken(null);

  // Normalise the title: claude.ai may rename a conversation from its first turn.
  if (bundle.session_name && bundle.session_name !== created.name) {
    await rpc('updateConversation', {
      org: org.org,
      uuid: createdUuid,
      patch: { name: bundle.session_name },
    }).catch(() => undefined);
  }

  report({ ...base, phase: 'done', chunkIndex: chunks.length, chunkTotal: chunks.length, createdUuid });
  return { createdUuid, chunksSent: sent };
}

/**
 * Continue a paused import against the conversation it already created.
 * Returns null when there is nothing to resume.
 */
export async function resumeImport(
  bundle: SessionBundle,
  opts: ImportOptions = {},
  deps: ImportDeps = {},
): Promise<ImportResult | null> {
  const token = await readResumeToken();
  if (!token) return null;

  const rpc = deps.call ?? call;
  const settings = deps.settings ?? (await getSettings());
  const chunks =
    deps.chunks ?? buildPromptChunks(bundle, { maxChars: opts.maxPromptChars ?? settings.maxPromptChars });

  let parent: string = token.last_assistant_uuid ?? ROOT_MESSAGE_UUID;
  let sent = token.next_chunk;

  for (let i = sent; i < chunks.length; i++) {
    try {
      const result = await rpc<{ assistantUuid: string }>('complete', {
        org: token.org_uuid,
        uuid: token.created_uuid,
        input: { prompt: chunks[i] as string, parentMessageUuid: parent, model: token.model },
      });
      parent = result.assistantUuid;
      sent = i + 1;
      await writeToken({ ...token, next_chunk: sent, last_assistant_uuid: parent });
    } catch (error) {
      if (isLimitError(error)) {
        opts.onProgress?.({
          phase: 'paused',
          chunkIndex: sent,
          chunkTotal: chunks.length,
          sessionName: token.session_name,
          createdUuid: token.created_uuid,
          error: describe(error),
          limitReached: true,
        });
        throw error;
      }
      throw error;
    }
  }

  await writeToken(null);
  opts.onProgress?.({
    phase: 'done',
    chunkIndex: chunks.length,
    chunkTotal: chunks.length,
    sessionName: token.session_name,
    createdUuid: token.created_uuid,
    error: null,
    limitReached: false,
  });
  return { createdUuid: token.created_uuid, chunksSent: sent };
}

/** Discard a pending resume so the next import starts fresh. */
export async function clearResume(): Promise<void> {
  await writeToken(null);
}