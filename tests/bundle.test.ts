import { describe, expect, it } from 'vitest';
import {
  BundleError,
  buildBundle,
  estimateChars,
  isSessionBundle,
  migrateBundle,
  parseBundle,
  summarize,
} from '../src/core/bundle';
import type { ClaudeConversation } from '../src/types/claude';
import type { SessionBundle, SessionSource } from '../src/types/session';
import { ROOT_MESSAGE_UUID, SESSION_FORMAT } from '../src/types/session';

const source: SessionSource = {
  account_uuid: 'acct',
  account_email: 'a@b.c',
  organization_uuid: 'org',
  organization_name: 'Org',
  conversation_uuid: 'c1',
  conversation_name: 'Original name',
  model: 'claude-sonnet-5-5',
  created_at: '2026-10-13T02:56:00Z',
  updated_at: '2026-10-13T02:56:40Z',
  url: 'https://claude.ai/chat/c1',
};

function conversation(overrides: Partial<ClaudeConversation> = {}): ClaudeConversation {
  return {
    uuid: 'c1',
    name: 'Original name',
    model: 'claude-sonnet-5-5',
    current_leaf_message_uuid: 'm1',
    chat_messages: [
      {
        uuid: 'm0',
        sender: 'human',
        created_at: '2026-10-13T02:56:05Z',
        parent_message_uuid: ROOT_MESSAGE_UUID,
        content: [{ type: 'text', text: 'question', citations: [] }],
      },
      {
        uuid: 'm1',
        sender: 'assistant',
        created_at: '2026-10-13T02:56:07Z',
        parent_message_uuid: 'm0',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'answer', citations: [] }],
      },
    ],
    ...overrides,
  };
}

const OPTS = {
  includeThinking: true,
  includeTools: true,
  includeFilePlaceholders: true,
} as const;

describe('buildBundle', () => {
  it('produces a bundle from the active branch only', () => {
    const b = buildBundle({ conversation: conversation(), source, ...OPTS });
    expect(b.format).toBe(SESSION_FORMAT);
    expect(b.version).toBe(1);
    expect(b.turns).toHaveLength(2);
    expect(b.turns[0]).toMatchObject({ index: 0, role: 'user' });
    expect(b.turns[1]).toMatchObject({ index: 1, role: 'assistant' });
    expect(b.stats.message_count).toBe(2);
  });

  it('defaults the session name to the conversation name', () => {
    expect(buildBundle({ conversation: conversation(), source, ...OPTS }).session_name).toBe(
      'Original name',
    );
  });

  it('uses the user-supplied name', () => {
    const b = buildBundle({
      conversation: conversation(),
      source,
      sessionName: 'Renamed',
      ...OPTS,
    });
    expect(b.session_name).toBe('Renamed');
  });

  it('falls back when the supplied name is blank', () => {
    const b = buildBundle({ conversation: conversation(), source, sessionName: '   ', ...OPTS });
    expect(b.session_name).toBe('Original name');
  });

  it('counts abandoned branches separately from exported turns', () => {
    // Two roots: only the leaf branch belongs in the export.
    const conv = conversation({
      current_leaf_message_uuid: 'm3',
      chat_messages: [
        { uuid: 'm0', sender: 'human', created_at: '', parent_message_uuid: ROOT_MESSAGE_UUID, content: [{ type: 'text', text: 'a', citations: [] }] },
        { uuid: 'm1', sender: 'assistant', created_at: '', parent_message_uuid: 'm0', content: [{ type: 'text', text: 'b', citations: [] }] },
        { uuid: 'm2', sender: 'human', created_at: '', parent_message_uuid: ROOT_MESSAGE_UUID, content: [{ type: 'text', text: 'c', citations: [] }] },
        { uuid: 'm3', sender: 'assistant', created_at: '', parent_message_uuid: 'm2', content: [{ type: 'text', text: 'd', citations: [] }] },
      ],
    });
    const b = buildBundle({ conversation: conv, source, ...OPTS });
    expect(b.turns).toHaveLength(2);
    expect(b.stats.branch_count).toBe(2);
    expect(b.turns[0]?.blocks[0]).toMatchObject({ text: 'c' });
  });

  it('records omitted files in stats', () => {
    const conv = conversation({
      chat_messages: [
        {
          uuid: 'm0',
          sender: 'human',
          created_at: '',
          parent_message_uuid: ROOT_MESSAGE_UUID,
          files: [
            { file_uuid: 'f', file_name: 'a.pdf' },
            { file_uuid: 'g', file_name: 'b.pdf' },
          ],
          content: [{ type: 'text', text: 'see files', citations: [] }],
        },
      ],
      current_leaf_message_uuid: 'm0',
    });
    expect(buildBundle({ conversation: conv, source, ...OPTS }).stats.omitted_files).toBe(2);
  });

  it('fills stats.chars from the bundle contents', () => {
    const b = buildBundle({ conversation: conversation(), source, ...OPTS });
    expect(b.stats.chars).toBe(estimateChars(b));
    expect(b.stats.chars).toBeGreaterThan(0);
  });

  it('stamps an explicit exported_at when asked', () => {
    const b = buildBundle({
      conversation: conversation(),
      source,
      exportedAt: '2026-10-14T00:00:00Z',
      ...OPTS,
    });
    expect(b.exported_at).toBe('2026-10-14T00:00:00Z');
  });

  it('propagates a TreeError for an unresolvable branch', () => {
    const conv = conversation({ current_leaf_message_uuid: 'ghost' });
    expect(() => buildBundle({ conversation: conv, source, ...OPTS })).toThrow();
  });
});

describe('isSessionBundle', () => {
  it('accepts a built bundle', () => {
    expect(isSessionBundle(buildBundle({ conversation: conversation(), source, ...OPTS }))).toBe(
      true,
    );
  });

  it('rejects foreign shapes', () => {
    for (const bad of [null, 'string', 42, {}, { format: 'other', version: 1, session_name: '', turns: [] }]) {
      expect(isSessionBundle(bad)).toBe(false);
    }
  });
});

describe('parseBundle', () => {
  it('round-trips a built bundle through JSON', () => {
    const b = buildBundle({ conversation: conversation(), source, ...OPTS });
    const parsed = parseBundle(JSON.stringify(b));
    expect(parsed.turns).toEqual(b.turns);
    expect(parsed.session_name).toBe(b.session_name);
    expect(parsed.stats).toEqual(b.stats);
  });

  it('rejects non-JSON', () => {
    expect(() => parseBundle('{nope')).toThrow(BundleError);
    try {
      parseBundle('{nope');
    } catch (e) {
      expect((e as BundleError).code).toBe('bad_json');
    }
  });

  it('rejects a foreign JSON file', () => {
    try {
      parseBundle(JSON.stringify({ hello: 'world' }));
      expect.unreachable('should throw');
    } catch (e) {
      expect((e as BundleError).code).toBe('bad_format');
    }
  });

  it('rejects a bundle from a newer extension version', () => {
    const b = buildBundle({ conversation: conversation(), source, ...OPTS });
    try {
      parseBundle(JSON.stringify({ ...b, version: 99 }));
      expect.unreachable('should throw');
    } catch (e) {
      expect((e as BundleError).code).toBe('bad_version');
      expect((e as Error).message).toMatch(/newer version/);
    }
  });

  it('rejects an empty transcript', () => {
    const b = buildBundle({ conversation: conversation(), source, ...OPTS });
    try {
      parseBundle(JSON.stringify({ ...b, turns: [] }));
      expect.unreachable('should throw');
    } catch (e) {
      expect((e as BundleError).code).toBe('empty_session');
    }
  });

  it('rejects a non-object', () => {
    expect(() => parseBundle('"a string"')).toThrow(BundleError);
  });
});

describe('migrateBundle', () => {
  const base: SessionBundle = buildBundle({ conversation: conversation(), source, ...OPTS });

  it('upgrades v0 by defaulting omitted_files', () => {
    const { omitted_files: _drop, ...stats } = base.stats;
    const out = migrateBundle({
      ...base,
      version: 0,
      stats: stats as SessionBundle['stats'],
    });
    expect(out.version).toBe(1);
    expect(out.stats.omitted_files).toBe(0);
  });

  it('renumbers turns defensively', () => {
    const out = migrateBundle({
      ...base,
      turns: base.turns.map((t, i) => ({ ...t, index: 50 - i, role: 'assistant' as const })),
    });
    expect(out.turns.map((t) => t.index)).toEqual([0, 1]);
    expect(out.turns.every((t) => t.role === 'assistant')).toBe(true);
  });

  it('repairs a blank session name from the source', () => {
    expect(migrateBundle({ ...base, session_name: '   ' }).session_name).toBe('Original name');
  });

  it('rebuilds a missing stats object', () => {
    const out = migrateBundle({ ...base, stats: undefined as never });
    expect(out.stats.message_count).toBe(base.turns.length);
  });

  it('repairs turns whose blocks are missing', () => {
    const broken = { ...base, turns: [{ ...base.turns[0]!, blocks: undefined as never }] };
    expect(migrateBundle(broken).turns[0]?.blocks).toEqual([]);
  });

  it('rejects a missing source', () => {
    expect(() => migrateBundle({ ...base, source: undefined as never })).toThrow(BundleError);
  });
});

describe('summarize', () => {
  it('describes the turn count and size', () => {
    const b = buildBundle({ conversation: conversation(), source, ...OPTS });
    expect(summarize(b)).toContain('2 turns');
    expect(summarize(b)).toMatch(/~\d+k chars/);
  });

  it('singularises a one-turn session', () => {
    const conv = conversation({
      current_leaf_message_uuid: 'm0',
      chat_messages: [conversation().chat_messages![0]!],
    });
    expect(summarize(buildBundle({ conversation: conv, source, ...OPTS }))).toContain('1 turn ·');
  });

  it('says when files were left behind', () => {
    const conv = conversation({
      current_leaf_message_uuid: 'm0',
      chat_messages: [
        {
          ...conversation().chat_messages![0]!,
          files: [{ file_uuid: 'f', file_name: 'a.pdf' }],
        },
      ],
    });
    const line = summarize(buildBundle({ conversation: conv, source, ...OPTS }));
    expect(line).toContain('1 file not transferred');
  });
});