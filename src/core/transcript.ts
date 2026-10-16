import type { ClaudeMessage, ContentBlock } from '../types/claude';
import type {
  FilePlaceholderBlock,
  PortableBlock,
  TranscriptTurn,
} from '../types/session';

/**
 * Convert a conversation into numbered transcript turns.
 *
 * Blocks are copied structurally rather than flattened to text, so a bundle
 * keeps the distinction between what the model said, what it thought, and what
 * a tool returned. That is what makes a future import able to replay the
 * session faithfully in content, even though bubble layout cannot be restored.
 */

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
 * `messages` must already be the active branch - see `leafPath()` in `tree.ts`.
 * Array order would include abandoned regeneration branches.
 *
 * Blocks that would render empty (blank text, empty thinking, dropped tools)
 * are removed, and a turn with no remaining blocks is dropped entirely so an
 * import never contains empty bubbles.
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