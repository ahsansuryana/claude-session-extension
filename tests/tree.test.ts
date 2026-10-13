import { describe, expect, it } from 'vitest';
import { branchesOf, buildMessageIndex, countBranches, leafPath, TreeError } from '../src/core/tree';
import type { ClaudeConversation, ClaudeMessage } from '../src/types/claude';
import { ROOT_MESSAGE_UUID } from '../src/types/session';

function msg(
  uuid: string,
  sender: 'human' | 'assistant',
  index: number,
  parent: string,
  text = uuid,
): ClaudeMessage {
  return {
    uuid,
    sender,
    index,
    parent_message_uuid: parent,
    created_at: '2026-10-13T02:56:00Z',
    text,
    content: [{ type: 'text', text, citations: [] }],
  };
}

function conv(
  messages: ClaudeMessage[],
  leaf?: string | null,
): ClaudeConversation {
  return {
    uuid: 'c1',
    current_leaf_message_uuid:
      leaf === undefined ? (messages[messages.length - 1]?.uuid ?? null) : leaf,
    chat_messages: messages,
  };
}

describe('leafPath', () => {
  it('returns a linear conversation in order', () => {
    const c = conv([
      msg('m0', 'human', 0, ROOT_MESSAGE_UUID),
      msg('m1', 'assistant', 1, 'm0'),
      msg('m2', 'human', 2, 'm1'),
      msg('m3', 'assistant', 3, 'm2'),
    ]);
    expect(leafPath(c).map((m) => m.uuid)).toEqual(['m0', 'm1', 'm2', 'm3']);
  });

  it('follows the leaf, not array order, when there are sibling branches', () => {
    // Mirrors the real payload captured from claude.ai: messages 0 and 2 are
    // both children of the root, so 0/1 are an abandoned branch.
    const c = conv(
      [
        msg('m0', 'human', 0, ROOT_MESSAGE_UUID, 'old question'),
        msg('m1', 'assistant', 1, 'm0', 'old answer'),
        msg('m2', 'human', 2, ROOT_MESSAGE_UUID, 'edited question'),
        msg('m3', 'assistant', 3, 'm2', 'edited answer'),
      ],
      'm3',
    );
    expect(leafPath(c).map((m) => m.uuid)).toEqual(['m2', 'm3']);
    expect(leafPath(c).map((m) => m.text)).toEqual([
      'edited question',
      'edited answer',
    ]);
    expect(countBranches(c)).toBe(2);
  });

  it('works when current_leaf_message_uuid is not last in the array', () => {
    const c = conv(
      [
        msg('m0', 'human', 0, ROOT_MESSAGE_UUID),
        msg('m1', 'assistant', 1, 'm0'),
        msg('m2', 'human', 2, 'm0'),
      ],
      'm1',
    );
    expect(leafPath(c).map((m) => m.uuid)).toEqual(['m0', 'm1']);
  });

  it('throws tree_empty for a conversation with no messages', () => {
    expect(() => leafPath(conv([]))).toThrow(TreeError);
    try {
      leafPath(conv([]));
    } catch (e) {
      expect((e as TreeError).code).toBe('tree_empty');
    }
  });

  it('throws tree_no_root_message when the leaf is not in the tree', () => {
    const c = conv([msg('m0', 'human', 0, ROOT_MESSAGE_UUID)], 'ghost');
    try {
      leafPath(c);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as TreeError).code).toBe('tree_no_root_message');
    }
  });

  it('throws tree_no_root_message when current_leaf_message_uuid is null', () => {
    const c = conv([msg('m0', 'human', 0, ROOT_MESSAGE_UUID)], null);
    try {
      leafPath(c);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as TreeError).code).toBe('tree_no_root_message');
    }
  });

  it('stops at an orphan parent instead of looping', () => {
    const c = conv([msg('m0', 'human', 0, 'vanished-parent')], 'm0');
    expect(leafPath(c).map((m) => m.uuid)).toEqual(['m0']);
  });

  it('terminates on a cyclic payload', () => {
    const c = conv([
      msg('a', 'human', 0, 'b'),
      msg('b', 'assistant', 1, 'a'),
    ]);
    const path = leafPath(c);
    expect(path.length).toBeLessThanOrEqual(3);
  });
});

describe('index helpers', () => {
  it('buildMessageIndex skips malformed entries', () => {
    const c = conv([
      msg('m0', 'human', 0, ROOT_MESSAGE_UUID),
      { sender: 'human' } as ClaudeMessage,
    ]);
    expect(buildMessageIndex(c).size).toBe(1);
  });

  it('branchesOf groups siblings under their parent, root sentinel included', () => {
    const c = conv([
      msg('m0', 'human', 0, ROOT_MESSAGE_UUID),
      msg('m1', 'assistant', 1, 'm0'),
      msg('m2', 'human', 2, ROOT_MESSAGE_UUID),
    ]);
    const branches = branchesOf(c);
    expect(branches.get(ROOT_MESSAGE_UUID)?.map((m) => m.uuid)).toEqual(['m0', 'm2']);
    expect(branches.get('m0')?.map((m) => m.uuid)).toEqual(['m1']);
  });

  it('countBranches returns 0 for a purely linear conversation', () => {
    const c = conv([
      msg('m0', 'human', 0, ROOT_MESSAGE_UUID),
      msg('m1', 'assistant', 1, 'm0'),
    ]);
    expect(countBranches(c)).toBe(0);
  });
});