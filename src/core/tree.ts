import type { ClaudeConversation, ClaudeMessage } from '../types/claude';
import { ROOT_MESSAGE_UUID } from '../types/session';

/**
 * claude.ai returns `chat_messages` as a TREE, not a list.
 *
 * Editing or regenerating a message forks a new branch: the sibling messages
 * share the same `parent_message_uuid` and carry non-monotonic `index` values.
 * `chat_messages[chat_messages.length - 1]` is therefore NOT the last turn.
 *
 * The authoritative end of a conversation is `current_leaf_message_uuid`.
 * A faithful export must walk backwards from there.
 */

export type TreeErrorCode = 'tree_no_root_message' | 'tree_empty';

export class TreeError extends Error {
  readonly code: TreeErrorCode;
  constructor(code: TreeErrorCode) {
    super(
      code === 'tree_empty'
        ? 'This conversation has no messages yet.'
        : 'Could not resolve the active branch of this conversation.',
    );
    this.name = 'TreeError';
    this.code = code;
  }
}

export function buildMessageIndex(
  conv: ClaudeConversation,
): Map<string, ClaudeMessage> {
  const byUuid = new Map<string, ClaudeMessage>();
  for (const m of conv.chat_messages ?? []) {
    if (m && typeof m.uuid === 'string') byUuid.set(m.uuid, m);
  }
  return byUuid;
}

/** parent uuid -> children, excluding the synthetic root. */
export function branchesOf(
  conv: ClaudeConversation,
): Map<string, ClaudeMessage[]> {
  const out = new Map<string, ClaudeMessage[]>();
  for (const m of conv.chat_messages ?? []) {
    const parent = m.parent_message_uuid ?? ROOT_MESSAGE_UUID;
    const list = out.get(parent);
    if (list) list.push(m);
    else out.set(parent, [m]);
  }
  return out;
}

/**
 * Resolve the single active branch, root -> leaf.
 *
 * - Walks back from `current_leaf_message_uuid` via `parent_message_uuid`.
 * - Stops at the root sentinel, or at a parent missing from the tree (an
 *   orphan, which happens on partially-deleted conversations).
 * - Hard iteration cap so a malformed cyclic payload cannot hang the tab.
 */
export function leafPath(conv: ClaudeConversation): ClaudeMessage[] {
  const messages = conv.chat_messages ?? [];
  if (messages.length === 0) throw new TreeError('tree_empty');

  const byUuid = buildMessageIndex(conv);
  const leafUuid = conv.current_leaf_message_uuid;

  if (!leafUuid || !byUuid.has(leafUuid)) {
    throw new TreeError('tree_no_root_message');
  }

  const cap = messages.length + 1;
  const path: ClaudeMessage[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined = leafUuid;

  while (cursor && cursor !== ROOT_MESSAGE_UUID && path.length < cap) {
    if (seen.has(cursor)) break; // cycle guard
    seen.add(cursor);
    const msg: ClaudeMessage | undefined = byUuid.get(cursor);
    if (!msg) break; // orphan parent
    path.push(msg);
    cursor = msg.parent_message_uuid ?? undefined;
  }

  path.reverse();
  return path;
}

/**
 * Total messages in the tree minus the active path, i.e. how many were lost to
 * regeneration/edit branching. Surfaced in the save dialog so the user knows
 * what they are not exporting.
 */
export function countBranches(conv: ClaudeConversation): number {
  const total = (conv.chat_messages ?? []).length;
  try {
    return Math.max(0, total - leafPath(conv).length);
  } catch {
    return 0;
  }
}

/** All messages on any branch, active path first. Used for the branch preview. */
export function allMessagesInOrder(conv: ClaudeConversation): ClaudeMessage[] {
  return [...(conv.chat_messages ?? [])];
}