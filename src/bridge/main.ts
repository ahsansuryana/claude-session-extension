/**
 * MAIN-world half of the bridge.
 *
 * Runs in claude.ai's own JS context (manifest `world: "MAIN"`), so `fetch` is
 * a genuine same-origin request: first-party session cookies are attached
 * automatically and there is no CORS preflight. This is the only context where
 * the claude.ai API is reachable, so every network call funnels through here.
 *
 * This bundle must never touch `chrome.*` (unavailable in this world) or the DOM.
 */

import { ClaudeApiClient } from '../core/api';
import {
  RPC_CHANNEL,
  isRpcRequest,
  toRpcFailure,
  type RpcRequest,
  type RpcResponse,
} from '../types/protocol';

function req(payload: unknown, key: string): string {
  const value = (payload as Record<string, unknown> | null)?.[key];
  if (typeof value !== 'string' || !value) {
    throw new Error(`missing required field "${key}"`);
  }
  return value;
}

async function dispatch(req_: RpcRequest, client: ClaudeApiClient): Promise<unknown> {
  const { op, payload } = req_;

  switch (op) {
    case 'resolveActiveOrg':
      return client.resolveActiveOrg();

    case 'getConversation':
      return client.getConversation(req(payload, 'org'), req(payload, 'uuid'));

    default: {
      const never: never = op;
      throw new Error(`unsupported op ${String(never)}`);
    }
  }
}

function post(message: RpcResponse): void {
  window.postMessage(message, window.location.origin);
}

export function installRpcHandler(client: ClaudeApiClient = new ClaudeApiClient()): () => void {
  const onMessage = async (event: MessageEvent): Promise<void> => {
    if (event.source !== window) return;
    const data: unknown = event.data;
    if (!isRpcRequest(data)) return;

    try {
      const result = await dispatch(data, client);
      post({ channel: RPC_CHANNEL, kind: 'res', id: data.id, ok: true, data: result });
    } catch (error) {
      post({
        channel: RPC_CHANNEL,
        kind: 'res',
        id: data.id,
        ok: false,
        error: toRpcFailure(error),
      });
    }
  };

  window.addEventListener('message', onMessage);
  return () => window.removeEventListener('message', onMessage);
}

installRpcHandler();
