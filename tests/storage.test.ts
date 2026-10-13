import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ExtensionGoneError,
  isExtensionGone,
  storageGet,
  storageRemove,
  storageSet,
} from '../src/core/storage';

/**
 * When the extension is reloaded from `chrome://extensions`, every content
 * script in an open tab is orphaned and its `chrome.*` calls reject. Those
 * rejections surfaced as uncaught errors; the wrappers must convert them.
 */
function installStorage(
  behaviour?: (op: string) => 'ok' | 'dead',
): Map<string, unknown> {
  const mem = new Map<string, unknown>();
  const dead = () => behaviour?.(op) === 'dead';
  let op = '';

  (globalThis as Record<string, unknown>).chrome = {
    storage: {
      local: {
        async get(k: string | string[] | null) {
          op = 'get';
          if (dead()) throw new Error('Extension context invalidated.');
          const list = k === null ? [...mem.keys()] : Array.isArray(k) ? k : [k];
          const out: Record<string, unknown> = {};
          for (const x of list) if (mem.has(x)) out[x] = mem.get(x);
          return out;
        },
        async set(items: Record<string, unknown>) {
          op = 'set';
          if (dead()) throw new Error('Extension context invalidated.');
          for (const [k, v] of Object.entries(items)) mem.set(k, v);
        },
        async remove(k: string | string[]) {
          op = 'remove';
          if (dead()) throw new Error('Extension context invalidated.');
          for (const x of Array.isArray(k) ? k : [k]) mem.delete(x);
        },
      },
    },
  };
  return mem;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isExtensionGone', () => {
  it('recognises the platform message', () => {
    expect(isExtensionGone(new Error('Extension context invalidated.'))).toBe(true);
    expect(isExtensionGone({ message: 'Receiving end does not exist' })).toBe(true);
  });

  it('leaves unrelated errors alone', () => {
    expect(isExtensionGone(new Error('disk on fire'))).toBe(false);
    expect(isExtensionGone(null)).toBe(false);
  });

  it('recognises its own error type', () => {
    expect(isExtensionGone(new ExtensionGoneError())).toBe(true);
  });
});

describe('storage wrappers', () => {
  beforeEach(() => {
    installStorage();
  });

  it('round-trips values', async () => {
    await storageSet({ a: 1 });
    expect((await storageGet('a')).a).toBe(1);
    await storageRemove('a');
    expect((await storageGet('a')).a).toBeUndefined();
  });

  it('converts a dead context into ExtensionGoneError on every method', async () => {
    vi.stubGlobal(
      'chrome',
      {
        storage: {
          local: {
            get: async () => {
              throw new Error('Extension context invalidated.');
            },
            set: async () => {
              throw new Error('Extension context invalidated.');
            },
            remove: async () => {
              throw new Error('Extension context invalidated.');
            },
          },
        },
      },
    );

    for (const call of [storageGet('x'), storageSet({ x: 1 }), storageRemove('x')]) {
      await expect(call).rejects.toBeInstanceOf(ExtensionGoneError);
    }
    // The message must tell the user what to actually do.
    await expect(storageGet('x')).rejects.toThrow(/Reload this tab/);
  });

  it('converts a missing chrome API into ExtensionGoneError', async () => {
    vi.stubGlobal('chrome', {});
    await expect(storageGet('x')).rejects.toBeInstanceOf(ExtensionGoneError);
    await expect(storageSet({})).rejects.toBeInstanceOf(ExtensionGoneError);
    await expect(storageRemove('x')).rejects.toBeInstanceOf(ExtensionGoneError);
  });

  it('passes unrelated storage errors through unchanged', async () => {
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: async () => {
            throw new Error('QUOTA_BYTES quota exceeded');
          },
        },
      },
    });
    await expect(storageGet('x')).rejects.toThrow(/QUOTA_BYTES/);
    await expect(storageGet('x')).rejects.not.toBeInstanceOf(ExtensionGoneError);
  });
});