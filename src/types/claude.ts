/**
 * Shapes returned by claude.ai's private JSON API.
 *
 * These were captured from live traffic on 2026-10-13. Anthropic does not
 * version this API, so treat every field as optional-ish and keep the parsing
 * defensive. All shapes are structurally typed - nothing here is enforced at
 * runtime, so read through `src/core/api.ts` which validates the parts we rely
 * on.
 *
 * Auth: first-party session cookies only. No API key, no `anthropic-version`
 * header. Requests must originate from the claude.ai origin (see
 * `src/bridge/main.ts`).
 */

export type MessageSender = 'human' | 'assistant';

/** Discriminator for content blocks. Observed: text, thinking, tool_use, tool_result. */
export type BlockType = 'text' | 'thinking' | 'tool_use' | 'tool_result';

export interface TextBlock {
  type: 'text';
  text: string;
  citations?: unknown[];
  start_timestamp?: string;
  stop_timestamp?: string;
}

export interface ThinkingBlock {
  type: 'thinking';
  thinking?: string;
  summaries?: Array<{ summary: string }>;
  cut_off?: boolean;
  truncated?: boolean;
  hidden?: boolean;
  thinking_hidden?: boolean;
  start_timestamp?: string;
  stop_timestamp?: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input?: unknown;
  start_timestamp?: string;
  stop_timestamp?: string;
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
  start_timestamp?: string;
  stop_timestamp?: string;
}

export type ContentBlock =
  | TextBlock
  | ThinkingBlock
  | ToolUseBlock
  | ToolResultBlock;

export interface ClaudeFileRef {
  file_uuid?: string;
  file_name?: string;
  file_kind?: string;
  size_bytes?: number;
  uuid?: string;
  path?: string;
  [k: string]: unknown;
}

export interface ClaudeAttachmentRef {
  file_uuid?: string;
  file_name?: string;
  extracted_content?: string;
  [k: string]: unknown;
}

export interface ClaudeSyncSourceRef {
  uuid?: string;
  [k: string]: unknown;
}

export interface ClaudeMessage {
  uuid: string;
  text?: string;
  content?: ContentBlock[];
  sender: MessageSender;
  index?: number;
  created_at?: string;
  updated_at?: string;
  input_mode?: string;
  stop_reason?: string | null;
  stop_details?: unknown;
  truncated?: boolean;
  attachments?: ClaudeAttachmentRef[];
  files?: ClaudeFileRef[];
  sync_sources?: ClaudeSyncSourceRef[];
  parent_message_uuid?: string | null;
}

export interface ClaudeConversationSettings {
  enabled_web_search?: boolean;
  enabled_mcp_tools?: Record<string, boolean>;
  enabled_monkeys_in_a_barrel?: boolean;
  enabled_saffron?: boolean;
  enabled_turmeric?: boolean;
  enabled_bananagrams?: boolean | null;
  tool_search_mode?: string;
  thinking_mode?: string;
  effort_level?: string;
  preview_feature_uses_artifacts?: boolean;
  [k: string]: unknown;
}

export interface ClaudeConversation {
  uuid: string;
  name?: string;
  summary?: string;
  model?: string;
  created_at?: string;
  updated_at?: string;
  settings?: ClaudeConversationSettings;
  is_starred?: boolean;
  is_archived?: boolean;
  is_temporary?: boolean;
  is_multiplayer?: boolean;
  is_wiggle_enabled?: boolean;
  workspace_upgraded?: boolean;
  platform?: string;
  effective_thinking_mode?: string;
  current_leaf_message_uuid?: string | null;
  chat_messages?: ClaudeMessage[];
}

export interface ClaudeConversationListItem {
  uuid: string;
  name?: string;
  summary?: string;
  model?: string;
  created_at?: string;
  updated_at?: string;
  is_starred?: boolean;
  is_archived?: boolean;
  is_temporary?: boolean;
  project_uuid?: string | null;
  session_id?: string | null;
  workspace_session_id?: string | null;
  has_assistant_outputs?: boolean;
  current_leaf_message_uuid?: string;
  [k: string]: unknown;
}

export interface ConversationListResponse {
  data: ClaudeConversationListItem[];
  has_more?: boolean;
  [k: string]: unknown;
}

export type LimitStatus = 'ok' | 'approaching_limit' | 'exceeded_limit';

export interface UsageLimit {
  /** Unix SECONDS, not milliseconds. */
  resets_at?: number;
  /** 0..1 */
  utilization?: number;
  status?: LimitStatus | string;
  surpassed_threshold?: number | null;
  [k: string]: unknown;
}

export interface ClaudeUsage {
  five_hour?: UsageLimit | null;
  seven_day?: UsageLimit | null;
  seven_day_cowork?: UsageLimit | null;
  seven_day_sonnet?: UsageLimit | null;
  seven_day_opus?: UsageLimit | null;
  extra_usage?: unknown | null;
  limits?: UsageLimit[];
  member_dashboard_available?: boolean;
  seven_day_breakdown?: unknown | null;
  [k: string]: unknown;
}

export interface ClaudeOrganization {
  uuid: string;
  name?: string;
  id?: number;
  [k: string]: unknown;
}

export interface ClaudeBootstrap {
  account?: {
    uuid?: string;
    email_address?: string;
    full_name?: string;
    memberships?: Array<{ organization?: ClaudeOrganization }>;
  } | null;
  [k: string]: unknown;
}

/** Discriminated frames emitted by POST .../completion (text/event-stream). */
export interface SseMessageStartData {
  type: 'message_start';
  message: {
    uuid?: string;
    parent_uuid?: string | null;
    role?: string;
    model?: string;
    content?: unknown[];
    stop_reason?: string | null;
    [k: string]: unknown;
  };
  discarded_parent_message_uuid?: string | null;
}

export interface SseErrorData {
  type?: string;
  error?: {
    type?: string;
    message?: string;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

export interface SseMessageLimitData {
  type?: string;
  message_limit?: {
    type?: string;
    creditsRequired?: boolean;
    windows?: Record<string, UsageLimit>;
    overage?: UsageLimit | null;
    sentOnModel?: string | null;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}