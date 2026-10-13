/**
 * Wire format between the ISOLATED-world content script (owns the UI and
 * `chrome.*`) and the MAIN-world script (owns `fetch`, runs in the claude.ai
 * origin so session cookies are attached and no CORS preflight is needed).
 *
 * Both worlds load separate bundles and cannot import each other, so this file
 * must stay dependency-free and side-effect-free.
 */

export const RPC_CHANNEL = 'claude-session-transfer' as const;

export type RpcOp =
  | 'bootstrap'
  | 'resolveActiveOrg'
  | 'listConversations'
  | 'getConversation'
  | 'getUsage'
  | 'createConversation'
  | 'updateConversation'
  | 'complete'
  | 'deleteConversations';

export interface RpcRequest {
  channel: typeof RPC_CHANNEL;
  kind: 'req';
  id: string;
  op: RpcOp;
  payload: unknown;
}

export interface RpcFailure {
  message: string;
  status?: number;
  requestId?: string;
  /** e.g. `exceeded_limit` - callers special-case this. */
  code?: string;
}

export interface RpcResponse {
  channel: typeof RPC_CHANNEL;
  kind: 'res';
  id: string;
  ok: boolean;
  data?: unknown;
  error?: RpcFailure;
}

/**
 * `complete` streams SSE, so the MAIN world posts partial responses with the
 * same id and `done: false`, then one final response with `done: true`.
 */
export interface RpcProgressResponse {
  channel: typeof RPC_CHANNEL;
  kind: 'progress';
  id: string;
  event: string;
}

const OPS: ReadonlySet<string> = new Set<RpcOp>([
  'bootstrap',
  'resolveActiveOrg',
  'listConversations',
  'getConversation',
  'getUsage',
  'createConversation',
  'updateConversation',
  'complete',
  'deleteConversations',
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

export function isRpcRequest(data: unknown): data is RpcRequest {
  return (
    isRecord(data) &&
    data.channel === RPC_CHANNEL &&
    data.kind === 'req' &&
    typeof data.id === 'string' &&
    typeof data.op === 'string' &&
    OPS.has(data.op)
  );
}

export function isRpcResponse(data: unknown): data is RpcResponse {
  return (
    isRecord(data) &&
    data.channel === RPC_CHANNEL &&
    data.kind === 'res' &&
    typeof data.id === 'string' &&
    typeof data.ok === 'boolean'
  );
}

export function isRpcProgress(data: unknown): data is RpcProgressResponse {
  return (
    isRecord(data) &&
    data.channel === RPC_CHANNEL &&
    data.kind === 'progress' &&
    typeof data.id === 'string' &&
    typeof data.event === 'string'
  );
}

export class RpcError extends Error {
  readonly status: number | undefined;
  readonly code: string | undefined;
  readonly requestId: string | undefined;

  constructor(failure: RpcFailure) {
    super(failure.message);
    this.name = 'RpcError';
    this.status = failure.status;
    this.code = failure.code;
    this.requestId = failure.requestId;
  }
}

export function toRpcFailure(err: unknown): RpcFailure {
  if (err && typeof err === 'object') {
    const e = err as {
      message?: unknown;
      status?: unknown;
      code?: unknown;
      requestId?: unknown;
    };
    return {
      message: typeof e.message === 'string' ? e.message : String(err),
      status: typeof e.status === 'number' ? e.status : undefined,
      code: typeof e.code === 'string' ? e.code : undefined,
      requestId: typeof e.requestId === 'string' ? e.requestId : undefined,
    };
  }
  return { message: String(err) };
}