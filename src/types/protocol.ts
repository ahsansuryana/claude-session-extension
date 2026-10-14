/**
 * Wire format between the ISOLATED-world content script (owns the UI and
 * `chrome.*`) and the MAIN-world script (owns `fetch`, runs in the claude.ai
 * origin so session cookies are attached and no CORS preflight is needed).
 *
 * Both worlds load separate bundles and cannot import each other, so this file
 * must stay dependency-free and side-effect-free.
 */

export const RPC_CHANNEL = 'claude-session-transfer' as const;

/** Only two calls remain in the save-only build. */
export type RpcOp = 'resolveActiveOrg' | 'getConversation';

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
  /** e.g. `exceeded_limit`, `not_found`, `invalid_request`. */
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

const OPS: ReadonlySet<string> = new Set<RpcOp>(['resolveActiveOrg', 'getConversation']);

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
    const e = err as { message?: unknown; status?: unknown; code?: unknown; requestId?: unknown };
    return {
      message: typeof e.message === 'string' ? e.message : String(err),
      status: typeof e.status === 'number' ? e.status : undefined,
      code: typeof e.code === 'string' ? e.code : undefined,
      requestId: typeof e.requestId === 'string' ? e.requestId : undefined,
    };
  }
  return { message: String(err) };
}
