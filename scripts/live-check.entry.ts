/**
 * Development-only live check. Bundled by `scripts/live-check.mjs`, injected
 * into a logged-in claude.ai tab, and run manually. Not part of `dist/`.
 */
import { ClaudeApiClient } from '../src/core/api';
import { buildBundle } from '../src/core/bundle';
import { buildPromptChunks } from '../src/core/chunker';
import { leafPath } from '../src/core/tree';
import { renderPlainText } from '../src/core/transcript';
import type { ClaudeConversation } from '../src/types/claude';
import type { SessionSource } from '../src/types/session';

const ROOT = '00000000-0000-4000-8000-000000000000';

async function liveCheck(convUuid: string): Promise<unknown> {
  const api = new ClaudeApiClient();
  const report: Record<string, unknown> = {};

  const org = await api.resolveActiveOrg();
  report.org = org.org;

  const conversation = await api.getConversation(org.org, convUuid);
  report.read = {
    name: conversation.name,
    model: conversation.model,
    treeSize: conversation.chat_messages?.length ?? 0,
    branchPath: leafPath(conversation).map((m) => `${m.sender}:${m.index}`),
  };

  const source: SessionSource = {
    account_uuid: org.accountUuid || null,
    account_email: org.email || null,
    organization_uuid: org.org,
    organization_name: org.orgName || null,
    conversation_uuid: conversation.uuid ?? '',
    conversation_name: conversation.name ?? '',
    model: conversation.model ?? '',
    created_at: conversation.created_at ?? '',
    updated_at: conversation.updated_at ?? '',
    url: `${location.origin}/chat/${conversation.uuid}`,
  };

  const bundle = buildBundle({
    conversation,
    source,
    sessionName: 'ZZ session-transfer live check',
    includeThinking: true,
    includeTools: true,
  });
  report.bundle = {
    turns: bundle.turns.length,
    blocks: bundle.stats.content_blocks,
    branchCount: bundle.stats.branch_count,
    chars: bundle.stats.chars,
    jsonBytes: JSON.stringify(bundle).length,
    plainTextBytes: renderPlainText(bundle).length,
  };

  const prompts = buildPromptChunks(bundle);
  report.prompts = { count: prompts.length, sizes: prompts.map((p) => p.length) };

  // Now actually transplant it through the real API.
  const created = await api.createConversation(org.org, {
    name: bundle.session_name,
    model: conversation.model ?? 'claude-sonnet-5-5',
  });
  report.created = created.uuid;

  let parent = ROOT;
  let assistantUuid = '';
  try {
    for (const prompt of prompts) {
      const result = await api.complete(org.org, created.uuid, {
        prompt,
        parentMessageUuid: parent,
        model: conversation.model ?? 'claude-sonnet-5-5',
      });
      assistantUuid = result.assistantUuid;
      parent = result.assistantUuid;
    }
    report.complete = { ok: true, assistantUuid };

    const imported = await api.getConversation(org.org, created.uuid);
    report.imported = {
      messages: imported.chat_messages?.length ?? 0,
      leaf: imported.current_leaf_message_uuid,
      firstHumanText:
        imported.chat_messages?.find((m) => m.sender === 'human')?.content?.[0]?.type === 'text'
          ? String((imported.chat_messages[0]?.content?.[0] as { text?: string }).text ?? '').slice(0, 90)
          : null,
      name: imported.name,
    };
  } catch (error) {
    report.complete = { ok: false, error: String(error) };
  }

  // Always clean up.
  try {
    const del = await api.deleteConversations(org.org, [created.uuid]);
    report.cleanup = del;
  } catch (error) {
    report.cleanup = { error: String(error) };
  }

  return report;
}

(window as unknown as { __sextLiveCheck: typeof liveCheck }).__sextLiveCheck =
  liveCheck;