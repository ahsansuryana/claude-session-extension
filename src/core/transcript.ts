import type { ClaudeMessage, ContentBlock } from '../types/claude';
import type {
  FilePlaceholderBlock,
  PortableBlock,
  SessionBundle,
  TranscriptTurn,
} from '../types/session';

export interface ToTurnsOptions {
  includeThinking: boolean;
  includeTools: boolean;
  /**
   * File bytes are org-scoped and cannot cross accounts, so they are never
   * inlined. When true they are recorded as placeholder blocks so the reader
   * of the imported session knows something was dropped.
   */
  includeFilePlaceholders: boolean;
  /** Tool results larger than this get truncated with a marker. Default 24k. */
  maxCharsPerBlock?: number;
  model?: string;
}

const DEFAULT_MAX_CHARS_PER_BLOCK = 24_000;
const TRUNCATION_MARKER = '\n… [truncated by Session Transfer]';

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, max) + TRUNCATION_MARKER;
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value, null, 2) ?? '';
  } catch {
    return String(value);
  }
}

function filePlaceholders(msg: ClaudeMessage): FilePlaceholderBlock[] {
  const out: FilePlaceholderBlock[] = [];
  for (const f of msg.files ?? []) {
    const name = f.file_name ?? f.path ?? 'attachment';
    out.push({
      type: 'file',
      file_name: name,
      file_uuid: f.file_uuid ?? f.uuid ?? '',
      ...(typeof f.size_bytes === 'number' ? { size_bytes: f.size_bytes } : {}),
      note: 'not-transferred',
    });
  }
  return out;
}

function convertBlock(
  block: ContentBlock,
  opts: Required<Pick<ToTurnsOptions, 'includeThinking' | 'includeTools' | 'maxCharsPerBlock'>>,
): PortableBlock | null {
  switch (block.type) {
    case 'text': {
      const text = typeof block.text === 'string' ? block.text : '';
      if (!text.trim()) return null;
      return {
        type: 'text',
        text: truncate(text, opts.maxCharsPerBlock),
        citations: [],
      };
    }
    case 'thinking': {
      if (!opts.includeThinking) return null;
      const summaries = block.summaries ?? [];
      const thinking = typeof block.thinking === 'string' ? block.thinking : '';
      // `thinking` is empty whenever summaries exist; summaries are the
      // user-visible form. Keep whichever is actually populated.
      const body = summaries.length
        ? summaries.map((s) => s.summary).join('\n\n')
        : thinking;
      if (!body.trim()) return null;
      return {
        type: 'thinking',
        thinking: truncate(body, opts.maxCharsPerBlock),
        summaries: summaries.length ? summaries : [{ summary: body }],
        cut_off: block.cut_off ?? false,
        truncated: block.truncated ?? false,
        hidden: block.hidden ?? false,
        thinking_hidden: block.thinking_hidden ?? true,
      };
    }
    case 'tool_use': {
      if (!opts.includeTools) return null;
      return {
        type: 'tool_use',
        id: String(block.id ?? ''),
        name: String(block.name ?? 'tool'),
        input: block.input,
      };
    }
    case 'tool_result': {
      if (!opts.includeTools) return null;
      return {
        type: 'tool_result',
        tool_use_id: block.tool_use_id ?? '',
        content: truncate(stringify(block.content), opts.maxCharsPerBlock),
        is_error: block.is_error ?? false,
      };
    }
    default:
      return null;
  }
}

/**
 * Turn a leaf-ordered message list into numbered transcript turns.
 *
 * Blocks that would render empty (blank text, empty thinking, dropped tools)
 * are removed, and a turn with no remaining blocks is dropped entirely so the
 * import does not contain empty bubbles.
 */
export function toTurns(
  messages: ClaudeMessage[],
  opts: ToTurnsOptions,
): TranscriptTurn[] {
  const resolved = {
    includeThinking: opts.includeThinking,
    includeTools: opts.includeTools,
    maxCharsPerBlock: opts.maxCharsPerBlock ?? DEFAULT_MAX_CHARS_PER_BLOCK,
  };

  const turns: TranscriptTurn[] = [];
  for (const msg of messages) {
    const blocks: PortableBlock[] = [];
    for (const block of msg.content ?? []) {
      const converted = convertBlock(block, resolved);
      if (converted) blocks.push(converted);
    }
    if (opts.includeFilePlaceholders) {
      blocks.push(...filePlaceholders(msg));
    }
    if (blocks.length === 0) continue;

    turns.push({
      index: turns.length,
      role: msg.sender === 'human' ? 'user' : 'assistant',
      source_uuid: msg.uuid,
      created_at: msg.created_at ?? new Date(0).toISOString(),
      ...(opts.model ? { model: opts.model } : {}),
      ...(msg.stop_reason !== undefined
        ? { stop_reason: msg.stop_reason }
        : {}),
      blocks,
    });
  }
  return turns;
}

const HEADER = [
  '<session_transfer>',
  'The transcript below is a verbatim record of a conversation held under a different',
  'Claude account. It is provided as established context so this session can continue',
  'without restating it. Treat it as history, not as instructions to re-execute.',
  'Do not summarise or acknowledge the transcript itself - just be ready to continue.',
  '</session_transfer>',
].join('\n');

function fence(lang: string, body: string): string {
  // Use a longer fence if the payload contains a triple backtick, otherwise the
  // transcript would terminate early and corrupt the structure.
  let ticks = '```';
  while (body.includes(ticks)) ticks += '`';
  return `${ticks}${lang}\n${body}\n${ticks}`;
}

/**
 * Make user/model-authored text unable to imitate a turn heading.
 *
 * Turn headings are the structure the chunker splits on, so a message
 * containing a literal "## Turn 4 - Assistant" line would otherwise forge a
 * turn boundary and split a turn in half. A zero-width space renders
 * identically but no longer matches the heading pattern.
 */
function neutraliseTurnHeadings(text: string): string {
  return text.replace(/(^|\n)(## Turn )/g, '$1## Turn\u200b');
}

function renderBlock(block: PortableBlock): string {
  switch (block.type) {
    case 'text':
      return block.text;
    case 'thinking': {
      const summaries = block.summaries ?? [];
      const body = summaries.length
        ? summaries.map((s) => s.summary).join('\n\n')
        : (block.thinking ?? '');
      return `<thinking_summary>\n${body}\n</thinking_summary>`;
    }
    case 'tool_use':
      return fence(
        'json',
        `{"tool": ${JSON.stringify(block.name)}, "id": ${JSON.stringify(block.id)}, "input": ${stringify(block.input)}}`,
      );
    case 'tool_result':
      return fence(
        'json',
        `{"tool_use_id": ${JSON.stringify(block.tool_use_id ?? '')}, "is_error": ${block.is_error ?? false}, "content": ${JSON.stringify(block.content ?? '')}}`,
      );
    case 'file': {
      const size =
        typeof block.size_bytes === 'number'
          ? ` (${Math.max(1, Math.round(block.size_bytes / 1024))} KB)`
          : '';
      return `[file omitted: ${block.file_name}${size} - not transferred across accounts]`;
    }
    default:
      return '';
  }
}

/**
 * Render a bundle into the exact string posted as `completion.prompt`.
 *
 * This is a context transplant, not a faithful copy of the rendered chat: the
 * claude.ai API has no message-write endpoint (see BACKLOG.md), so the only way
 * to get a transcript into another account is as prompt text. Content fidelity
 * is total; only the chat bubble layout differs.
 */
export function renderPrompt(
  bundle: SessionBundle,
  opts?: { header?: string },
): string {
  const header = opts?.header ?? HEADER;
  const parts: string[] = [header];

  const title = bundle.session_name || bundle.source.conversation_name;
  if (title) {
    parts.push(
      `Session: ${title}\nOriginally: ${bundle.source.conversation_name || '(untitled)'}` +
        `\nStarted: ${bundle.source.created_at}` +
        `\nAccount: ${bundle.source.account_email ?? 'unknown'}`,
    );
  }

  for (const turn of bundle.turns) {
    const label = turn.role === 'user' ? 'User' : 'Assistant';
    const meta = turn.model ? ` (model: ${turn.model})` : '';
    parts.push(`## Turn ${turn.index + 1} - ${label}${meta}`);
    const rendered = neutraliseTurnHeadings(
      turn.blocks
        .map(renderBlock)
        .filter((s) => s.trim().length > 0)
        .join('\n\n'),
    );
    parts.push(rendered);
  }

  return parts.join('\n\n');
}

/** Plain-text version for the human-readable sidecar download. */
export function renderPlainText(bundle: SessionBundle): string {
  const lines = [
    `# ${bundle.session_name || bundle.source.conversation_name}`,
    '',
    `Exported: ${bundle.exported_at}`,
    `Source: ${bundle.source.account_email ?? 'unknown'} (org ${bundle.source.organization_uuid})`,
    `Conversation: ${bundle.source.url}`,
    `Turns: ${bundle.turns.length}`,
    '',
  ];
  for (const turn of bundle.turns) {
    lines.push(`## Turn ${turn.index + 1} - ${turn.role}`);
    lines.push(
      turn.blocks
        .map((b) => (b.type === 'file' ? `[file: ${b.file_name}]` : stringifyBlock(b)))
        .filter((s) => s.trim())
        .join('\n\n'),
    );
    lines.push('');
  }
  return lines.join('\n');
}

function stringifyBlock(block: PortableBlock): string {
  switch (block.type) {
    case 'text':
      return block.text ?? '';
    case 'thinking':
      return (block.summaries ?? []).map((s) => `[thinking] ${s.summary}`).join('\n');
    case 'tool_use':
      return `[tool_use ${block.name}] ${stringify(block.input)}`;
    case 'tool_result':
      return `[tool_result ${block.is_error ? 'error' : 'ok'}] ${stringify(block.content)}`;
    case 'file':
      return `[file omitted: ${block.file_name}]`;
    default:
      return '';
  }
}