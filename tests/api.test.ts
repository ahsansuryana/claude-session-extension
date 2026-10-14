import { describe, expect, it, vi } from 'vitest';
import { API, ClaudeApiClient, ClaudeApiError } from '../src/core/api';

type Call = { url: string; init: RequestInit };

function mockFetch(handler: (call: Call) => Response) {
  const calls: Call[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return handler(call);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const BOOT = {
  account: {
    uuid: 'acct-1',
    email_address: 'user@example.com',
    memberships: [
      { organization: { uuid: 'org-first', name: 'First' } },
      { organization: { uuid: 'org-active', name: 'Active' } },
    ],
  },
};

describe('getConversation', () => {
  it('uses the capital-T tree=True param, not a /tree subroute', async () => {
    const { impl, calls } = mockFetch(() => json({ uuid: 'c', chat_messages: [] }));
    await new ClaudeApiClient(impl).getConversation('org1', 'conv1');
    expect(calls[0]?.url).toContain('/api/organizations/org1/chat_conversations/conv1?');
    expect(calls[0]?.url).toContain('tree=True');
    expect(calls[0]?.url).not.toContain('/tree');
    expect(calls[0]?.url).toContain('rendering_mode=messages');
    expect(calls[0]?.url).toContain('render_all_tools=true');
  });

  it('always sends cookies', async () => {
    const { impl, calls } = mockFetch(() => json(BOOT));
    await new ClaudeApiClient(impl).bootstrap();
    expect(calls[0]?.init.credentials).toBe('include');
  });

  it('reports a non-JSON body instead of throwing a SyntaxError', async () => {
    const { impl } = mockFetch(() => new Response('<html>nope</html>', { status: 200 }));
    await expect(new ClaudeApiClient(impl).getConversation('o', 'c')).rejects.toThrow(
      /non-JSON/,
    );
  });

  it('maps an API error to ClaudeApiError with status and request id', async () => {
    const { impl } = mockFetch(() =>
      json(
        {
          type: 'error',
          error: { type: 'not_found_error', message: 'This conversation could not be found.' },
          request_id: 'req_123',
        },
        404,
      ),
    );
    const err = await new ClaudeApiClient(impl)
      .getConversation('o', 'c')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClaudeApiError);
    expect((err as ClaudeApiError).message).toContain('could not be found');
    expect((err as ClaudeApiError).status).toBe(404);
    expect((err as ClaudeApiError).requestId).toBe('req_123');
    expect((err as ClaudeApiError).code).toBe('not_found_error');
  });
});

describe('resolveActiveOrg', () => {
  it('prefers the org named by the lastActiveOrg cookie', async () => {
    vi.stubGlobal('document', { cookie: 'x=1; lastActiveOrg=org-active; y=2' });
    const { impl } = mockFetch(() => json(BOOT));
    const out = await new ClaudeApiClient(impl).resolveActiveOrg();
    expect(out.org).toBe('org-active');
    expect(out.email).toBe('user@example.com');
    vi.unstubAllGlobals();
  });

  it('falls back to the first membership without the cookie', async () => {
    vi.stubGlobal('document', { cookie: '' });
    const { impl } = mockFetch(() => json(BOOT));
    expect((await new ClaudeApiClient(impl).resolveActiveOrg()).org).toBe('org-first');
    vi.unstubAllGlobals();
  });

  it('errors when the account has no organizations', async () => {
    const { impl } = mockFetch(() => json({ account: { memberships: [] } }));
    await expect(new ClaudeApiClient(impl).resolveActiveOrg()).rejects.toThrow(
      /No Claude organization/,
    );
  });
});

describe('routes', () => {
  it('exposes only what the save-only build uses', () => {
    expect(API.bootstrap).toBe('/api/bootstrap');
    expect(API.conversation('o', 'c')).toBe('/api/organizations/o/chat_conversations/c');
  });
});