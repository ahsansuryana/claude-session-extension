import type {
  ClaudeBootstrap,
  ClaudeConversation,
  ClaudeUsage,
} from '../types/claude';

export const CLAUDE_ORIGIN = 'https://claude.ai';

/**
 * Paths claude.ai uses for conversation data, isolated here so a private-API
 * change is a single-file fix.
 *
 * Verified live 2026-10-13. Note the capital-T `tree=True` query param - the
 * plausible-looking `/chat_conversations/{uuid}/tree` route does not exist (404).
 */
export const API = {
  bootstrap: '/api/bootstrap',
  conversation: (org: string, uuid: string) =>
    `/api/organizations/${org}/chat_conversations/${uuid}`,
} as const;

export class ClaudeApiError extends Error {
  readonly status: number | undefined;
  readonly requestId: string | undefined;
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
}

function requestIdOf(text: string): string | undefined {
  return /"request_id"\s*:\s*"([^"]+)"/.exec(text)?.[1];
}

function errorCodeOf(text: string): string | undefined {
  return /"type"\s*:\s*"([a-z_]+)"\s*,\s*"message"/.exec(text)?.[1];
}

function errorMessageOf(text: string): string | undefined {
  return /"message"\s*:\s*"([^"]+)"/.exec(text)?.[1];
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

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.fetchImpl(this.base + path, {
      ...init,
      credentials: 'include',
    });
    const text = await res.text();
    if (!res.ok) {
      throw new ClaudeApiError(errorMessageOf(text) ?? res.statusText, {
        status: res.status,
        requestId: requestIdOf(text),
        code: errorCodeOf(text),
      });
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ClaudeApiError(`non-JSON response from ${path}`, { status: res.status });
    }
  }

  /**
   * Auth is entirely cookie-based. `credentials: 'include'` only matters if the
   * caller ever runs this off-origin; in the MAIN world the request is
   * same-origin and first-party cookies are attached automatically.
   */
  bootstrap(): Promise<ClaudeBootstrap> {
    return this.request<ClaudeBootstrap>(API.bootstrap);
  }

  getConversation(org: string, uuid: string): Promise<ClaudeConversation> {
    const params = new URLSearchParams({
      tree: 'True',
      rendering_mode: 'messages',
      render_all_tools: 'true',
      include_inline_comparison: 'true',
      consistency: 'strong',
    });
    return this.request<ClaudeConversation>(`${API.conversation(org, uuid)}?${params}`);
  }

  /**
   * Usage limits.
   *
   * Often empty: several organizations return every bucket as `null` and no
   * usage request is made on page load at all. Kept for callers that want to
   * try; do not assume it returns data.
   */
  getUsage(org: string): Promise<ClaudeUsage> {
    const params = new URLSearchParams({
      at_wall: '1',
      cedar_ember: '1',
      skip_spend: '1',
    });
    return this.request<ClaudeUsage>(
      `/api/organizations/${org}/usage?${params}`,
    );
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
    const orgs = (boot.account?.memberships ?? [])
      .map((m) => m.organization)
      .filter((o): o is { uuid: string; name?: string; id?: number } => Boolean(o?.uuid));

    if (orgs.length === 0) {
      throw new ClaudeApiError('No Claude organization found for this account.');
    }

    const lastActive = readCookie('lastActiveOrg');
    const org = (lastActive ? orgs.find((o) => o.uuid === lastActive) : undefined) ?? orgs[0]!;

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