import type { ContentBlock } from './claude';

/** Marker written into every exported file so imports can reject foreign JSON. */
export const SESSION_FORMAT = 'claude-session-transfer' as const;

/** Bump when the bundle shape changes incompatibly. `migrateBundle` handles older. */
export const SESSION_FORMAT_VERSION = 1 as const;

/** Parent pointer used by claude.ai for top-level messages. */
export const ROOT_MESSAGE_UUID = '00000000-0000-4000-8000-000000000000' as const;

/** Block types that can appear in a bundle. `file` is synthesised, never from the API. */
export type PortableBlock = ContentBlock | FilePlaceholderBlock;

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

export interface VaultEntryMeta {
  bundle_id: string;
  session_name: string;
  saved_at: string;
  origin: 'saved' | 'imported';
  account_email: string | null;
  conversation_uuid: string | null;
  message_count: number;
  chars: number;
}

export interface VaultIndex {
  entries: VaultEntryMeta[];
}

/** Persisted so an import interrupted by a quota wall can resume in place. */
export interface ImportResumeToken {
  bundle_id: string;
  session_name: string;
  model: string;
  org_uuid: string;
  created_uuid: string;
  next_chunk: number;
  chunk_total: number;
  last_assistant_uuid: string | null;
  started_at: string;
}

/** chrome.storage.local keys, centralised so nothing collides with claude.ai. */
export const STORAGE_KEYS = {
  vaultIndex: 'sext.vault.index',
  bundlePrefix: 'sext.bundle.',
  settings: 'sext.settings',
  resumeToken: 'sext.import.resume',
  limitsSnapshot: 'sext.limits.snapshot',
} as const;