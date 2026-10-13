import { describe, expect, it } from 'vitest';
import { parseRoute } from '../src/content/router';
import { bundleFilename, slugify } from '../src/content/download';
import { ROOT_MESSAGE_UUID } from '../src/types/session';

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
    expect(parseRoute('/new/')).toEqual({ kind: 'new', conversationUuid: null });
  });

  it('does not treat a non-uuid chat path as a conversation', () => {
    expect(parseRoute('/chat/abc').kind).toBe('other');
    expect(parseRoute('/chat/').kind).toBe('other');
  });

  it('falls through for unrelated paths', () => {
    expect(parseRoute('/projects/abc')).toEqual({ kind: 'other', conversationUuid: null });
    expect(parseRoute('/')).toEqual({ kind: 'other', conversationUuid: null });
  });

  it('exports the root sentinel the importer parents first turns onto', () => {
    expect(ROOT_MESSAGE_UUID).toBe('00000000-0000-4000-8000-000000000000');
  });
});

describe('slugify', () => {
  it('lowercases and collapses punctuation', () => {
    expect(slugify('Bantuan latihan dan tugas dengan LaTeX')).toBe('bantuan-latihan-dan-tugas-dengan-latex');
  });

  it('trims leading and trailing dashes', () => {
    expect(slugify('  --Hello!! World--  ')).toBe('hello-world');
  });

  it('falls back for names with no usable characters', () => {
    expect(slugify('!!!')).toBe('session');
    expect(slugify('')).toBe('session');
  });

  it('caps length at 60 characters without a trailing dash', () => {
    const slug = slugify('a'.repeat(200));
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug.endsWith('-')).toBe(false);
  });

  it('strips diacritics', () => {
    expect(slugify('Café Réunion naïve')).toBe('cafe-reunion-naive');
  });

  it('builds a stable filename', () => {
    expect(bundleFilename('My session!')).toBe('my-session.claude-session.json');
  });
});