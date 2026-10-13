/**
 * MAIN-world half of the bridge.
 *
 * Runs in claude.ai's own JS context (manifest `world: "MAIN"`), so `fetch` is
 * a genuine same-origin request: the first-party session cookies are attached
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
  type RpcOp,
  type RpcRequest,
  type RpcResponse,
} from '../types/protocol';

const api = new ClaudeApiClient();

/** Reads one required string, so a malformed payload cannot reach the client. */
function req(payload: unknown, key: string): string {
  const value = (payload as Record<string, unknown> | null)?.[key];
  if (typeof value !== 'string' || !value) {
    throw new Error(`missing required field "${key}"`);
  }
  return value;
}

function opt(payload: unknown, key: string): unknown {
  return (payload as Record<string, unknown> | null)?.[key];
}

async function dispatch(req_: RpcRequest, client: ClaudeApiClient): Promise<unknown> {
  const { op, payload } = req_;

  switch (op) {
    case 'bootstrap':
      return client.bootstrap();

    case 'resolveActiveOrg':
      return client.resolveActiveOrg();

    case 'listConversations': {
      const listOpts = opt(payload, 'options') as
        | { limit?: number; offset?: number; archived?: boolean }
        | undefined;
      return client.listConversations(req(payload, 'org'), listOpts ?? {});
    }

    case 'getConversation':
      return client.getConversation(req(payload, 'org'), req(payload, 'uuid'));

    case 'getUsage':
      return client.getUsage(req(payload, 'org'));

    case 'createConversation': {
      const input = opt(payload, 'input') as { name?: string; model?: string } | undefined;
      if (!input?.name || !input.model) throw new Error('createConversation needs name and model');
      return client.createConversation(req(payload, 'org'), {
        name: input.name,
        model: input.model,
      });
    }

    case 'updateConversation': {
      const patch = opt(payload, 'patch') as
        | { name?: string; is_archived?: boolean; is_starred?: boolean }
        | undefined;
      if (!patch) throw new Error('updateConversation needs a patch');
      return client.updateConversation(req(payload, 'org'), req(payload, 'uuid'), patch);
    }

    case 'deleteConversations': {
      const uuids = opt(payload, 'uuids');
      if (!Array.isArray(uuids) || uuids.length === 0) {
        throw new Error('deleteConversations needs a non-empty uuids array');
      }
      return client.deleteConversations(
        req(payload, 'org'),
        uuids.filter((u): u is string => typeof u === 'string'),
      );
    }

    case 'complete': {
      const input = opt(payload, 'input') as
        | { prompt?: string; parentMessageUuid?: string; model?: string }
        | undefined;
      if (!input?.prompt || !input.parentMessageUuid || !input.model) {
        throw new Error('complete needs prompt, parentMessageUuid and model');
      }
      return client.complete(req(payload, 'org'), req(payload, 'uuid'), {
        prompt: input.prompt,
        parentMessageUuid: input.parentMessageUuid,
        model: input.model,
      });
    }

    default: {
      const never: never = op;
      throw new Error(`unsupported op ${String(never)}`);
    }
  }
}

function post(message: RpcResponse): void {
  window.postMessage(message, window.location.origin);
}

export function installRpcHandler(client: ClaudeApiClient = api): () => void {
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

export type { RpcOp };