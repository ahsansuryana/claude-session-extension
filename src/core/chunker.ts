import type { SessionBundle } from '../types/session';
import { renderPrompt } from './transcript';

/**
 * claude.ai accepted a 1,000,000 character prompt in testing (2026-10-13), so
 * this ceiling exists only to keep each chunk's *generation* reasonable, not to
 * work around a server limit. One chunk == one assistant reply == one unit of
 * the target profile's quota.
 */
export const DEFAULT_MAX_PROMPT_CHARS = 120_000;

const TURN_HEADING = /^## Turn \d+ - /m;

export interface ChunkOptions {
  maxChars?: number;
  /** Text injected into chunks after the first so the model knows it continues. */
  continuationNote?: string;
}

export const DEFAULT_CONTINUATION_NOTE =
  '<session_transfer_continued>This is a continuation of the same transferred ' +
  'session. Earlier turns were sent in a previous message. Continue reading from ' +
  'where this part ends; do not restart the session or re-summarise it.</session_transfer_continued>';

/**
 * Split a rendered transcript at `## Turn N` boundaries only.
 *
 * A single turn larger than `maxChars` is emitted whole rather than dropped or
 * hard-split - losing content would be worse than one oversized chunk.
 */
export function chunkTranscript(
  rendered: string,
  opts: ChunkOptions = {},
): string[] {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_PROMPT_CHARS;
  if (maxChars <= 0) return [rendered];
  if (rendered.length <= maxChars) return [rendered];

  // Split into [preamble, turn, turn, ...] preserving every character.
  const starts: number[] = [];
  const re = new RegExp(TURN_HEADING.source, 'gm');
  let m: RegExpExecArray | null;
  while ((m = re.exec(rendered)) !== null) starts.push(m.index);

  const pieces: string[] = [];
  if (starts.length === 0 || (starts[0] as number) > 0) {
    pieces.push(rendered.slice(0, (starts[0] as number | undefined) ?? rendered.length));
  }
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i] as number;
    const end = i + 1 < starts.length ? (starts[i + 1] as number) : rendered.length;
    pieces.push(rendered.slice(start, end));
  }

  const chunks: string[] = [];
  let current = '';
  for (const piece of pieces) {
    if (!piece) continue;
    if (current && current.length + piece.length + 2 > maxChars) {
      chunks.push(current);
      current = '';
    }
    current = current ? `${current}\n\n${piece}` : piece;
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * Prepend the continuation framing to every chunk after the first, so the model
 * treats the sequence as one session rather than several unrelated prompts.
 */
export function wrapChunk(
  rendered: string,
  i: number,
  total: number,
  opts: ChunkOptions = {},
): string {
  if (i <= 0 || total <= 1) return rendered;
  const note =
    opts.continuationNote ??
    (i === total - 1
      ? '<session_transfer_end>The transcript ends here. Be ready to continue the ' +
        'session from this point.</session_transfer_end>'
      : DEFAULT_CONTINUATION_NOTE);
  return `${note}\n\n${rendered}`;
}

/** Convenience: render a bundle straight into ready-to-post prompts. */
export function buildPromptChunks(
  bundle: SessionBundle,
  opts: ChunkOptions & { header?: string } = {},
): string[] {
  const rendered = renderPrompt(bundle, { header: opts.header });
  const chunks = chunkTranscript(rendered, opts);
  return chunks.map((c, i) => wrapChunk(c, i, chunks.length, opts));
}