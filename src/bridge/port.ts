/**
 * ISOLATED-world half of the bridge.
 *
 * The content script owns the UI and `chrome.*`; the MAIN world owns `fetch`.
 * They can only talk through `window.postMessage`, so every call is a
 * request/response pair keyed by a unique id.
 *
 * Both halves live on claude.ai's page, so the message channel is not private.
 * The `channel` discriminator keeps us from reacting to the app's own messages,
 * and ids are unguessable; responses are only accepted from `window` itself.
 */

import {
  RPC_CHANNEL,
  isRpcResponse,
  RpcError,
  type RpcOp,
  type RpcRequest,
  type RpcResponse,
} from '../types/protocol';

const DEFAULT_TIMEOUT_MS = 120_000;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: RpcError) => void;
  timer: ReturnType<typeof setTimeout>;
  op: RpcOp;
}

const pending = new Map<string, Pending>();
let installed = false;

function newId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export class BridgeUnavailableError extends Error {
  constructor() {
    super(
      'The Session Transfer page bridge is not running. Reload this tab (the ' +
        'MAIN-world script may have been blocked).',
    );
    this.name = 'BridgeUnavailableError';
  }
}

export function isBridgeListening(): boolean {
  return installed;
}

/** Install once; returns the uninstall function. */
export function installBridge(): () => void {
  if (installed) return () => undefined;
  installed = true;

  const onMessage = (event: MessageEvent): void => {
    if (event.source !== window) return;
    const data: unknown = event.data;
    if (!isRpcResponse(data)) return;
    const message = data as RpcResponse;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.ok) entry.resolve(message.data);
    else entry.reject(new RpcError(message.error ?? { message: 'unknown error' }));
  };

  window.addEventListener('message', onMessage);

  return () => {
    window.removeEventListener('message', onMessage);
    installed = false;
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new RpcError({ message: 'bridge torn down' }));
    }
    pending.clear();
  };
}

/**
 * Call a MAIN-world operation.
 *
 * Rejects with `RpcError` (carrying `code`, e.g. `exceeded_limit`) when the
 * remote call fails, or with `BridgeUnavailableError` on timeout - which in
 * practice means the MAIN-world script never loaded.
 */
export function call<T>(
  op: RpcOp,
  payload: unknown,
  opts: { timeoutMs?: number } = {},
): Promise<T> {
  const id = newId();
  const request: RpcRequest = { channel: RPC_CHANNEL, kind: 'req', id, op, payload };

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new BridgeUnavailableError());
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    pending.set(id, {
      resolve: resolve as (value: unknown) => void,
      reject,
      timer,
      op,
    });

    window.postMessage(request, window.location.origin);
  });
}

/** How many calls are still in flight. Exposed for tests and diagnostics. */
export function inFlightCount(): number {
  return pending.size;
}

/** Ops exposed for type-safe call sites. */
export type BridgeOp = RpcOp;