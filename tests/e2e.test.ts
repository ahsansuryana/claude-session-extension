import { describe, expect, it } from 'vitest';
import { ClaudeApiClient } from '../src/core/api';
import { buildBundle, makeVaultMeta, parseBundle } from '../src/core/bundle';
import { buildPromptChunks } from '../src/core/chunker';
import { leafPath } from '../src/core/tree';
import type { ClaudeConversation } from '../src/types/claude';
import { ROOT_MESSAGE_UUID, type SessionSource } from '../src/types/session';

/**
 * End-to-end over the real data path, with only `fetch` faked.
 *
 * Uses a conversation payload shaped exactly like the one captured from
 * claude.ai: two sibling branches off the root, where array order does NOT
 * match the active branch.
 */

const CAPTURED: ClaudeConversation = {
  uuid: '471bbd5c-3d8e-4fd5-a1f7-c36344b5fd41',
  name: 'Menghubungkan MCP gateway ke browser login',
  summary: '',
  model: 'claude-sonnet-5-5',
  created_at: '2026-10-13T02:56:03.829494Z',
  updated_at: '2026-10-13T02:56:40.245904Z',
  current_leaf_message_uuid: '01a13340-a368-7596-bac5-7cb27e68aca6',
  chat_messages: [
    {
      uuid: '01a13330-45c2-71f1-a565-f56a4e05855e',
      sender: 'human',
      index: 0,
      created_at: '2026-10-13T02:56:05.141021Z',
      parent_message_uuid: ROOT_MESSAGE_UUID,
      content: [
        {
          type: 'text',
          text: 'cara menghubungkan mcp gateway ke browser yang sudah login gimana?',
          citations: [],
        },
      ],
    },
    {
      uuid: '01a13330-45c2-7c8e-8d01-8c2b7c063e72',
      sender: 'assistant',
      index: 1,
      created_at: '2026-10-13T02:56:07.828221Z',
      parent_message_uuid: '01a13330-45c2-71f1-a565-f56a4e05855e',
      stop_reason: 'end_turn',
      content: [
        {
          type: 'thinking',
          thinking: '',
          summaries: [{ summary: 'Menjelaskan cara menghubungkan MCP gateway ke peramban.' }],
          cut_off: false,
          truncated: true,
          hidden: false,
          thinking_hidden: true,
        },
      ],
    },
    {
      uuid: '01a13330-a368-77f1-baea-c96b7bee6b1f',
      sender: 'human',
      index: 2,
      created_at: '2026-10-13T02:56:28.476064Z',
      parent_message_uuid: ROOT_MESSAGE_UUID,
      content: [
        {
          type: 'text',
          text: 'cara menghubungkan mcp playwright ke browser yang sudah login gimana?',
          citations: [],
        },
      ],
    },
    {
      uuid: '01a13340-a368-7596-bac5-7cb27e68aca6',
      sender: 'assistant',
      index: 3,
      created_at: '2026-10-13T02:56:40.245904Z',
      parent_message_uuid: '01a13330-a368-77f1-baea-c96b7bee6b1f',
      stop_reason: 'end_turn',
      content: [
        {
          type: 'thinking',
          thinking: '',
          summaries: [{ summary: 'Menjelaskan cara menghubungkan Playwright MCP.' }],
          truncated: true,
          thinking_hidden: true,
        },
        { type: 'text', text: 'Buka MCP gateway, lalu hubungkan.', citations: [] },
      ],
    },
  ],
};

const source: SessionSource = {
  account_uuid: 'd886f994-1e52-4167-9640-72452d8d7d3a',
  account_email: 'user@example.com',
  organization_uuid: '00000000-0000-4000-8000-000000000001',
  organization_name: "user@example.com's Organization",
  conversation_uuid: CAPTURED.uuid ?? '',
  conversation_name: CAPTURED.name ?? '',
  model: CAPTURED.model ?? '',
  created_at: CAPTURED.created_at ?? '',
  updated_at: CAPTURED.updated_at ?? '',
  url: 'https://claude.ai/chat/471bbd5c-3d8e-4fd5-a1f7-c36344b5fd41',
};

describe('end to end: conversation -> bundle -> prompts', () => {
  it('exports only the active branch, not array order', () => {
    const path = leafPath(CAPTURED);
    expect(path.map((m) => m.index)).toEqual([2, 3]);
    expect(path[0]?.content?.[0]).toMatchObject({
      text: 'cara menghubungkan mcp playwright ke browser yang sudah login gimana?',
    });
  });

  it('builds a bundle that survives a JSON round trip', () => {
    const bundle = buildBundle({
      conversation: CAPTURED,
      source,
      sessionName: 'MCP gateway session',
      includeThinking: true,
      includeTools: true,
    });

    expect(bundle.stats.message_count).toBe(2);
    expect(bundle.stats.branch_count).toBe(2);
    expect(bundle.session_name).toBe('MCP gateway session');

    const reparsed = parseBundle(JSON.stringify(bundle));
    expect(reparsed.turns.map((t) => t.role)).toEqual(['user', 'assistant']);
    expect(reparsed.source.account_email).toBe(source.account_email);
  });

  it('drops the abandoned branch text entirely', () => {
    const bundle = buildBundle({
      conversation: CAPTURED,
      source,
      includeThinking: true,
      includeTools: true,
    });
    const [prompt] = buildPromptChunks(bundle);
    expect(prompt).toContain('mcp playwright');
    expect(prompt).not.toContain('mcp gateway ke browser yang sudah login');
  });

  it('renders exactly one prompt for a session this size', () => {
    const bundle = buildBundle({
      conversation: CAPTURED,
      source,
      includeThinking: true,
      includeTools: true,
    });
    const prompts = buildPromptChunks(bundle);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('<session_transfer>');
    expect(prompts[0]).toContain('## Turn 1 - User');
    expect(prompts[0]).toContain('## Turn 2 - Assistant (model: claude-sonnet-5-5)');
    expect(prompts[0]).toContain('<thinking_summary>');
  });

  it('produces prompts that fit the real claude.ai acceptance path', async () => {
    const bundle = buildBundle({
      conversation: CAPTURED,
      source,
      includeThinking: true,
      includeTools: true,
    });
    const prompts = buildPromptChunks(bundle);

    // Replay through a fake API that enforces the observed server contract:
    // strict body keys, parent chaining, and SSE framing.
    let stored: Array<{ uuid: string; parent: string; prompt: string }> = [];
    let assistantSeq = 0;

    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;

      if (url.includes('/completion')) {
        expect(Object.keys(body).sort()).toEqual([
          'model',
          'parent_message_uuid',
          'prompt',
          'rendering_mode',
        ]);
        const human = `human-${assistantSeq}`;
        const assistant = `asst-${++assistantSeq}`;
        stored.push({
          uuid: assistant,
          parent: body.parent_message_uuid as string,
          prompt: body.prompt as string,
        });
        const sse =
          `event: message_start\ndata: ${JSON.stringify({
            type: 'message_start',
            message: { uuid: assistant, parent_uuid: human },
          })}\n\n` +
          `event: message_stop\ndata: {"type":"message_stop"}\n\n`;
        return new Response(sse, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }

      if (url.includes('/chat_conversations') && init?.method === 'POST') {
        return new Response(JSON.stringify({ uuid: 'created-conv', name: bundle.session_name }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof fetch;

    const client = new ClaudeApiClient(fetchImpl);
    const created = await client.createConversation('org', {
      name: bundle.session_name,
      model: 'claude-sonnet-5-5',
    });

    let parent: string = ROOT_MESSAGE_UUID;
    for (const prompt of prompts) {
      const res = await client.complete('org', created.uuid, {
        prompt,
        parentMessageUuid: parent,
        model: 'claude-sonnet-5-5',
      });
      parent = res.assistantUuid;
    }

    expect(stored).toHaveLength(1);
    expect(stored[0]?.parent).toBe(ROOT_MESSAGE_UUID);
    expect(stored[0]?.prompt).toContain('mcp playwright');

    const meta = makeVaultMeta(bundle, 'b1', 'imported', new Date().toISOString(), created.uuid);
    expect(meta).toMatchObject({ conversation_uuid: 'created-conv', origin: 'imported' });
  });
});