import { describe, expect, it, vi } from 'vitest';
import { API, ClaudeApiClient, ClaudeApiError } from '../src/core/api';
import { sseStreamFromText } from '../src/core/sse';

type Call = { url: string; init: RequestInit };

function mockFetch(handler: (call: Call) => Response | Promise<Response>) {
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

const bodyOf = (init: RequestInit) => JSON.parse(String(init.body)) as Record<string, unknown>;

describe('endpoint shapes', () => {
  it('uses the capital-T tree=True param, not a /tree subroute', async () => {
    const { impl, calls } = mockFetch(() => json({ uuid: 'c', chat_messages: [] }));
    const api = new ClaudeApiClient(impl);
    await api.getConversation('org1', 'conv1');
    expect(calls[0]?.url).toContain('/api/organizations/org1/chat_conversations/conv1?');
    expect(calls[0]?.url).toContain('tree=True');
    expect(calls[0]?.url).not.toContain('/tree');
    expect(calls[0]?.url).toContain('rendering_mode=messages');
    expect(calls[0]?.url).toContain('render_all_tools=true');
  });

  it('sends the minimal create-conversation body', async () => {
    const { impl, calls } = mockFetch(() => json({ uuid: 'new' }, 201));
    const api = new ClaudeApiClient(impl);
    const out = await api.createConversation('org1', { name: 'X', model: 'claude-sonnet-5-5' });
    expect(calls[0]?.init.method).toBe('POST');
    expect(bodyOf(calls[0]!.init)).toEqual({ name: 'X', model: 'claude-sonnet-5-5' });
    expect(out.uuid).toBe('new');
  });

  it('sends only the allowed completion keys', async () => {
    const { impl, calls } = mockFetch(() =>
      new Response(
        sseStreamFromText(
          'event: message_start\ndata: {"type":"message_start","message":{"uuid":"a1","parent_uuid":"h1"}}\n\n' +
            'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        ),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      ),
    );
    const api = new ClaudeApiClient(impl);
    await api.complete('o', 'c', {
      prompt: 'p',
      parentMessageUuid: '00000000-0000-4000-8000-000000000000',
      model: 'm',
    });
    const body = bodyOf(calls[0]!.init);
    expect(Object.keys(body).sort()).toEqual([
      'model',
      'parent_message_uuid',
      'prompt',
      'rendering_mode',
    ]);
    expect(body).not.toHaveProperty('personal_styles');
    expect(body.parent_message_uuid).toBe('00000000-0000-4000-8000-000000000000');
  });

  it('uses conversation_uuids as the delete_many key', async () => {
    const { impl, calls } = mockFetch(() => json({ deleted: ['a'], failed: [] }));
    const api = new ClaudeApiClient(impl);
    await api.deleteConversations('org1', ['a', 'b']);
    expect(bodyOf(calls[0]!.init)).toEqual({ conversation_uuids: ['a', 'b'] });
  });

  it('requests the limit-enriching usage flags', async () => {
    const { impl, calls } = mockFetch(() => json({ limits: [] }));
    const api = new ClaudeApiClient(impl);
    await api.getUsage('org1');
    expect(calls[0]?.url).toBe(
      'https://claude.ai' + API.usage('org1') + '?at_wall=1&cedar_ember=1&skip_spend=1',
    );
  });

  it('defaults conversation listing params and unwraps data', async () => {
    const { impl, calls } = mockFetch(() => json({ data: [{ uuid: 'a' }] }));
    const api = new ClaudeApiClient(impl);
    const rows = await api.listConversations('org1');
    expect(calls[0]?.url).toContain('limit=30');
    expect(calls[0]?.url).toContain('offset=0');
    expect(calls[0]?.url).toContain('archived=false');
    expect(rows).toEqual([{ uuid: 'a' }]);
  });

  it('tolerates a list response without a data array', async () => {
    const { impl } = mockFetch(() => json({}));
    const api = new ClaudeApiClient(impl);
    expect(await api.listConversations('org1')).toEqual([]);
  });
});

describe('error mapping', () => {
  it('maps a strict-schema rejection to a ClaudeApiError', async () => {
    const { impl } = mockFetch(() =>
      json(
        {
          type: 'error',
          error: { type: 'invalid_request_error', message: 'personal_styles: Extra inputs are not permitted' },
          request_id: 'req_123',
        },
        400,
      ),
    );
    const api = new ClaudeApiClient(impl);
    const err = await api
      .complete('o', 'c', { prompt: 'p', parentMessageUuid: 'root', model: 'm' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClaudeApiError);
    expect((err as ClaudeApiError).message).toContain('Extra inputs are not permitted');
    expect((err as ClaudeApiError).status).toBe(400);
    expect((err as ClaudeApiError).requestId).toBe('req_123');
    expect((err as ClaudeApiError).code).toBe('invalid_request_error');
  });

  it('reports a non-JSON body instead of throwing a SyntaxError', async () => {
    const { impl } = mockFetch(() => new Response('<html>nope</html>', { status: 200 }));
    const api = new ClaudeApiClient(impl);
    await expect(api.getConversation('o', 'c')).rejects.toThrow(/non-JSON/);
  });

  it('always sends cookies', async () => {
    const { impl, calls } = mockFetch(() => json({}));
    const api = new ClaudeApiClient(impl);
    await api.bootstrap();
    expect(calls[0]?.init.credentials).toBe('include');
  });
});

describe('complete', () => {
  function sseResponse(text: string) {
    return new Response(sseStreamFromText(text), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }

  it('returns the assistant uuid from message_start', async () => {
    const { impl } = mockFetch(() =>
      sseResponse(
        'event: message_start\ndata: {"type":"message_start","message":{"uuid":"A1","parent_uuid":"H1"}}\n\n' +
          'event: content_block_delta\ndata: {"type":"content_block_delta"}\n\n' +
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ),
    );
    const api = new ClaudeApiClient(impl);
    const out = await api.complete('o', 'c', { prompt: 'p', parentMessageUuid: 'root', model: 'm' });
    expect(out.assistantUuid).toBe('A1');
    expect(out.humanUuid).toBe('H1');
  });

  it('handles frames split across byte boundaries', async () => {
    const frames =
      'event: message_start\ndata: {"type":"message_start","message":{"uuid":"A2","parent_uuid":"H2"}}\n\n' +
      'event: message_stop\ndata: {"type":"message_stop"}\n\n';
    const bytes = new TextEncoder().encode(frames);
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        // Split mid-frame so the parser must buffer.
        c.enqueue(bytes.slice(0, 30));
        c.enqueue(bytes.slice(30, 90));
        c.enqueue(bytes.slice(90));
        c.close();
      },
    });
    const { impl } = mockFetch(
      () => new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    );
    const api = new ClaudeApiClient(impl);
    const out = await api.complete('o', 'c', { prompt: 'p', parentMessageUuid: 'root', model: 'm' });
    expect(out.assistantUuid).toBe('A2');
  });

  it('throws an exceeded_limit error when the stream reports one', async () => {
    const { impl } = mockFetch(() =>
      sseResponse(
        'event: message_start\ndata: {"type":"message_start","message":{"uuid":"A3","parent_uuid":"H3"}}\n\n' +
          'event: message_limit\ndata: {"type":"message_limit","message_limit":{"type":"exceeded_limit"}}\n\n',
      ),
    );
    const api = new ClaudeApiClient(impl);
    const err = await api
      .complete('o', 'c', { prompt: 'p', parentMessageUuid: 'root', model: 'm' })
      .catch((e: unknown) => e);
    expect((err as ClaudeApiError).code).toBe('exceeded_limit');
    expect((err as ClaudeApiError).isLimitExceeded).toBe(true);
  });

  it('throws on a bare exceeded_limit frame', async () => {
    const { impl } = mockFetch(() =>
      sseResponse('event: exceeded_limit\ndata: {"type":"exceeded_limit"}\n\n'),
    );
    const api = new ClaudeApiClient(impl);
    await expect(
      api.complete('o', 'c', { prompt: 'p', parentMessageUuid: 'root', model: 'm' }),
    ).rejects.toThrow(/usage limit/);
  });

  it('propagates stream errors', async () => {
    const { impl } = mockFetch(() =>
      sseResponse('event: error\ndata: {"type":"error","error":{"message":"boom"}}\n\n'),
    );
    const api = new ClaudeApiClient(impl);
    await expect(
      api.complete('o', 'c', { prompt: 'p', parentMessageUuid: 'root', model: 'm' }),
    ).rejects.toThrow('boom');
  });

  it('recovers the last message when the stream ends with no message_start', async () => {
    const { impl } = mockFetch((call) =>
      call.url.includes('/completion')
        ? sseResponse(': keep-alive\n\n')
        : json({ uuid: 'c', chat_messages: [{ uuid: 'A4', parent_message_uuid: 'H4' }] }),
    );
    const api = new ClaudeApiClient(impl);
    const out = await api.complete('o', 'c', { prompt: 'p', parentMessageUuid: 'root', model: 'm' });
    expect(out.assistantUuid).toBe('A4');
  });

  it('forwards each parsed event to onEvent', async () => {
    const { impl } = mockFetch(() =>
      sseResponse(
        'event: message_start\ndata: {"type":"message_start","message":{"uuid":"A5"}}\n\n' +
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ),
    );
    const api = new ClaudeApiClient(impl);
    const seen: string[] = [];
    await api.complete(
      'o',
      'c',
      { prompt: 'p', parentMessageUuid: 'root', model: 'm' },
      { onEvent: (e) => seen.push(e.event) },
    );
    expect(seen).toEqual(['message_start', 'message_stop']);
  });
});

describe('resolveActiveOrg', () => {
  it('prefers the org named by the lastActiveOrg cookie', async () => {
    const boot = {
      account: {
        uuid: 'acct',
        email_address: 'a@b.c',
        memberships: [
          { organization: { uuid: 'org-first', name: 'First' } },
          { organization: { uuid: 'org-active', name: 'Active' } },
        ],
      },
    };
    vi.stubGlobal('document', { cookie: 'x=1; lastActiveOrg=org-active; y=2' });
    const { impl } = mockFetch(() => json(boot));
    const api = new ClaudeApiClient(impl);
    const out = await api.resolveActiveOrg();
    expect(out.org).toBe('org-active');
    expect(out.email).toBe('a@b.c');
    vi.unstubAllGlobals();
  });

  it('falls back to the first membership without the cookie', async () => {
    const boot = {
      account: { uuid: 'a', email_address: 'x@y.z', memberships: [{ organization: { uuid: 'o1' } }] },
    };
    vi.stubGlobal('document', { cookie: '' });
    const { impl } = mockFetch(() => json(boot));
    const api = new ClaudeApiClient(impl);
    expect((await api.resolveActiveOrg()).org).toBe('o1');
    vi.unstubAllGlobals();
  });

  it('errors when the account has no organizations', async () => {
    const { impl } = mockFetch(() => json({ account: { memberships: [] } }));
    const api = new ClaudeApiClient(impl);
    await expect(api.resolveActiveOrg()).rejects.toThrow(/No Claude organization/);
  });
});