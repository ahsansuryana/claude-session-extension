import type {
  ClaudeBootstrap,
  ClaudeConversation,
  ClaudeConversationListItem,
  ClaudeUsage,
} from '../types/claude';
import type { SseEvent } from './sse';
import { parseSse } from './sse';

export const CLAUDE_ORIGIN = 'https://claude.ai';

/**
 * Paths claude.ai uses for conversation data, isolated here so a private-API
 * change is a single-file fix.
 *
 * Verified live 2026-10-13. Note the capital-T `tree=True` query param - the
 * plausible-looking `/tree?rendering_mode=raw` route does not exist (404).
 */
export const API = {
  bootstrap: '/api/bootstrap',
  organizations: '/api/organizations?beta=true',
  conversations: (org: string) => `/api/organizations/${org}/chat_conversations`,
  conversationsV2: (org: string) =>
    `/api/organizations/${org}/chat_conversations_v2`,
  conversation: (org: string, uuid: string) =>
    `/api/organizations/${org}/chat_conversations/${uuid}`,
  completion: (org: string, uuid: string) =>
    `/api/organizations/${org}/chat_conversations/${uuid}/completion`,
  deleteMany: (org: string) =>
    `/api/organizations/${org}/chat_conversations/delete_many`,
  usage: (org: string) => `/api/organizations/${org}/usage`,
} as const;

export const ROOT_MESSAGE_UUID = '00000000-0000-4000-8000-000000000000';

export interface ConversationListOptions {
  limit?: number;
  offset?: number;
  archived?: boolean;
}

export interface CompleteInput {
  prompt: string;
  parentMessageUuid: string;
  model: string;
  renderingMode?: 'messages';
}

export interface CompleteHandlers {
  onEvent?: (event: SseEvent) => void;
  signal?: AbortSignal;
}

export interface CompleteResult {
  /** uuid of the assistant message the turn produced. */
  assistantUuid: string;
  /**
   * uuid of the human message the turn produced (the assistant's `parent_uuid`).
   * This is what the next chunk must pass as `parent_message_uuid`.
   */
  humanUuid: string;
}

export class ClaudeApiError extends Error {
  readonly status: number | undefined;
  readonly requestId: string | undefined;
  /** `exceeded_limit`, `not_found`, `invalid_request`, ... */
  readonly code: string | undefined;

  constructor(
    message: string,
    opts: { status?: number; requestId?: string; code?: string } = {},
  ) {
    super(message);
    this.name = 'ClaudeApiError';
    this.status = opts.status;
    this.requestId = opts.requestId;
    this.code = opts.code;
  }

  /** True when the target profile is out of quota. Callers surface a resume CTA. */
  get isLimitExceeded(): boolean {
    return this.code === 'exceeded_limit';
  }
}

function requestIdOf(text: string): string | undefined {
  const m = /"request_id"\s*:\s*"([^"]+)"/.exec(text);
  return m?.[1];
}

function errorCodeOf(text: string): string | undefined {
  const m = /"type"\s*:\s*"([a-z_]+)"\s*,\s*"message"/.exec(text);
  return m?.[1];
}

export class ClaudeApiClient {
  private readonly fetchImpl: typeof fetch;
  private readonly base: string;

  constructor(fetchImpl?: typeof fetch, base: string = CLAUDE_ORIGIN) {
    // `fetch` is a WebIDL operation on Window. Storing the bare reference and
    // calling it as `this.fetchImpl(...)` gives it the wrong receiver and
    // throws "Illegal invocation" in the browser - so it is always invoked
    // through a plain function instead.
    this.fetchImpl = fetchImpl
      ? (input, init) => fetchImpl(input, init)
      : (input, init) => globalThis.fetch(input, init);
    this.base = base;
  }

  private url(path: string): string {
    return this.base + path;
  }

  /**
   * Auth is entirely cookie-based. `credentials: 'include'` only matters if the
   * caller ever runs this off-origin; in the MAIN world the request is
   * same-origin and first-party cookies are attached automatically.
   */
  private async request<T>(
    path: string,
    init: RequestInit = {},
  ): Promise<T> {
    const res = await this.fetchImpl(this.url(path), {
      ...init,
      credentials: 'include',
    });
    const text = await res.text();
    if (!res.ok) {
      throw new ClaudeApiError(extractErrorMessage(text) || res.statusText, {
        status: res.status,
        requestId: requestIdOf(text),
        code: errorCodeOf(text),
      });
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ClaudeApiError(`non-JSON response from ${path}`, {
        status: res.status,
      });
    }
  }

  bootstrap(): Promise<ClaudeBootstrap> {
    return this.request<ClaudeBootstrap>(API.bootstrap);
  }

  async listOrganizations(): Promise<
    Array<{ uuid: string; name: string; id: number }>
  > {
    const raw = await this.request<
      Array<{ uuid: string; name?: string; id?: number }>
    >(API.organizations);
    return raw.map((o) => ({
      uuid: o.uuid,
      name: o.name ?? '',
      id: o.id ?? 0,
    }));
  }

  async listConversations(
    org: string,
    opts: ConversationListOptions = {},
  ): Promise<ClaudeConversationListItem[]> {
    const params = new URLSearchParams({
      limit: String(opts.limit ?? 30),
      offset: String(opts.offset ?? 0),
      archived: String(opts.archived ?? false),
      consistency: 'eventual',
    });
    const json = await this.request<{ data?: ClaudeConversationListItem[] }>(
      `${API.conversationsV2(org)}?${params}`,
    );
    return json.data ?? [];
  }

  getConversation(org: string, uuid: string): Promise<ClaudeConversation> {
    const params = new URLSearchParams({
      tree: 'True',
      rendering_mode: 'messages',
      render_all_tools: 'true',
      include_inline_comparison: 'true',
      consistency: 'strong',
    });
    return this.request<ClaudeConversation>(
      `${API.conversation(org, uuid)}?${params}`,
    );
  }

  getUsage(org: string): Promise<ClaudeUsage> {
    const params = new URLSearchParams({
      at_wall: '1',
      cedar_ember: '1',
      skip_spend: '1',
    });
    return this.request<ClaudeUsage>(`${API.usage(org)}?${params}`);
  }

  createConversation(
    org: string,
    input: { name: string; model: string },
  ): Promise<ClaudeConversation> {
    return this.request<ClaudeConversation>(API.conversations(org), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: input.name, model: input.model }),
    });
  }

  updateConversation(
    org: string,
    uuid: string,
    patch: {
      name?: string;
      is_archived?: boolean;
      is_starred?: boolean;
    },
  ): Promise<ClaudeConversation> {
    return this.request<ClaudeConversation>(API.conversation(org, uuid), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
  }

  deleteConversations(
    org: string,
    uuids: string[],
  ): Promise<{ deleted?: string[]; failed?: string[] }> {
    return this.request<{ deleted?: string[]; failed?: string[] }>(
      API.deleteMany(org),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversation_uuids: uuids }),
      },
    );
  }

  /**
   * Send one turn.
   *
   * This is the ONLY way to write text into a conversation: there is no
   * message-level create/edit/delete endpoint. The body schema is strict - any
   * unknown key (e.g. `personal_styles`) is rejected with 400.
   *
   * Aborting the stream does NOT stop server-side generation: the human and
   * assistant turns are persisted regardless. Never abort mid-chunk.
   */
  async complete(
    org: string,
    uuid: string,
    input: CompleteInput,
    handlers: CompleteHandlers = {},
  ): Promise<CompleteResult> {
    const body = JSON.stringify({
      prompt: input.prompt,
      parent_message_uuid: input.parentMessageUuid,
      rendering_mode: input.renderingMode ?? 'messages',
      model: input.model,
    });

    const res = await this.fetchImpl(this.url(API.completion(org, uuid)), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      credentials: 'include',
      body,
      ...(handlers.signal ? { signal: handlers.signal } : {}),
    });

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      throw new ClaudeApiError(extractErrorMessage(text) || res.statusText, {
        status: res.status,
        requestId: requestIdOf(text),
        code: errorCodeOf(text),
      });
    }

    // `message.parent_uuid` on the assistant frame is the HUMAN message that
    // this turn appended; it is also what the next chunk must parent onto.
    let assistantUuid = '';
    let humanUuid = '';

    for await (const event of parseSse(res.body, handlers.signal)) {
      handlers.onEvent?.(event);
      if (event.event === 'message_start') {
        const data = event.data as {
          message?: { uuid?: string; parent_uuid?: string | null };
        };
        assistantUuid = data.message?.uuid ?? '';
        humanUuid = data.message?.parent_uuid ?? '';
      } else if (event.event === 'message_limit') {
        throw new ClaudeApiError('Target profile has reached its usage limit.', {
          code: 'exceeded_limit',
        });
      } else if (event.event === 'exceeded_limit') {
        throw new ClaudeApiError('Target profile has reached its usage limit.', {
          code: 'exceeded_limit',
        });
      } else if (event.event === 'error') {
        const data = event.data as { error?: { message?: string } };
        throw new ClaudeApiError(data.error?.message ?? 'completion failed', {
          code: 'stream_error',
        });
      } else if (event.event === 'message_stop' && assistantUuid) {
        break;
      }
    }

    if (!assistantUuid) {
      // The stream ended without a message_start - re-read the tree so the
      // caller still learns what was persisted.
      const conv = await this.getConversation(org, uuid).catch(() => null);
      const messages = conv?.chat_messages ?? [];
      const last = messages[messages.length - 1];
      if (!last) throw new ClaudeApiError('completion produced no messages');
      return {
        assistantUuid: last.uuid,
        humanUuid: last.parent_message_uuid ?? '',
      };
    }

    return { assistantUuid, humanUuid };
  }

  /**
   * Pick the org the user is actually working in.
   *
   * claude.ai keeps `lastActiveOrg` in a readable cookie; falling back to the
   * first membership is what happens when that cookie is absent.
   */
  async resolveActiveOrg(): Promise<{
    org: string;
    orgName: string;
    accountUuid: string;
    email: string;
  }> {
    const boot = await this.bootstrap();
    const memberships = boot.account?.memberships ?? [];
    const orgs = memberships
      .map((m) => m.organization)
      .filter((o): o is { uuid: string; name?: string; id?: number } =>
        Boolean(o?.uuid),
      );

    if (orgs.length === 0) {
      throw new ClaudeApiError('No Claude organization found for this account.');
    }

    const lastActive = readCookie('lastActiveOrg');
    const match = lastActive
      ? orgs.find((o) => o.uuid === lastActive)
      : undefined;
    const org = match ?? (orgs[0] as (typeof orgs)[number]);

    return {
      org: org.uuid,
      orgName: org.name ?? '',
      accountUuid: boot.account?.uuid ?? '',
      email: boot.account?.email_address ?? '',
    };
  }
}

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const hit = document.cookie
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${name}=`));
  return hit ? decodeURIComponent(hit.slice(name.length + 1)) : null;
}

function extractErrorMessage(text: string): string | undefined {
  const m = /"message"\s*:\s*"([^"]+)"/.exec(text);
  return m?.[1];
}