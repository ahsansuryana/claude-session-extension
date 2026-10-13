import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getImportProgress,
  onImportProgress,
  setImportProgress,
} from '../src/content/importState';
import type { ActiveImport } from '../src/content/importState';

/** Subscribers live in module state, so each test starts from a clean slate. */
const offs: Array<() => void> = [];
function subscribe(fn: (s: ActiveImport | null) => void): () => void {
  const off = onImportProgress(fn);
  offs.push(off);
  return off;
}

beforeEach(() => {
  setImportProgress(null);
});

afterEach(() => {
  while (offs.length) offs.pop()?.();
});

function state(over: Partial<ActiveImport> = {}): ActiveImport {
  return {
    sessionName: 'Test session',
    phase: 'importing',
    chunkIndex: 0,
    chunkTotal: 2,
    createdUuid: 'c1',
    error: null,
    paused: false,
    ...over,
  };
}

beforeEach(() => {
  setImportProgress(null);
});

describe('importState', () => {
  it('starts empty', () => {
    expect(getImportProgress()).toBeNull();
  });

  it('stores and clears the active import', () => {
    setImportProgress(state({ chunkIndex: 1 }));
    expect(getImportProgress()).toMatchObject({ chunkIndex: 1, chunkTotal: 2 });
    setImportProgress(null);
    expect(getImportProgress()).toBeNull();
  });

  it('notifies subscribers on every change', () => {
    const seen: Array<number | null> = [];
    const off = subscribe((s) => seen.push(s?.chunkIndex ?? null));
    setImportProgress(state({ chunkIndex: 1 }));
    setImportProgress(state({ chunkIndex: 2 }));
    setImportProgress(null);
    off();
    expect(seen).toEqual([null, 1, 2, null]);
  });

  it('emits the current value immediately on subscribe', () => {
    // The dock mounts after an import may already be running.
    setImportProgress(state({ chunkIndex: 1 }));
    const seen: Array<number | null> = [];
    subscribe((s) => seen.push(s?.chunkIndex ?? null));
    expect(seen).toEqual([1]);
  });

  it('stops notifying after unsubscribe', () => {
    const seen: Array<number | null> = [];
    const off = subscribe((s) => seen.push(s?.chunkIndex ?? null));
    off();
    setImportProgress(state({ chunkIndex: 5 }));
    expect(seen).toEqual([null]);
  });

  it('isolates a throwing subscriber', () => {
    const good = vi.fn();
    const off1 = subscribe(() => {
      throw new Error('broken subscriber');
    });
    const off2 = subscribe(good);
    expect(() => setImportProgress(state())).not.toThrow();
    expect(good).toHaveBeenCalled();
    off1();
    off2();
  });

  it('carries the paused flag used by the dock strip', () => {
    setImportProgress(state({ phase: 'paused', paused: true, chunkIndex: 1 }));
    expect(getImportProgress()).toMatchObject({ phase: 'paused', paused: true });
  });
});