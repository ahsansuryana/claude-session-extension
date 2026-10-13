import type { ImportPhase } from './importRunner';

/**
 * Progress channel for an import that outlives the dialog.
 *
 * Navigation to `/chat/{uuid}` happens as soon as the conversation exists -
 * matching how claude.ai itself jumps to `/chat/{uuid}` the moment a turn is
 * sent. The import then keeps streaming, so its progress has to survive the
 * page navigation and be rendered by the dock instead.
 *
 * The store is module state inside the content-script bundle, so it lives
 * exactly as long as the tab does.
 */

export interface ActiveImport {
  sessionName: string;
  phase: ImportPhase;
  chunkIndex: number;
  chunkTotal: number;
  createdUuid: string;
  error: string | null;
  /** True when paused by a quota wall and waiting to be resumed. */
  paused: boolean;
}

let current: ActiveImport | null = null;
const listeners = new Set<(state: ActiveImport | null) => void>();

function notify(listener: (state: ActiveImport | null) => void, state: ActiveImport | null): void {
  try {
    listener(state);
  } catch {
    /* a broken subscriber must not break the others, nor the one subscribing */
  }
}

export function setImportProgress(next: ActiveImport | null): void {
  current = next;
  for (const listener of listeners) notify(listener, current);
}

export function getImportProgress(): ActiveImport | null {
  return current;
}

/** Subscribe to progress changes. Returns an unsubscribe function. */
export function onImportProgress(
  listener: (state: ActiveImport | null) => void,
): () => void {
  listeners.add(listener);
  notify(listener, current);
  return () => listeners.delete(listener);
}