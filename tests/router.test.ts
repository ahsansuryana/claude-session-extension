import { describe, expect, it } from 'vitest';
import { parseRoute } from '../src/content/router';
import { markdownFilename } from '../src/core/markdown';

describe('parseRoute', () => {
  const uuid = '471bbd5c-3d8e-4fd5-a1f7-c36344b5fd41';

  it('recognises a chat route', () => {
    expect(parseRoute(`/chat/${uuid}`)).toEqual({ kind: 'chat', conversationUuid: uuid });
  });

  it('tolerates a trailing slash', () => {
    expect(parseRoute(`/chat/${uuid}/`).kind).toBe('chat');
  });

  it('recognises the new-chat route', () => {
    expect(parseRoute('/new')).toEqual({ kind: 'new', conversationUuid: null });
  });

  it('does not treat a non-uuid chat path as a conversation', () => {
    // The save button must not be enabled on /chat/garbage.
    expect(parseRoute('/chat/abc').kind).toBe('other');
    expect(parseRoute('/chat/').kind).toBe('other');
  });

  it('falls through for unrelated paths', () => {
    expect(parseRoute('/projects/abc')).toEqual({ kind: 'other', conversationUuid: null });
    expect(parseRoute('/')).toEqual({ kind: 'other', conversationUuid: null });
  });
});

describe('markdownFilename', () => {
  it('uses the session name', () => {
    expect(markdownFilename('Contoh soal yang membingungkan')).toBe(
      'contoh-soal-yang-membingungkan.md',
    );
  });

  it('collapses punctuation into dashes', () => {
    expect(markdownFilename('My session!')).toBe('my-session.md');
  });

  it('trims leading and trailing dashes', () => {
    expect(markdownFilename('  --Hello!! World--  ')).toBe('hello-world.md');
  });

  it('falls back when there is nothing usable', () => {
    expect(markdownFilename('!!!')).toBe('claude-session.md');
    expect(markdownFilename(undefined)).toBe('claude-session.md');
    expect(markdownFilename('')).toBe('claude-session.md');
  });

  it('caps length at 60 characters without a trailing dash', () => {
    const name = markdownFilename('a'.repeat(200));
    expect(name.length).toBeLessThanOrEqual(63); // 60 + '.md'
    expect(name.endsWith('.md')).toBe(true);
  });

  it('strips diacritics', () => {
    expect(markdownFilename('Café Réunion')).toBe('cafe-reunion.md');
  });
});
