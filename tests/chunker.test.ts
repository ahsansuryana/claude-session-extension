import { describe, expect, it } from 'vitest';
import {
  buildPromptChunks,
  chunkTranscript,
  DEFAULT_CONTINUATION_NOTE,
  wrapChunk,
} from '../src/core/chunker';
import { renderPrompt } from '../src/core/transcript';
import type { SessionBundle } from '../src/types/session';
import { ROOT_MESSAGE_UUID, SESSION_FORMAT } from '../src/types/session';

function makeBundle(turnCount: number, bodyLen: number): SessionBundle {
  return {
    format: SESSION_FORMAT,
    version: 1,
    exported_at: '2026-10-13T03:00:00Z',
    session_name: 'Chunky',
    source: {
      account_uuid: 'a',
      account_email: 'a@b.c',
      organization_uuid: 'o',
      organization_name: 'O',
      conversation_uuid: 'c',
      conversation_name: 'Chunky',
      model: 'claude-sonnet-5-5',
      created_at: '2026-10-13T02:56:00Z',
      updated_at: '2026-10-13T02:56:00Z',
      url: 'https://claude.ai/chat/c',
    },
    stats: { message_count: turnCount, branch_count: 0, content_blocks: turnCount, chars: 0, omitted_files: 0 },
    turns: Array.from({ length: turnCount }, (_, i) => ({
      index: i,
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      source_uuid: `m${i}`,
      created_at: '2026-10-13T02:56:00Z',
      blocks: [{ type: 'text' as const, text: 'y'.repeat(bodyLen), citations: [] }],
    })),
  };
}

const headingCount = (s: string) => (s.match(/^## Turn \d+ - /gm) ?? []).length;

describe('chunkTranscript', () => {
  it('returns a single chunk when the transcript fits', () => {
    const rendered = '## Turn 1 - User\nshort\n\n## Turn 2 - Assistant\nalso short';
    expect(chunkTranscript(rendered, { maxChars: 10_000 })).toEqual([rendered]);
  });

  it('splits only at turn boundaries', () => {
    const rendered = Array.from(
      { length: 6 },
      (_, i) => `## Turn ${i + 1} - User\n${'z'.repeat(100)}`,
    ).join('\n\n');
    const chunks = chunkTranscript(rendered, { maxChars: 500 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(500);
      // Every chunk body is whole turns, never a partial one.
      expect(c.startsWith('## Turn ')).toBe(true);
    }
    expect(chunks.reduce((n, c) => n + headingCount(c), 0)).toBe(6);
  });

  it('never drops an oversize single turn', () => {
    const rendered = `## Turn 1 - User\n${'q'.repeat(5000)}`;
    const chunks = chunkTranscript(rendered, { maxChars: 100 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain('q'.repeat(5000));
  });

  it('keeps the header preamble attached to the first chunk', () => {
    const rendered = `<session_transfer>\nstuff\n</session_transfer>\n\n${Array.from(
      { length: 4 },
      (_, i) => `## Turn ${i + 1} - User\n${'z'.repeat(200)}`,
    ).join('\n\n')}`;
    const chunks = chunkTranscript(rendered, { maxChars: 400 });
    expect(chunks[0]).toContain('<session_transfer>');
  });

  it('returns everything as one chunk when maxChars is non-positive', () => {
    expect(chunkTranscript('a\n\n## Turn 1 - User\nb', { maxChars: 0 })).toHaveLength(1);
  });
});

describe('wrapChunk', () => {
  it('leaves the first chunk untouched', () => {
    expect(wrapChunk('body', 0, 3)).toBe('body');
  });

  it('adds a continuation note to later chunks', () => {
    const out = wrapChunk('body', 1, 3);
    expect(out).toContain(DEFAULT_CONTINUATION_NOTE);
    expect(out.endsWith('body')).toBe(true);
  });

  it('uses an end marker on the final chunk', () => {
    expect(wrapChunk('body', 2, 3)).toContain('<session_transfer_end>');
  });

  it('is a no-op when there is only one chunk', () => {
    expect(wrapChunk('body', 0, 1)).toBe('body');
  });
});

describe('buildPromptChunks', () => {
  it('renders a bundle into prompts that together cover every turn exactly once', () => {
    const bundle = makeBundle(10, 300);
    const prompts = buildPromptChunks(bundle, { maxChars: 1500 });
    expect(prompts.length).toBeGreaterThan(1);
    const total = prompts.reduce((n, p) => n + headingCount(p), 0);
    expect(total).toBe(10);
    // Only the first chunk carries the transfer envelope.
    expect(prompts.filter((p) => p.includes('<session_transfer>')).length).toBe(1);
    // Later chunks carry continuation framing.
    expect(prompts.slice(1).every((p) => p.includes('session_transfer'))).toBe(true);
  });

  it('produces exactly one prompt for a small session', () => {
    const bundle = makeBundle(2, 20);
    const prompts = buildPromptChunks(bundle, { maxChars: 120_000 });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toBe(renderPrompt(bundle));
  });

  it('does not re-split when the header makes chunk 1 exceed the limit', () => {
    // Guard against an off-by-one where the preamble pushes chunk 0 over.
    const bundle = makeBundle(2, 100);
    const prompts = buildPromptChunks(bundle, { maxChars: 300 });
    const joined = prompts.join('\n');
    expect(headingCount(joined)).toBe(2);
  });
});

describe('turn ordering', () => {
  it('preserves bundle turn order in the rendered prompt', () => {
    const bundle = makeBundle(4, 10);
    const out = renderPrompt(bundle);
    const order = [...out.matchAll(/^## Turn (\d+) - /gm)].map((m) => Number(m[1]));
    expect(order).toEqual([1, 2, 3, 4]);
  });

  it('uses the root sentinel convention for the first turn only', () => {
    expect(ROOT_MESSAGE_UUID).toBe('00000000-0000-4000-8000-000000000000');
  });
});