# Implementation Plan

A Chrome MV3 extension ("Session Transfer") that lets you **save a full Claude conversation from the profile you are chatting in**, and **re-import it as a new conversation in another Claude browser profile** — the workflow for when profile A is out of quota and you want to keep working in profile B without losing the thread.

---

## API Findings (verified live against claude.ai, 2026-10-13)

All endpoints are same-origin `https://claude.ai`, authenticated purely by first-party session cookies. **No** `anthropic-version` / API-key header is required — a plain `fetch` from the page context with `credentials: 'include'` is sufficient. Requests carry `anthropic-client-platform: web_claude_ai` etc., but omitting them still returns 200.

### Verified read endpoints

| Purpose | Request |
|---|---|
| Account + orgs | `GET /api/bootstrap` → `{ account: { uuid, email_address, memberships: [{ organization: {...} }] } }` |
| Org discovery | `GET /api/organizations?beta=true` |
| Conversation list | `GET /api/organizations/{org}/chat_conversations_v2?limit=30&offset=0&archived=false&consistency=eventual` → `{ data: [ {uuid,name,model,created_at,updated_at,is_starred,is_archived,project_uuid,current_leaf_message_uuid,has_assistant_outputs,...} ] }` |
| Full conversation tree | `GET /api/organizations/{org}/chat_conversations/{uuid}?tree=True&rendering_mode=messages&render_all_tools=true&include_inline_comparison=true&consistency=strong` |
| Usage / limits | `GET /api/organizations/{org}/usage?at_wall=1&cedar_ember=1&skip_spend=1` |
| Latest state only | `GET /api/organizations/{org}/chat_conversations/{uuid}/latest` |

Note the query param is capital-T `tree=True`; `/tree?rendering_mode=raw` is **404** and is not the real endpoint.

### Conversation tree shape

```
Conversation { uuid, name, summary, model, created_at, updated_at, settings,
               is_starred, is_archived, is_temporary, is_multiplayer, platform,
               effective_thinking_mode, workspace_upgraded,
               current_leaf_message_uuid, chat_messages: Message[] }

Message { uuid, text, content: Block[], sender: 'human'|'assistant', index: number,
          created_at, updated_at, input_mode?, stop_reason?,
          truncated, attachments[], files[], sync_sources[],
          parent_message_uuid }

Block   = { type:'text',       text, citations[] }
        | { type:'thinking',   thinking, summaries[{summary}], cut_off, truncated, hidden, thinking_hidden }
        | { type:'tool_use',   id, name, input }
        | { type:'tool_result', tool_use_id, content, is_error }
```

Root sentinel for a top-level message: `parent_message_uuid === "00000000-0000-4000-8000-000000000000"`.

**Critical:** `chat_messages` is a *tree*, not a flat list. Regenerations/edits create sibling branches with the same `parent_message_uuid` and non-monotonic `index`. `chat_messages.at(-1)` is **not** the last turn. A faithful export must walk backwards from `current_leaf_message_uuid` following `parent_message_uuid`, then reverse.

### Verified write endpoints

| Purpose | Request |
|---|---|
| Create conversation | `POST /api/organizations/{org}/chat_conversations` body `{name, model}` → **201** + full Conversation |
| Send a turn (the ONLY text write path) | `POST /api/organizations/{org}/chat_conversations/{uuid}/completion` body `{prompt: string, parent_message_uuid, rendering_mode:'messages', model}` → **200** `text/event-stream` |
| Rename / star / archive | `PUT /api/organizations/{org}/chat_conversations/{uuid}` (metadata only) |
| Delete | `POST /api/organizations/{org}/chat_conversations/delete_many` body `{conversation_uuids: [...]}` → `{deleted, failed, failed_error_codes}` |

`completion` body schema is **strict** — unknown keys are rejected:
`personal_styles`, `content`, and any other extra key → `400 "<key>: Extra inputs are not permitted"`.
`prompt` must be a `string`; arrays/objects → `400 "prompt: Input should be a valid string"`.
Minimum working body: `{ prompt, parent_message_uuid, rendering_mode, model }`.
Verified length ceiling: a **1,000,000-character** `prompt` is accepted (200). No practical size limit.

### Write endpoints that DO NOT exist (all verified 404/405)

- `POST/PUT .../chat_conversations/{uuid}` with `chat_messages` → metadata-only update, `"must update at least one field"`
- `POST .../chat_conversations/{uuid}/chat_messages` → 404
- `GET/DELETE/POST/PUT .../chat_conversations/{uuid}/chat_messages/{msgUuid}` → 404
- `POST .../chat_conversations/{uuid}/fork` → 404 (no fork/duplicate)
- `GET .../chat_conversations/{uuid}/export`, `/export_download/{uuid}`, `/shared_artifact/{uuid}` → 404/403
- `/api/organizations/{org}/share/{uuid}` and `.../chat_conversations/{uuid}/share` → 405 on GET (POST-only, public share links; not a transfer mechanism)

### Constraints this imposes on the design

1. **There is no way to write an arbitrary message tree into a conversation.** The only mutation that creates content is `completion`, which takes a plain string and *always* produces an assistant reply.
2. **Aborting the SSE stream does not stop generation.** `AbortController` after the first `message_start` event still results in a fully-persisted assistant turn server-side. Verified.
3. **Files/attachments cannot cross accounts.** File assets are org-scoped at `/api/{org}/files/{file_uuid}/...`. A bundle exported from profile A cannot reference or re-upload files into profile B. Per user decision: files are omitted from the bundle; their presence is recorded as a placeholder marker.
4. Consequently the import strategy is **context transplant**: one (or a few) `completion` call(s) whose `prompt` carries the verbatim transcript. The model then continues the session naturally. One API call, ~one generation of quota, full context fidelity.

### SSE event names to handle

`message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`, `message_limit`, `exceeded_limit`, `error`.

`message_start` carries `data.message.uuid` — the **assistant** message uuid, which becomes `parent_message_uuid` for the next chunk.
`exceeded_limit` / `message_limit` is how a quota-blocked profile signals failure mid-import; this drives the "profile is at limit → save & move" CTA.

### Usage / limits shape

`GET /usage` returns a wide object of experimental buckets (`five_hour`, `seven_day`, `seven_day_sonnet`, `seven_day_cowork`, `cedar_ember`, …) which are `null` on some orgs, plus:
- `limits: [{ resets_at: <unix seconds>, utilization: <0..1>, status: 'ok'|'approaching_limit'|'exceeded_limit', surpassed_threshold }]`
- `extra_usage`, `member_dashboard_available`, `seven_day_breakdown`

On the inspected org `limits` was empty while the SPA still showed a 5h meter, so the widget **must degrade gracefully** to "unknown" rather than assuming zero.

### Cleanup note

All probe conversations created during this investigation (`sextest-probe-delete-me`, `sextest-probe2`, `sextest-lenprobe`) were deleted via `delete_many`; the account was verified to contain zero `sextest*` conversations afterwards.

---

## Types

New file `src/types/claude.d.ts` — raw API response shapes (verbatim from live probes).

```ts
export type MessageSender = 'human' | 'assistant';
export type BlockType = 'text' | 'thinking' | 'tool_use' | 'tool_result';

export interface TextBlock {
  type: 'text';
  text: string;
  citations: unknown[];
  start_timestamp?: string;
  stop_timestamp?: string;
}

export interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
  summaries: Array<{ summary: string }>;
  cut_off: boolean;
  truncated: boolean;
  hidden: boolean;
  thinking_hidden: boolean;
  start_timestamp?: string;
  stop_timestamp?: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
  start_timestamp?: string;
  stop_timestamp?: string;
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: unknown;
  is_error: boolean;
  start_timestamp?: string;
  stop_timestamp?: string;
}

export type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock;

export interface ClaudeFileRef {
  file_uuid: string;
  file_name: string;
  file_kind?: string;
  size_bytes?: number;
  uuid?: string;
}

export interface ClaudeAttachmentRef {
  file_uuid?: string;
  file_name?: string;
  extracted_content?: string;
  [k: string]: unknown;
}

export interface ClaudeMessage {
  uuid: string;
  text: string;
  content: ContentBlock[];
  sender: MessageSender;
  index: number;
  created_at: string;
  updated_at: string;
  input_mode?: string;
  stop_reason?: string | null;
  truncated: boolean;
  attachments: ClaudeAttachmentRef[];
  files: ClaudeFileRef[];
  sync_sources: Array<{ uuid: string }>;
  parent_message_uuid: string;
}

export interface ClaudeConversationSettings {
  enabled_web_search?: boolean;
  enabled_mcp_tools?: Record<string, boolean>;
  enabled_monkeys_in_a_barrel?: boolean;
  enabled_saffron?: boolean;
  enabled_turmeric?: boolean;
  tool_search_mode?: string;
  thinking_mode?: string;
  effort_level?: string;
  preview_feature_uses_artifacts?: boolean;
  [k: string]: unknown;
}

export interface ClaudeConversation {
  uuid: string;
  name: string;
  summary: string;
  model: string;
  created_at: string;
  updated_at: string;
  settings: ClaudeConversationSettings;
  is_starred: boolean;
  is_archived: boolean;
  is_temporary: boolean;
  is_multiplayer: boolean;
  is_wiggle_enabled: boolean;
  workspace_upgraded: boolean;
  platform: string;
  effective_thinking_mode: string;
  current_leaf_message_uuid: string;
  chat_messages: ClaudeMessage[];
}

export interface ClaudeConversationListItem {
  uuid: string;
  name: string;
  summary: string;
  model: string;
  created_at: string;
  updated_at: string;
  is_starred: boolean;
  is_archived: boolean;
  is_temporary: boolean;
  project_uuid?: string | null;
  current_leaf_message_uuid?: string;
  has_assistant_outputs?: boolean;
  [k: string]: unknown;
}

export interface UsageLimit {
  resets_at: number;            // unix SECONDS (note: not ms)
  utilization: number;          // 0..1
  status: 'ok' | 'approaching_limit' | 'exceeded_limit' | string;
  surpassed_threshold?: number | null;
}

export interface ClaudeUsage {
  five_hour: UsageLimit | null;
  seven_day: UsageLimit | null;
  seven_day_cowork: UsageLimit | null;
  seven_day_sonnet: UsageLimit | null;
  extra_usage: unknown | null;
  limits: UsageLimit[];
  member_dashboard_available: boolean;
  seven_day_breakdown: unknown | null;
  [k: string]: unknown;
}

export interface ClaudeBootstrapAccount {
  uuid: string;
  email_address: string;
  full_name: string;
  memberships: Array<{ organization: { uuid: string; name: string; id: number } }>;
}
```

New file `src/types/session.ts` — the portable bundle format.

```ts
export const SESSION_FORMAT = 'claude-session-transfer' as const;
export const SESSION_FORMAT_VERSION = 1 as const;

/** Blocks kept in the bundle. `file` is a placeholder we synthesize. */
export type PortableBlock =
  | TextBlock
  | ThinkingBlock
  | ToolUseBlock
  | ToolResultBlock
  | FilePlaceholderBlock;

export interface FilePlaceholderBlock {
  type: 'file';
  file_name: string;
  file_uuid: string;
  size_bytes?: number;
  note: 'not-transferred';
}

export interface TranscriptTurn {
  index: number;                 // 0..n-1 along the active branch
  role: 'user' | 'assistant';
  source_uuid: string;           // provenance only; never re-sent
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
  message_count: number;
  branch_count: number;          // total messages in the tree (incl. abandoned)
  content_blocks: number;
  chars: number;
  omitted_files: number;
  omitted_tool_calls: number;
}

export interface SessionBundle {
  format: typeof SESSION_FORMAT;
  version: typeof SESSION_FORMAT_VERSION;
  exported_at: string;           // ISO 8601
  session_name: string;          // user-editable at save time
  source: SessionSource;
  stats: SessionStats;
  turns: TranscriptTurn[];
}

export interface VaultEntryMeta {
  bundle_id: string;             // uuid v4 generated on save
  session_name: string;
  saved_at: string;
  origin: 'saved' | 'imported';
  account_email: string | null;
  conversation_uuid: string | null;
  conversation_url: string | null;
  message_count: number;
  chars: number;
}

export type ImportMode = 'transplant';        // only mode for now (see BACKLOG)
export type SaveFormat = 'include-thinking' | 'include-tool-calls';
```

New file `src/types/protocol.ts` — MAIN-world RPC contract.

```ts
export type RpcOp =
  | 'bootstrap'
  | 'listConversations'
  | 'getConversation'
  | 'getUsage'
  | 'createConversation'
  | 'complete'
  | 'updateConversation'
  | 'deleteConversations';

export interface RpcRequest {
  channel: 'sext';
  kind: 'req';
  nonce: string;
  id: string;
  op: RpcOp;
  payload: unknown;
}

export interface RpcResponse {
  channel: 'sext';
  kind: 'res';
  nonce: string;
  id: string;
  ok: boolean;
  data?: unknown;
  error?: { message: string; status?: number; requestId?: string };
}
```

---

## Files

### Root

| Path | Purpose |
|---|---|
| `F:\session-extension\package.json` | Vite 6 + TypeScript 5.7 + Vitest 3 + `@crxjs/vite-plugin`. Scripts: `dev`, `build`, `preview`, `typecheck`, `lint`, `test`. |
| `F:\session-extension\tsconfig.json` | Strict, `moduleResolution: bundler`, `types: ["chrome", "vite/client"]`, path alias `@/* -> src/*`. |
| `F:\session-extension\vite.config.ts` | CRXJS config. Two content-script entries with different `world`s (ISOLATED + MAIN). |
| `F:\session-extension\BACKLOG.md` | **Required deliverable** — records the deferred "session sync server" and the faithful-replay mode. |
| `F:\session-extension\.gitignore` | `node_modules`, `dist`, `*.zip`, `.playwright-mcp`. |
| `F:\session-extension\README.md` | Load-unpacked instructions, architecture diagram, API notes. |
| `F:\session-extension\implementation_plan.md` | This document. |

### Source — core (pure, no DOM, unit-testable)

| Path | Purpose |
|---|---|
| `src/core/tree.ts` | Branch resolution over `chat_messages`. |
| `src/core/transcript.ts` | `ClaudeMessage[]` → `TranscriptTurn[]` → prompt string. |
| `src/core/bundle.ts` | `Conversation` + `SessionSource` → `SessionBundle`; validation/migration of loaded files. |
| `src/core/chunker.ts` | Split a rendered transcript into ≤N-char chunks at turn boundaries. |
| `src/core/api.ts` | Typed `ClaudeApiClient` — the only module that knows URLs. Pure `fetch` injection. |
| `src/core/vault.ts` | `chrome.storage.local` CRUD for saved bundles + metadata. |
| `src/core/settings.ts` | User settings (chunk size, include toggles, last used model). |
| `src/core/format.ts` | Filename slugs, byte formatting, relative dates, turn labels. |

### Source — bridge (MAIN-world fetch ↔ ISOLATED-world UI)

| Path | Purpose |
|---|---|
| `src/bridge/protocol.ts` | Types + `isRpcRequest` / `isRpcResponse` guards + nonce constants. |
| `src/bridge/main.ts` | **MAIN world** entry. Owns `ClaudeApiClient`, listens for RPC, posts responses. No DOM UI. |
| `src/bridge/port.ts` | **ISOLATED world** entry. `call<T>(op, payload): Promise<T>` over `window.postMessage`. |

### Source — content script UI

| Path | Purpose |
|---|---|
| `src/content/index.ts` | Entry. Mounts `dock.ts`, watches SPA navigation, wires port. |
| `src/content/router.ts` | Detects `{ conversationUuid | null }` from `location.pathname` via `MutationObserver` on `document.body` + `popstate` + `history` patch. Debounced 150 ms. |
| `src/content/ui/dock.ts` | Shadow-DOM floating dock, bottom-right. Buttons: **Save Session** (only on `/chat/:uuid`), **Import Chat**, limit meter chip. Shadow root isolates Claude's Tailwind preflight. Root element tagged `data-sext=""`. |
| `src/content/ui/saveDialog.ts` | Modal: editable name (prefilled with conversation `name`), stats readout, `include thinking` / `include tool calls` toggles, Save → writes vault entry + triggers `.claude-session.json` download. |
| `src/content/ui/importDialog.ts` | Modal, two tabs: **From file** (`<input type=file accept=".json,.claude-session.json">`) and **From this profile's vault** (list of `VaultEntryMeta`, click to select). Shows target account email + org + model picker before starting. |
| `src/content/ui/limits.ts` | Chip + popover rendering `ClaudeUsage` into bars + reset countdowns; shows "Save & move" CTA when `status === 'exceeded_limit'`. |
| `src/content/ui/vaultList.ts` | Shared vault list renderer used by the import dialog and a dock submenu. |
| `src/content/ui/dom.ts` | `h()` hyperscript helper + `openModal()` / `closeModal()` primitives over Shadow DOM. |
| `src/content/ui/styles.css` | Injected as a string into the shadow root. CSS custom properties, `prefers-color-scheme` support, `prefers-reduced-motion`. |
| `src/content/download.ts` | `Blob` → object URL → `<a download>` click, filename `<slug>.claude-session.json`. |
| `src/content/importRunner.ts` | Orchestrates the multi-step import with progress reporting (see Functions). |

### Source — background

| Path | Purpose |
|---|---|
| `src/background/service-worker.ts` | Sets badge count = number of conversations at/over limit (polled via alarms, 15 min). Writes `chrome.storage.local` `limits_snapshot`. |

### Source — manifest

| Path | Purpose |
|---|---|
| `src/manifest.ts` | `defineManifest({ manifest_version: 3, name: 'Session Transfer', permissions: ['storage','downloads','alarms'], host_permissions: ['https://claude.ai/*'], content_scripts: [ {matches, js:['src/content/index.ts'], world:'ISOLATED', run_at:'document_idle'}, {matches, js:['src/bridge/main.ts'], world:'MAIN', run_at:'document_start'} ] })` |

`world: 'MAIN'` is mandatory — it is CSP-proof and guarantees the fetch runs in the page origin so the first-party session cookies are attached and no CORS preflight occurs. `run_at: 'document_start'` for the MAIN script so the RPC listener is installed before the UI can call it.

### Tests

| Path | Purpose |
|---|---|
| `tests/tree.test.ts` | Leaf-path resolution, multi-branch, orphan, empty conversation, root sentinel. |
| `tests/transcript.test.ts` | Block rendering, thinking/tool toggles, file placeholders, escaping, chunking boundaries. |
| `tests/bundle.test.ts` | Bundle build, validate, version mismatch, corrupt JSON. |
| `tests/api.test.ts` | `ClaudeApiClient` against a mocked `fetch`: URL shapes, error mapping, SSE parse. |
| `tests/vault.test.ts` | In-memory `chrome.storage.local` fake: CRUD, quota eviction. |
| `tests/importRunner.test.ts` | Chunked import sequencing + resume-on-failure. |

---

## Functions

### `src/core/tree.ts` — new

```ts
/** Resolve the single active branch of a conversation.
 *  Walks backwards from `current_leaf_message_uuid` via `parent_message_uuid`.
 *  Returns the path root→leaf. Handles abandoned sibling branches and the
 *  "00000000-0000-4000-8000-000000000000" root sentinel.
 *  Throws TreeError('tree_no_root_message') when the leaf is not in the tree. */
export function leafPath(conv: ClaudeConversation): ClaudeMessage[];
```

Also exported:
```ts
export function buildMessageIndex(conv: ClaudeConversation): Map<string, ClaudeMessage>;
export function branchesOf(conv: ClaudeConversation): Map<string, ClaudeMessage[]>;  // parentUuid -> children
export function countBranches(conv: ClaudeConversation): number;                      // total - path length
export class TreeError extends Error { constructor(code: 'tree_no_root_message' | 'tree_empty') }
```

Implementation notes:
- Build `byUuid` from `conv.chat_messages`.
- If `current_leaf_message_uuid` is falsy or missing from the map → throw `TreeError('tree_no_root_message')` (matches the SPA's own behaviour).
- Walk up while `parent_message_uuid` is a real uuid present in `byUuid`; stop at the sentinel or at a parent not in the map (orphan guard, prevents infinite loop).
- Reverse the accumulated array. Cap iterations at `chat_messages.length + 1` as a hard loop guard.

### `src/core/transcript.ts` — new

```ts
/** ClaudeMessage[] (already leaf-ordered) → TranscriptTurn[].
 *  - Drops zero-text text blocks.
 *  - Keeps thinking blocks when includeThinking (uses summaries[].summary,
 *    falling back to `thinking`; drops blocks flagged thinking_hidden && !summaries).
 *  - Keeps tool_use/tool_result when includeTools, with a maxChars-per-block
 *    truncation flag on oversized blocks.
 *  - Converts `files`/`attachments` into FilePlaceholderBlock entries
 *    (never inlined) when includeFilePlaceholders.
 *  - Renumbers `index` 0..n-1 in path order. */
export function toTurns(
  messages: ClaudeMessage[],
  opts: { includeThinking: boolean; includeTools: boolean; includeFilePlaceholders: boolean; maxCharsPerBlock?: number }
): TranscriptTurn[];
```

```ts
/** Render the bundled transcript into the string posted as `completion.prompt`.
 *  Wraps in <session_transfer> with a short framing header, then one
 *  "## Turn N — User|Assistant" section per turn. Text blocks go in fenced-free
 *  plain text; thinking is wrapped in <thinking_summary>…</thinking_summary>;
 *  tool_use is fenced ```tool_use json … ```; tool_result is fenced
 *  ```tool_result … ```; file placeholders render as a single
 *  "[file omitted: name (N bytes) — not transferred across accounts]" line. */
export function renderPrompt(
  bundle: SessionBundle,
  opts?: { header?: string; continuationNote?: string }
): string;
```

```ts
/** Plain-text export for the user (download alongside the JSON). Not used by import. */
export function renderPlainText(bundle: SessionBundle): string;
```

### `src/core/chunker.ts` — new

```ts
export const DEFAULT_MAX_PROMPT_CHARS = 120_000;   // server verified to accept 1_000_000

/** Split a rendered transcript into chunks that each fit maxChars,
 *  breaking only at "## Turn" boundaries. A single turn larger than maxChars is
 *  emitted as its own chunk (never dropped). */
export function chunkTranscript(rendered: string, maxChars?: number): string[];

/** Wrap chunk i of n with the continuation framing so the model understands the
 *  session continues rather than restarts. Chunk 0 gets no continuation note. */
export function wrapChunk(rendered: string, i: number, total: number, opts?: { continuationNote?: string }): string;
```

### `src/core/bundle.ts` — new

```ts
/** Conversation + source metadata + user name → portable SessionBundle. */
export function buildBundle(input: {
  conversation: ClaudeConversation;
  source: SessionSource;
  sessionName: string;
  includeThinking: boolean;
  includeTools: boolean;
  exportedAt?: string;
}): SessionBundle;

/** Parse + validate a downloaded file. Throws BundleError with a human message. */
export function parseBundle(text: string): SessionBundle;

/** Accept an older `version` and upgrade. Throws on unknown `format` or newer `version`. */
export function migrateBundle(bundle: SessionBundle): SessionBundle;

export class BundleError extends Error { constructor(code: 'bad_json'|'bad_format'|'bad_version'|'empty_session'|'bad_shape') }
```

### `src/core/api.ts` — new

All methods take no headers beyond `content-type` and rely on ambient cookies.

```ts
export class ClaudeApiClient {
  constructor(private fetchImpl: typeof fetch = fetch, private base = 'https://claude.ai') {}

  /** GET /api/bootstrap → ClaudeBootstrapAccount. */
  async bootstrap(): Promise<ClaudeBootstrapAccount>;

  /** GET /api/organizations?beta=true. */
  async listOrganizations(): Promise<Array<{ uuid: string; name: string; id: number }>>;

  /** GET /api/organizations/{org}/chat_conversations_v2?limit&offset&archived&consistency=eventual */
  async listConversations(org: string, opts?: { limit?: number; offset?: number; archived?: boolean }): Promise<ClaudeConversationListItem[]>;

  /** GET /api/organizations/{org}/chat_conversations/{uuid}?tree=True&rendering_mode=messages&render_all_tools=true&include_inline_comparison=true&consistency=strong */
  async getConversation(org: string, uuid: string): Promise<ClaudeConversation>;

  /** GET /api/organizations/{org}/usage?at_wall=1&cedar_ember=1&skip_spend=1 */
  async getUsage(org: string): Promise<ClaudeUsage>;

  /** POST /api/organizations/{org}/chat_conversations  {name, model} → 201 */
  async createConversation(org: string, input: { name: string; model: string }): Promise<ClaudeConversation>;

  /** PUT /api/organizations/{org}/chat_conversations/{uuid}  metadata only */
  async updateConversation(org: string, uuid: string, patch: { name?: string; is_archived?: boolean; is_starred?: boolean }): Promise<ClaudeConversation>;

  /** POST /api/organizations/{org}/chat_conversations/{uuid}/completion
   *  Streams SSE. Calls `onEvent` per parsed event and resolves with the final
   *  assistant message uuid taken from `message_start`. Rejects with
   *  ClaudeApiError('exceeded_limit') on `exceeded_limit`/`message_limit`. */
  async complete(
    org: string,
    uuid: string,
    input: { prompt: string; parentMessageUuid: string; model: string; renderingMode?: 'messages' },
    handlers?: { onEvent?: (e: SseEvent) => void; signal?: AbortSignal }
  ): Promise<{ assistantUuid: string; parentUuid: string }>;

  /** POST /api/organizations/{org}/chat_conversations/delete_many {conversation_uuids} */
  async deleteConversations(org: string, uuids: string[]): Promise<{ deleted: string[]; failed: string[] }>;

  /** Best-effort org resolution for the active profile: /api/bootstrap →
   *  prefer the membership whose uuid matches document.cookie `lastActiveOrg`,
   *  else the first membership. */
  async resolveActiveOrg(): Promise<{ org: string; orgName: string; accountUuid: string; email: string }>;
}
```

Supporting exports:
```ts
export class ClaudeApiError extends Error {
  constructor(message: string, opts: { status?: number; requestId?: string; code?: string })
}
/** Parse a raw SSE byte stream into discrete `event:`/`data:` pairs. */
export async function* parseSse(readable: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent>;
export type SseEvent = { event: string; data: unknown };
```

### `src/bridge/main.ts` — new

```ts
/** Installed in the page (MAIN) world. Owns the single ClaudeApiClient instance.
 *  - Validates every inbound message with isRpcRequest() (channel + nonce + window source).
 *  - Rejects ops not in RpcOp.
 *  - Never touches the DOM or chrome.* APIs. */
export function installRpcHandler(api: ClaudeApiClient): () => void;   // returns uninstall
```

### `src/bridge/port.ts` — new

```ts
/** ISOLATED-world client. Resolves each call by request id.
 *  Rejects on `window` message from a different source or bad nonce.
 *  Emits `RpcError` when `ok === false`. */
export function call<T>(op: RpcOp, payload: unknown, opts?: { timeoutMs?: number }): Promise<T>;
```

### `src/core/vault.ts` — new

```ts
const BUNDLE_PREFIX = 'sext.bundle.';
const META_KEY = 'sext.vault.index';
const QUOTA_BYTES = 8 * 1024 * 1024;   // chrome.storage.local default quota

/** List vault metadata sorted by saved_at desc. */
export async function listVault(): Promise<VaultEntryMeta[]>;

/** Persist a bundle + metadata. Evicts the oldest bundles until the total
 *  serialized size fits QUOTA_BYTES. Returns the assigned bundle_id. */
export async function putVaultBundle(bundle: SessionBundle, meta: VaultEntryMeta): Promise<string>;

/** Load and validate a stored bundle (re-runs migrateBundle). */
export async function getVaultBundle(id: string): Promise<SessionBundle>;

/** Remove one entry, or `clearVault()` for everything. */
export async function deleteVaultBundle(id: string): Promise<void>;
export async function clearVault(): Promise<void>;
```

### `src/core/settings.ts` — new

```ts
export interface Settings {
  maxPromptChars: number;        // default DEFAULT_MAX_PROMPT_CHARS
  includeThinking: boolean;      // default true
  includeTools: boolean;         // default true
  includeFilePlaceholders: boolean; // default true
  defaultModel: string | null;   // null → take from the imported bundle
  autoDownloadOnSave: boolean;   // default true
}

export async function getSettings(): Promise<Settings>;
export async function patchSettings(patch: Partial<Settings>): Promise<Settings>;
export const onSettingsChanged: (cb: (s: Settings) => void) => () => void;
```

### `src/content/router.ts` — new

```ts
export interface Route { kind: 'chat' | 'new' | 'other'; conversationUuid: string | null; }
export function parseRoute(pathname: string): Route;   // /chat/:uuid → chat; /new → new
export function onRouteChange(cb: (r: Route) => void): () => void;  // debounced 150ms
```
Implementation: `new MutationObserver(...).observe(document.body, {childList:true, subtree:true})`, plus patched `history.pushState`/`replaceState`, plus `popstate`. Debounce 150 ms and skip when the derived route object is deep-equal to the last one.

### `src/content/ui/dock.ts` — new

```ts
/** Mount a Shadow-DOM dock. Idempotent: a second call returns the existing root.
 *  Buttons render/hide based on route.kind. Exposes a `refresh(route)` API so
 *  `router.onRouteChange` can re-render without remounting. */
export function mountDock(opts: { port: Port; onSave: () => void; onImport: () => void }): DockHandle;

export interface DockHandle {
  refresh(route: Route): void;
  setLimits(u: ClaudeUsage | null): void;
  destroy(): void;
}
```

### `src/content/importRunner.ts` — new

The multi-step orchestration, with resumable progress.

```ts
export type ImportPhase =
  | 'validating' | 'creating' | 'importing' | 'finalizing' | 'done' | 'failed';

export interface ImportProgress {
  phase: ImportPhase;
  chunkIndex: number;
  chunkTotal: number;
  createdUuid: string | null;
  error: string | null;
}

/** Full import. Order:
 *  1. parseBundle + migrateBundle → validate non-empty `turns`
 *  2. resolveActiveOrg()
 *  3. createConversation(org, { name: bundle.session_name, model: settings.defaultModel ?? bundle.source.model })
 *  4. chunkTranscript(renderPrompt(bundle)) → for each chunk i:
 *       parentUuid = i === 0 ? '00000000-0000-4000-8000-000000000000' : lastAssistantUuid
 *       wrapChunk(chunk, i, total) → complete(...)
 *       lastAssistantUuid = result.assistantUuid
 *       emit progress; persist a resume token to chrome.storage.local under
 *       `sext.import.resume` = { bundle_id, org, createdUuid, nextChunk, lastAssistantUuid }
 *  5. updateConversation(org, createdUuid, { name }) to normalise the title
 *  6. putVaultBundle(...) with origin 'imported'
 *  7. clear the resume token; navigate to /chat/{createdUuid}
 *  On ClaudeApiError with code 'exceeded_limit': pause, persist the resume token,
 *  and surface "target profile is also at limit" with a Retry button that resumes
 *  from `nextChunk` without recreating the conversation. */
export async function runImport(
  bundle: SessionBundle,
  deps: { call: typeof call; progress: (p: ImportProgress) => void; settings: Settings }
): Promise<{ createdUuid: string }>;

/** Resume a paused import from the persisted token. No-op if no token exists. */
export async function resumeImport(deps: { call: typeof call; progress: (p: ImportProgress) => void }): Promise<{ createdUuid: string } | null>;
```

### `src/content/ui/saveDialog.ts` — new

```ts
export function openSaveDialog(ctx: {
  port: Port;
  conversationUuid: string;
  suggestedName: string;
  stats: { messages: number; chars: number; files: number };
  onSaved: (id: string) => void;
}): void;
```
Behaviour: name `<input>` prefilled with `suggestedName` and **fully selected**; toggles for thinking/tools bound to settings; Save → `getConversation` → `leafPath` → `buildBundle` → `putVaultBundle` → (if `autoDownloadOnSave`) `download.ts` → toast with the saved name.

### `src/content/ui/importDialog.ts` — new

```ts
export function openImportDialog(ctx: { port: Port; onImported: (uuid: string) => void }): void;
```
Behaviour: tabs **From file** / **From vault**; file tab uses `<input type="file" accept=".json,.claude-session.json">`, reads via `FileReader`, `parseBundle`, shows a preview (name, turn count, char count, source account/email, created_at) and any parse error inline; vault tab lists `VaultEntryMeta` by name with saved_at. Both converge on a pre-flight block showing **target** account email + org name + model `<select>` (populated from `settings.defaultModel`, `bundle.source.model`, and `'claude-sonnet-5-5'`), then **Import** → `runImport` with a progress bar.

### `src/content/ui/limits.ts` — new

```ts
export function renderLimits(root: HTMLElement, usage: ClaudeUsage | null, nowMs: number): void;
```
One row per active limit: label (`5h` / `7d` / `7d_cowork`), a bar = `utilization * 100`, "resets in HHh MMm" from `resets_at * 1000`. If `usage.limits` is empty **and** all named buckets are `null` → render an explicit "Limit data unavailable for this org" row (do not show 0%). If any `status === 'exceeded_limit'`, render a prominent "Save session & move to another profile" button that calls the dock's save flow.

### `src/content/download.ts` — new

```ts
/** Trigger a browser download. Uses an <a download> click (no chrome.downloads
 *  permission needed for page-initiated anchors). */
export function downloadJson(filename: string, data: unknown): void;
export function slugify(name: string): string;   // lowercase, non-alnum → '-', trim, max 60, fallback 'session'
```

### `src/background/service-worker.ts` — new

```ts
// chrome.alarms.create('sext:limits', { periodInMinutes: 15 })
// On alarm: for each profile tab's org (cached from last content-script message),
// fetch /usage via the MAIN-world bridge is NOT available in the SW, so instead
// cache the last ClaudeUsage the content script reports; compute badge text as
// '!' when any limit is exceeded, else '' — and always clear on startup.
export function registerLimitsAlarm(): void;
export function computeBadge(usage: ClaudeUsage | null): { text: string; color: string } | null;
```

---

## Classes

| Class | File | Notes |
|---|---|---|
| `ClaudeApiClient` | `src/core/api.ts` | **New.** The single owner of Claude endpoint URLs. `fetch` is injected so it is unit-testable and so the MAIN-world instance can be swapped. No state beyond `base`. |
| `ClaudeApiError` | `src/core/api.ts` | **New.** Extends `Error`; carries `status`, `requestId`, `code`. `code === 'exceeded_limit'` is special-cased by the import runner. |
| `TreeError` | `src/core/tree.ts` | **New.** Codes `tree_no_root_message` / `tree_empty`. |
| `BundleError` | `src/core/bundle.ts` | **New.** Codes `bad_json` / `bad_format` / `bad_version` / `empty_session` / `bad_shape`. |
| `DockHandle` (interface) | `src/content/ui/dock.ts` | **New.** Handle returned by `mountDock`. |
| — | — | No existing classes. The working directory is empty; this is a greenfield build. |

No classes are removed or modified.

---

## Dependencies

**New packages (runtime: none).** Everything ships as bundled JS; there is no runtime dependency.

| Package | Version | Type | Purpose |
|---|---|---|---|
| `vite` | ^6.0 | dev | Bundler / dev server |
| `typescript` | ^5.7 | dev | Types |
| `vitest` | ^3.0 | dev | Unit tests |
| `@crxjs/vite-plugin` | ^2.0 | dev | MV3 manifest + multi-`world` content script build |
| `@types/chrome` | ^0.0.287 | dev | `chrome.*` typings |
| `jsdom` | ^25 | dev | Test DOM for `ui/dom.ts` |

Integration requirements:
- `@crxjs/vite-plugin` must emit **two** content-script entries with different `world` values. If it cannot, fall back to a plain Vite multi-entry build: emit `main.js` as a separate IIFE/Rollup input and inject it into the manifest in a small `closeBundle` plugin that writes `dist/manifest.json`. This fallback is called out in `README.md` and `BACKLOG.md`.
- No network calls, no API keys, no server, no analytics. The extension talks only to `https://claude.ai`.
- Chrome 111+ required (for `world: 'MAIN'` content scripts). Target Chromium 111+; verified working on Chrome 155.

---

## Testing

### Unit tests (Vitest, `tests/`)

1. **`tree.test.ts`** — fixtures mirroring real payloads:
   - linear 4-message conversation → path length 4, correct order;
   - the real observed shape where messages 0 and 2 are both children of the root sentinel and `current_leaf_message_uuid` points at index 3 → path is `[2, 3]`, **not** `[0,1,2,3]`;
   - `current_leaf_message_uuid` missing from the map → throws `TreeError('tree_no_root_message')`;
   - empty `chat_messages` → `TreeError('tree_empty')`;
   - cyclic `parent_message_uuid` → terminates via the iteration cap;
   - `countBranches` returns total − path length.
2. **`transcript.test.ts`** — block rendering for each of `text`/`thinking`/`tool_use`/`tool_result`; `includeThinking: false` strips thinking; `includeTools: false` strips tool blocks; a `files` entry becomes a `FilePlaceholderBlock` and renders the "not transferred" line; oversized tool_result is truncated with a flag; `renderPrompt` emits exactly one `## Turn N` header per turn and a single `<session_transfer>` wrapper; user text containing `## Turn` or `</session_transfer>` is fenced/neutralised.
3. **`chunker.test.ts`** — splits only at turn boundaries; a single oversize turn still appears whole; `wrapChunk` adds the continuation note to chunks 1..n-1 and not to chunk 0; round-trip: joining chunks reproduces all turn headers.
4. **`bundle.test.ts`** — `buildBundle` stats are correct; `parseBundle` rejects `{}`, rejects a newer `version`, accepts a v1 and migrates; `stats.chars` matches `JSON.stringify(transcript).length`.
5. **`api.test.ts`** — mocked `fetch`: assert exact URL + query params for `getConversation` (must include `tree=True` and NOT `/tree`), `createConversation` body is `{name, model}`, `complete` body omits `personal_styles`, `deleteConversations` body key is `conversation_uuids`, a 400 with `Extra inputs are not permitted` maps to `ClaudeApiError`, an `exceeded_limit` SSE frame maps to `ClaudeApiError.code === 'exceeded_limit'`, and `parseSse` handles frames split across chunk boundaries.
6. **`vault.test.ts`** — fake `chrome.storage.local` in memory: put/list/get/delete round-trip, `evictOldest` when exceeding `QUOTA_BYTES`, corrupt stored JSON surfaces a `BundleError` rather than throwing raw.
7. **`importRunner.test.ts`** — mocked `call`: two-chunk bundle issues exactly 2 `complete` calls, the second uses the first's `assistantUuid` as `parent_message_uuid`, resume token is written after chunk 1 and cleared on success, an `exceeded_limit` on chunk 2 pauses with `nextChunk: 2` and does **not** create a second conversation.
8. **`dom.test.ts` (jsdom)** — `h()` produces the expected tag/attrs/children; `openModal` traps Escape and restores focus.

### Manual validation (Playwright MCP, against a logged-in claude.ai profile)

1. Load unpacked `dist/`; confirm the dock appears on `/chat/:uuid` and on `/new`.
2. Open a conversation with tool calls (e.g. one with `tool_use`/`tool_result`), click **Save Session** → rename → Save → verify the downloaded `.claude-session.json` parses, `stats.message_count` equals `leafPath().length`, and the transcript contains the tool blocks.
3. Re-import the same file in a second browser profile → confirm a new conversation appears at `/chat/<newUuid>` with the expected name, the transcript present, and the model able to continue from the injected context.
4. Drive a session to `exceeded_limit` (or stub `/usage`) and confirm the limits chip flips to the red state with the "Save session & move" CTA.
5. Regression: confirm no interference with Claude's own UI (composer focus, sidebar, streaming responses).

### Lint / typecheck gates

`npm run typecheck` (`tsc --noEmit`, strict) and `npm run test` must both pass before the build step. `npm run build` must produce `dist/manifest.json` with both `content_scripts[].world` values correct.

---

## Implementation Order

1. **Scaffold** — `package.json`, `tsconfig.json`, `vite.config.ts`, `.gitignore`. Install deps. Verify `npm run build` emits a loadable shell extension with both content scripts registered.
2. **Types** — `src/types/claude.d.ts`, `src/types/session.ts`, `src/types/protocol.ts` (verbatim from the verified probes above).
3. **Pure core** — `tree.ts` → `bundle.ts` → `transcript.ts` → `chunker.ts`, each with its unit test written immediately after.
4. **API client** — `core/api.ts` + `api.test.ts`. This is the highest-risk module; it is fully exercised by mocked `fetch` before any browser code exists.
5. **Bridge** — `bridge/protocol.ts`, `bridge/main.ts`, `bridge/port.ts`. Verify with a temporary `console.log` round-trip from the dock that a real `bootstrap()` call resolves in the live page.
6. **Router + shell UI** — `content/router.ts`, `content/ui/dom.ts`, `content/ui/styles.css`, `content/ui/dock.ts`, `content/index.ts`. Mount, navigate `/new` ↔ `/chat/:uuid`, confirm the buttons show/hide correctly.
7. **Save flow** — `core/vault.ts` + test, `content/ui/saveDialog.ts`, `content/download.ts`. End-to-end: save a real conversation and inspect the downloaded file.
8. **Import flow** — `content/importRunner.ts` + test, `content/ui/importDialog.ts`, `content/ui/vaultList.ts`. End-to-end cross-profile: export from profile 1, import in profile 2, continue the conversation.
9. **Limits** — `content/ui/limits.ts`, `background/service-worker.ts` (`computeBadge` + test).
10. **Docs** — `README.md` and `BACKLOG.md`. `BACKLOG.md` must record: (a) the **session sync server** so bundles no longer need to be moved as files — planned as an authenticated store with `POST /sessions`, `GET /sessions` returning name + metadata for the target profile's picker, and the bundle body fetched on import; (b) the **faithful turn-by-turn replay** import mode, which needs a write API that does not exist today (`POST .../chat_conversations/{uuid}/chat_messages` 404s, message edit/delete 404s, aborting SSE does not stop generation) — so it is blocked on Anthropic-side API availability; (c) the `@crxjs/vite-plugin` multi-`world` fallback build; (d) file/artifact transfer, currently impossible because file assets are org-scoped.
11. **Final verification** — `npm run typecheck && npm run test && npm run build`, then run the manual validation checklist above.

---

## Known Risks

| Risk | Mitigation |
|---|---|
| No message-write API — import is necessarily a context transplant, not a byte-faithful copy of the rendered chat | Accepted by design. Documented in `BACKLOG.md`; the transcript is verbatim in the prompt so context fidelity is total, only the *rendering* differs. |
| Anthropic changes private API shapes without notice | All endpoints are defined in exactly one module (`core/api.ts`) so a break is a single-file fix. `README.md` documents how to re-derive them from DevTools. |
| `AbortController` does not stop server-side generation | Never abort an import mid-chunk; always let the stream finish or surface the error. |
| A very large session produces many chunks, each costing a generation on the target | Default `maxPromptChars` is 120 000 (server accepts 1 000 000), so most sessions fit in 1–2 chunks. Chunk count is shown in the import dialog before the user commits. |
| Quota exhausted on the **target** mid-import leaves a half-built conversation | The resume token (`sext.import.resume`) plus `complete()`'s returned `assistantUuid` allow resuming from `nextChunk` against the *same* conversation instead of creating a new one. |
| `@crxjs/vite-plugin` may not support two content scripts with different `world`s | Documented fallback: hand-rolled Vite multi-entry build with a `closeBundle` manifest writer. |
| Extension UI colliding with Claude's own styles | Shadow DOM (`mode: 'open'`) on a `data-sext` host element; no reliance on Claude's internal class names; the dock is fixed-position rather than anchored into Claude's composer. |