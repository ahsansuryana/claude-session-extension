import type { ContentBlock } from './claude';

/** Marker written into every exported file so imports can reject foreign JSON. */
export const SESSION_FORMAT = 'claude-session-transfer' as const;

/** Bump when the bundle shape changes incompatibly. `migrateBundle` handles older. */
export const SESSION_FORMAT_VERSION = 1 as const;

/**
 * Parent pointer used by claude.ai for top-level messages.
 *
 * Not a `null`, and a message whose parent is anything else is a second root -
 * a regeneration branch. See `core/tree.ts`.
 */
export const ROOT_MESSAGE_UUID = '00000000-0000-4000-8000-000000000000' as const;

/** Block types that can appear in a bundle. `file` is synthesised, never from the API. */
export type PortableBlock = ContentBlock | FilePlaceholderBlock;

/**
 * Stands in for a real file.
 *
 * File bytes live at `/api/{org}/files/{uuid}` and are org-scoped, so a
 * `file_uuid` from one account does not resolve in another and there is no
 * re-upload path. Recording the name and size keeps the omission visible
 * instead of losing the attachment silently.
 */
export interface FilePlaceholderBlock {
  type: 'file';
  file_name: string;
  file_uuid: string;
  size_bytes?: number;
  note: 'not-transferred';
}

export interface TranscriptTurn {
  /** 0..n-1 along the active branch. Renumbered during export. */
  index: number;
  role: 'user' | 'assistant';
  /** Kept for provenance/debugging. Never sent to the API. */
  source_uuid: string;
  created_at: string;
  model?: string;
  stop_reason?: string | null;
  blocks: PortableBlock[];
}

export interface SessionSource {
  account_uuid: string | null;
  account_email: string | null;
  organization_uuid: string;
  organization_name: string | null;
  conversation_uuid: string;
  conversation_name: string;
  model: string;
  created_at: string;
  updated_at: string;
  url: string;
}

export interface SessionStats {
  /** Messages on the active branch. */
  message_count: number;
  /** Every message in the tree, including abandoned sibling branches. */
  branch_count: number;
  content_blocks: number;
  chars: number;
  omitted_files: number;
}

/**
 * The downloaded file.
 *
 * Written by the save button, and shaped so an importer could replay it: turns
 * keep their block structure rather than being flattened to text, so content
 * fidelity survives a transfer even though bubble layout cannot.
 */
export interface SessionBundle {
  format: typeof SESSION_FORMAT;
  version: number;
  exported_at: string;
  /** User-editable at save time; becomes the imported conversation's title. */
  session_name: string;
  source: SessionSource;
  stats: SessionStats;
  turns: TranscriptTurn[];
}

/**
 * chrome.storage.local keys, centralised so nothing collides with claude.ai.
 *
 * Only the account cache: the vault, settings and resume token went away with
 * the panel.
 */
export const STORAGE_KEYS = {
  account: 'sext.account',
} as const;

/** What `resolveActiveOrg` yields, and all the exporter needs to know about the account. */
export interface AccountCache {
  org: string;
  orgName: string;
  accountUuid: string;
  email: string;
}