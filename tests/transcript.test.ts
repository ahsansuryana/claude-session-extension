import { describe, expect, it } from 'vitest';
import { toTurns } from '../src/core/transcript';
import type { ClaudeMessage } from '../src/types/claude';
import { ROOT_MESSAGE_UUID } from '../src/types/session';

/**
 * `toTurns` decides what survives into the bundle. It is deliberately lossy -
 * empty turns dropped, oversized blocks truncated, files replaced by
 * placeholders - so the interesting cases are all about what gets lost.
 */

function human(uuid: string, text: string): ClaudeMessage {
  return {
    uuid,
    sender: 'human',
    parent_message_uuid: ROOT_MESSAGE_UUID,
    created_at: '2026-10-13T02:56:05Z',
    content: [{ type: 'text', text, citations: [] }],
  };
}

function assistant(uuid: string, parent: string, blocks: ClaudeMessage['content']): ClaudeMessage {
  return {
    uuid,
    sender: 'assistant',
    parent_message_uuid: parent,
    created_at: '2026-10-13T02:56:07Z',
    stop_reason: 'end_turn',
    content: blocks,
  };
}

const ALL_ON = {
  includeThinking: true,
  includeTools: true,
  includeFilePlaceholders: true,
};

describe('toTurns', () => {
  it('renumbers turns 0..n-1 regardless of source index', () => {
    const turns = toTurns(
      [
        { ...human('m0', 'hi'), index: 7 },
        { ...assistant('m1', 'm0', [{ type: 'text', text: 'yo', citations: [] }]), index: 3 },
      ],
      ALL_ON,
    );
    expect(turns.map((t) => t.index)).toEqual([0, 1]);
    expect(turns.map((t) => t.role)).toEqual(['user', 'assistant']);
  });

  it('drops turns that would render empty', () => {
    const turns = toTurns([human('m0', '   '), human('m1', 'real')], ALL_ON);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.source_uuid).toBe('m1');
  });

  it('keeps thinking summaries and prefers them over empty thinking text', () => {
    // `thinking` is empty whenever summaries exist; summaries are the
    // user-visible form.
    const turns = toTurns(
      [
        assistant('m1', 'm0', [
          {
            type: 'thinking',
            thinking: '',
            summaries: [{ summary: 'Explaining X.' }],
            cut_off: false,
            truncated: true,
            hidden: false,
            thinking_hidden: true,
          },
        ]),
      ],
      ALL_ON,
    );
    const b = turns[0]?.blocks[0];
    expect(b?.type).toBe('thinking');
    expect(b?.type === 'thinking' && b.thinking).toBe('Explaining X.');
  });

  it('keeps blank thinking only when there is no summary to fall back on', () => {
    const turns = toTurns(
      [assistant('m1', 'm0', [{ type: 'thinking', thinking: 'reasoning', summaries: [] }])],
      ALL_ON,
    );
    const b = turns[0]?.blocks[0];
    expect(b?.type === 'thinking' && b.thinking).toBe('reasoning');
  });

  it('strips thinking when includeThinking is false', () => {
    const turns = toTurns(
      [
        assistant('m1', 'm0', [
          { type: 'thinking', thinking: 'secret', summaries: [] },
          { type: 'text', text: 'answer', citations: [] },
        ]),
      ],
      { ...ALL_ON, includeThinking: false },
    );
    expect(turns[0]?.blocks.map((b) => b.type)).toEqual(['text']);
  });

  it('strips tool blocks when includeTools is false', () => {
    const turns = toTurns(
      [
        assistant('m1', 'm0', [
          { type: 'tool_use', id: 't1', name: 'WebSearch', input: { q: 'x' } },
          { type: 'tool_result', tool_use_id: 't1', content: 'result', is_error: false },
          { type: 'text', text: 'done', citations: [] },
        ]),
      ],
      { ...ALL_ON, includeTools: false },
    );
    expect(turns[0]?.blocks.map((b) => b.type)).toEqual(['text']);
  });

  it('preserves tool identity and payload rather than flattening them', () => {
    const turns = toTurns(
      [
        assistant('m1', 'm0', [
          { type: 'tool_use', id: 't1', name: 'WebSearch', input: { q: 'x' } },
          { type: 'tool_result', tool_use_id: 't1', content: { hits: 2 }, is_error: true },
        ]),
      ],
      ALL_ON,
    );
    const [use, result] = turns[0]!.blocks;
    expect(use).toMatchObject({ type: 'tool_use', id: 't1', name: 'WebSearch', input: { q: 'x' } });
    // A non-string tool result is stringified so it survives as text.
    expect(result?.type === 'tool_result' && result.is_error).toBe(true);
    expect(result?.type === 'tool_result' && result.content).toContain('"hits": 2');
  });

  it('converts files into not-transferred placeholders', () => {
    const turns = toTurns(
      [
        {
          ...human('m0', 'look at this'),
          files: [{ file_uuid: 'f1', file_name: 'report.pdf', size_bytes: 440_139 }],
        },
      ],
      ALL_ON,
    );
    const b = turns[0]?.blocks[1];
    expect(b?.type).toBe('file');
    expect(b?.type === 'file' && b.note).toBe('not-transferred');
    expect(b?.type === 'file' && b.file_name).toBe('report.pdf');
    expect(b?.type === 'file' && b.size_bytes).toBe(440_139);
  });

  it('omits file placeholders when the option is off', () => {
    const turns = toTurns(
      [{ ...human('m0', 'look'), files: [{ file_uuid: 'f1', file_name: 'r.pdf' }] }],
      { ...ALL_ON, includeFilePlaceholders: false },
    );
    expect(turns[0]?.blocks.map((b) => b.type)).toEqual(['text']);
  });

  it('names an unnamed attachment rather than losing it', () => {
    const turns = toTurns([{ ...human('m0', 'x'), files: [{ file_uuid: 'f1' }] }], ALL_ON);
    expect(turns[0]?.blocks[1]?.type === 'file' && turns[0].blocks[1].file_name).toBe('attachment');
  });

  it('truncates oversized blocks with a marker', () => {
    const turns = toTurns(
      [
        assistant('m1', 'm0', [
          { type: 'tool_result', tool_use_id: 't', content: 'x'.repeat(500), is_error: false },
        ]),
      ],
      { ...ALL_ON, maxCharsPerBlock: 100 },
    );
    const b = turns[0]?.blocks[0];
    expect(b?.type === 'tool_result' && String(b.content)).toContain(
      '[truncated by Session Transfer]',
    );
  });

  it('carries the model and stop reason onto each turn', () => {
    const turns = toTurns([assistant('m1', 'm0', [{ type: 'text', text: 'x', citations: [] }])], {
      ...ALL_ON,
      model: 'claude-sonnet-5-5',
    });
    expect(turns[0]).toMatchObject({ model: 'claude-sonnet-5-5', stop_reason: 'end_turn' });
  });
});