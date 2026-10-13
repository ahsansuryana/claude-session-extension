import type { ClaudeConversation } from '../types/claude';
import {
  SESSION_FORMAT,
  SESSION_FORMAT_VERSION,
  type SessionBundle,
  type SessionSource,
  type SessionStats,
  type TranscriptTurn,
  type VaultEntryMeta,
} from '../types/session';
import { countBranches, leafPath } from './tree';
import { toTurns } from './transcript';

export type BundleErrorCode =
  | 'bad_json'
  | 'bad_format'
  | 'bad_version'
  | 'empty_session'
  | 'bad_shape';

export class BundleError extends Error {
  readonly code: BundleErrorCode;
  constructor(code: BundleErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'BundleError';
    this.code = code;
  }
}

export interface BuildBundleInput {
  conversation: ClaudeConversation;
  source: SessionSource;
  /** User-editable title. Falls back to the source conversation name. */
  sessionName?: string;
  includeThinking: boolean;
  includeTools: boolean;
  includeFilePlaceholders?: boolean;
  exportedAt?: string;
}

/**
 * Turn a live conversation into a portable bundle.
 *
 * Only the active branch is exported (see `tree.ts`); abandoned sibling
 * branches from regenerations are counted in `stats.branch_count` but not
 * included, so the imported session continues down the branch you were on.
 */
export function buildBundle(input: BuildBundleInput): SessionBundle {
  const { conversation, source } = input;
  const path = leafPath(conversation);

  const turns: TranscriptTurn[] = toTurns(path, {
    includeThinking: input.includeThinking,
    includeTools: input.includeTools,
    includeFilePlaceholders: input.includeFilePlaceholders ?? true,
    ...(conversation.model ? { model: conversation.model } : {}),
  });

  const contentBlocks = turns.reduce((n, t) => n + t.blocks.length, 0);
  const omittedFiles = turns.reduce(
    (n, t) => n + t.blocks.filter((b) => b.type === 'file').length,
    0,
  );

  const stats: SessionStats = {
    message_count: turns.length,
    branch_count: countBranches(conversation),
    content_blocks: contentBlocks,
    chars: 0,
    omitted_files: omittedFiles,
  };

  const bundle: SessionBundle = {
    format: SESSION_FORMAT,
    version: SESSION_FORMAT_VERSION,
    exported_at: input.exportedAt ?? new Date().toISOString(),
    session_name:
      (input.sessionName ?? source.conversation_name ?? '').trim() ||
      source.conversation_name ||
      'Untitled session',
    source,
    stats,
    turns,
  };

  stats.chars = estimateChars(bundle);
  return bundle;
}

/** Rough prompt size the importer will send. Used for pre-flight chunk maths. */
export function estimateChars(bundle: SessionBundle): number {
  let n = 0;
  for (const turn of bundle.turns) {
    n += 32; // heading + role label
    for (const b of turn.blocks) {
      switch (b.type) {
        case 'text':
          n += b.text.length;
          break;
        case 'thinking':
          n += (b.summaries ?? []).reduce((a, s) => a + s.summary.length, 0);
          break;
        case 'tool_use':
          n += b.name.length + JSON.stringify(b.input ?? null).length;
          break;
        case 'tool_result':
          n += String(b.content ?? '').length;
          break;
        case 'file':
          n += b.file_name.length + 80;
          break;
      }
    }
  }
  return n;
}

export function isSessionBundle(value: unknown): value is SessionBundle {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<SessionBundle>;
  return (
    v.format === SESSION_FORMAT &&
    typeof v.version === 'number' &&
    typeof v.session_name === 'string' &&
    Array.isArray(v.turns)
  );
}

/** Parse a downloaded file. Throws `BundleError` with a user-readable reason. */
export function parseBundle(text: string): SessionBundle {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new BundleError('bad_json', (e as Error).message);
  }
  return migrateBundle(raw as SessionBundle);
}

/**
 * Validate and upgrade a bundle to the current shape.
 *
 * Bundles are user-facing files that may be hand-edited or come from an older
 * build, so every field is checked before it reaches the importer.
 */
export function migrateBundle(bundle: SessionBundle): SessionBundle {
  if (!bundle || typeof bundle !== 'object') {
    throw new BundleError('bad_shape', 'not an object');
  }
  if (bundle.format !== SESSION_FORMAT) {
    throw new BundleError(
      'bad_format',
      `expected format "${SESSION_FORMAT}", got ${JSON.stringify(bundle.format)}`,
    );
  }
  if (typeof bundle.version !== 'number') {
    throw new BundleError('bad_version', 'missing version');
  }
  if (bundle.version > SESSION_FORMAT_VERSION) {
    throw new BundleError(
      'bad_version',
      `file was written by a newer version (${bundle.version} > ${SESSION_FORMAT_VERSION}); update the extension`,
    );
  }

  let out = bundle;
  if (out.version < SESSION_FORMAT_VERSION) {
    // v0 -> v1: stats.omitted_files did not exist.
    out.stats = { ...out.stats, omitted_files: out.stats?.omitted_files ?? 0 };
    out.version = SESSION_FORMAT_VERSION;
  }

  if (!Array.isArray(out.turns) || out.turns.length === 0) {
    throw new BundleError('empty_session', 'the transcript has no turns');
  }
  if (!out.source || typeof out.source.conversation_name !== 'string') {
    throw new BundleError('bad_shape', 'missing source metadata');
  }
  if (!out.stats || typeof out.stats !== 'object') {
    out.stats = {
      message_count: out.turns.length,
      branch_count: 0,
      content_blocks: 0,
      chars: 0,
      omitted_files: 0,
    };
  }

  // Renumber defensively - the importer relies on turn.index for ordering.
  out.turns = out.turns.map((t, i) => ({
    ...t,
    index: i,
    role: t.role === 'user' ? 'user' : 'assistant',
    blocks: Array.isArray(t.blocks) ? t.blocks : [],
  }));

  if (typeof out.session_name !== 'string' || !out.session_name.trim()) {
    out.session_name = out.source.conversation_name || 'Untitled session';
  }
  return out;
}

export function summarize(bundle: SessionBundle): string {
  const { stats, source } = bundle;
  return `${stats.message_count} turn${stats.message_count === 1 ? '' : 's'} · ` +
    `${stats.content_blocks} blocks · ~${Math.round(stats.chars / 1000)}k chars · ` +
    `from ${source.account_email ?? 'unknown account'}`;
}

export function makeVaultMeta(
  bundle: SessionBundle,
  bundleId: string,
  origin: VaultEntryMeta['origin'],
  nowIso: string,
  /** Conversation this bundle produced locally (imports) or was read from (saves). */
  conversationUuid: string | null,
): VaultEntryMeta {
  return {
    bundle_id: bundleId,
    session_name: bundle.session_name,
    saved_at: nowIso,
    origin,
    account_email: bundle.source.account_email,
    conversation_uuid: conversationUuid,
    message_count: bundle.stats.message_count,
    chars: bundle.stats.chars,
  };
}