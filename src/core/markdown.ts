import type { ClaudeConversation, ClaudeMessage, ContentBlock } from '../types/claude';

/**
 * Render a conversation as plain Markdown.
 *
 * Deliberately a straight linearisation of the active branch - no bundle, no
 * versioning, no preview. The output is meant to be read, diffed, pasted, or
 * dropped into an editor, so it favours readable headings over a transport
 * format.
 */

export interface MarkdownOptions {
  /** Include `thinking` blocks as blockquotes. Default true. */
  includeThinking?: boolean;
  /** Include `tool_use` / `tool_result` blocks. Default true. */
  includeTools?: boolean;
  /** Record dropped files as a note. Default true. */
  includeFiles?: boolean;
  nowIso?: string;
}

interface Counters {
  tools: number;
  files: number;
  branches: number;
}

const MAX_BLOCK_CHARS = 24_000;

/** Truncate a block so one enormous tool result cannot blow up the file. */
function clamp(text: string): string {
  if (text.length <= MAX_BLOCK_CHARS) return text;
  return `${text.slice(0, MAX_BLOCK_CHARS)}\n\n… truncated (${text.length - MAX_BLOCK_CHARS} more characters)`;
}

function fence(body: string): string {
  // Widen the fence if the payload contains backticks, so nothing escapes.
  let ticks = '```';
  while (body.includes(ticks)) ticks += '`';
  return `${ticks}\n${clamp(body)}\n${ticks}`;
}

function thinkingText(block: ContentBlock): string {
  if (block.type !== 'thinking') return '';
  const summaries = block.summaries ?? [];
  if (summaries.length) return summaries.map((s) => s.summary).join('\n\n');
  return block.thinking ?? '';
}

/**
 * Render one message body. Returns markdown lines; empty when nothing is kept.
 */
function renderMessage(msg: ClaudeMessage, opts: Required<MarkdownOptions>, counters: Counters): string {
  const lines: string[] = [];

  for (const block of msg.content ?? []) {
    switch (block.type) {
      case 'text': {
        const text = (block.text ?? '').trim();
        if (text) lines.push(clamp(text));
        break;
      }
      case 'thinking': {
        if (!opts.includeThinking) break;
        const body = thinkingText(block).trim();
        if (body) lines.push(`> **Thinking** — ${clamp(body).replace(/\n/g, '\n> ')}`);
        break;
      }
      case 'tool_use': {
        if (!opts.includeTools) break;
        counters.tools++;
        const input = safeJson(block.input);
        lines.push(fence(`Tool: ${block.name}${block.id ? ` (id ${block.id})` : ''}\n${input}`));
        break;
      }
      case 'tool_result': {
        if (!opts.includeTools) break;
        const body = typeof block.content === 'string' ? block.content : safeJson(block.content);
        lines.push(
          fence(`Tool result${block.is_error ? ' (error)' : ''}${block.tool_use_id ? ` for ${block.tool_use_id}` : ''}\n${body}`),
        );
        break;
      }
      default:
        break;
    }
  }

  if (opts.includeFiles) {
    for (const file of msg.files ?? []) {
      counters.files++;
      const size = typeof file.size_bytes === 'number' ? ` (${Math.max(1, Math.round(file.size_bytes / 1024))} KB)` : '';
      lines.push(`*[File omitted: ${file.file_name ?? 'attachment'}${size} — contents cannot be moved between accounts.]*`);
    }
  }

  return lines.join('\n\n');
}

function safeJson(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value, null, 2) ?? '';
  } catch {
    return String(value);
  }
}

/**
 * Build the Markdown document.
 *
 * `path` must already be the active branch - see `leafPath()` in `tree.ts`.
 * Using array order instead would export abandoned regeneration branches.
 */
export function toMarkdown(
  conversation: ClaudeConversation,
  path: ClaudeMessage[],
  options: MarkdownOptions = {},
): string {
  const opts: Required<MarkdownOptions> = {
    includeThinking: options.includeThinking ?? true,
    includeTools: options.includeTools ?? true,
    includeFiles: options.includeFiles ?? true,
    nowIso: options.nowIso ?? new Date().toISOString(),
  };

  const counters: Counters = {
    tools: 0,
    files: 0,
    branches: Math.max(0, (conversation.chat_messages?.length ?? 0) - path.length),
  };

  const title = conversation.name?.trim() || 'Claude session';
  const url = `https://claude.ai/chat/${conversation.uuid}`;

  const head = [
    `# ${title}`,
    '',
    `- Source: ${url}`,
    `- Model: ${conversation.model ?? 'unknown'}`,
    `- Started: ${conversation.created_at ?? 'unknown'}`,
    `- Exported: ${opts.nowIso}`,
    `- ${path.length} turns · ${counters.tools} tool calls`,
    ...(counters.branches > 0
      ? [`- ${counters.branches} messages on abandoned branches were not included`]
      : []),
    '',
    '---',
    '',
  ].join('\n');

  const body: string[] = [];
  let turn = 0;

  for (const msg of path) {
    const rendered = renderMessage(msg, opts, counters);
    if (!rendered.trim()) continue;
    turn++;
    const who = msg.sender === 'human' ? 'User' : 'Assistant';
    body.push(`## Turn ${turn} · ${who}`, '', rendered, '');
  }

  return `${head}${body.join('\n').trimEnd()}\n`;
}

/** Filename for the download: the session's own name, slugged, `.md`. */
export function markdownFilename(name: string | undefined): string {
  const slug = (name ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return `${slug || 'claude-session'}.md`;
}