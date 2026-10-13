/**
 * `chrome.storage` access, wrapped.
 *
 * Every call site would otherwise have to handle the same failure: when the
 * extension is reloaded from `chrome://extensions`, the service worker and
 * content scripts in already-open tabs are orphaned. Their extension context is
 * dead and every `chrome.*` call rejects with
 * "Extension context invalidated." Those rejections surface as uncaught errors
 * on every wake.
 *
 * These wrappers detect that specific condition and surface it as
 * `ExtensionGoneError` so callers can say "reload the tab" instead of leaking a
 * raw platform error.
 */

export class ExtensionGoneError extends Error {
  constructor() {
    super(
      'The extension was reloaded or updated. Reload this tab to use Session Transfer again.',
    );
    this.name = 'ExtensionGoneError';
  }
}

export function isExtensionGone(error: unknown): boolean {
  return (
    error instanceof ExtensionGoneError ||
    (typeof error === 'object' &&
      error !== null &&
      /extension context invalidated|receiving end does not exist/i.test(
        String((error as { message?: unknown }).message ?? ''),
      ))
  );
}

function local(): chrome.storage.LocalStorageArea {
  const area = chrome?.storage?.local;
  if (!area) throw new ExtensionGoneError();
  return area;
}

/** Run a `chrome.storage` call, converting a dead extension context into a typed error. */
async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (isExtensionGone(error)) throw new ExtensionGoneError();
    throw error;
  }
}

export async function storageGet(keys: string | string[] | null): Promise<Record<string, unknown>> {
  return guard(() => local().get(keys));
}

export async function storageSet(items: Record<string, unknown>): Promise<void> {
  return guard(() => local().set(items));
}

export async function storageRemove(keys: string | string[]): Promise<void> {
  return guard(() => local().remove(keys));
}