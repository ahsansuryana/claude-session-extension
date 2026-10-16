import { describe, expect, it } from 'vitest';
import { parseRoute } from '../src/content/router';
import { bundleFilename, slugify } from '../src/content/download';

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

describe('bundleFilename', () => {
  it('names the file after the session', () => {
    expect(bundleFilename('Contoh soal yang membingungkan')).toBe(
      'contoh-soal-yang-membingungkan.claude-session.json',
    );
  });

  it('collapses punctuation and trims dashes', () => {
    expect(bundleFilename('My session!')).toBe('my-session.claude-session.json');
    expect(bundleFilename('  --Hello!! World--  ')).toBe('hello-world.claude-session.json');
  });

  it('falls back when there is nothing usable', () => {
    expect(bundleFilename('!!!')).toBe('session.claude-session.json');
  });

  it('caps the slug without leaving a trailing dash', () => {
    const name = slugify('a'.repeat(200));
    expect(name.length).toBeLessThanOrEqual(60);
    expect(name).toBe('a'.repeat(60));
  });

  it('strips diacritics', () => {
    expect(bundleFilename('Café Réunion')).toBe('cafe-reunion.claude-session.json');
  });
});
