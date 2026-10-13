# Backlog

Deferred work, ordered by how much it removes friction. Each item says why it is
not built yet and what would unblock it.

---

## 1. Session sync server — remove the file step

**Status:** not started. Deliberate: file transfer works today and needs no
infrastructure to validate the core idea.

**The problem.** Every session move is manual: profile 1 downloads a
`.claude-session.json`, you drag the file to profile 2, profile 2 imports it.
Browser profiles have fully isolated extension storage, and there is no shared
channel between them. Getting a session to another machine is worse.

**Shape it should take.**

- `POST /sessions` — upsert a bundle. Returns an id plus a short opaque slug.
- `GET /sessions` — list `session_name`, `saved_at`, `account_email`,
  `message_count`, `chars`. Metadata only, so the picker on the target profile
  can render without downloading bodies.
- `GET /sessions/{slug}` — fetch the bundle on import.
- `DELETE /sessions/{slug}`.

The target-side import dialog already has two tabs. A third tab — "From sync" —
falls out of the existing `listVault` shape almost for free.

**Design decisions still open.**

- **Auth.** Bundles contain private conversation content. Options: a passphrase
  the user types once per profile, or an account. A passphrase-derived key with
  client-side encryption before upload keeps the server unable to read anything,
  at the cost of no server-side search.
- **Retention.** Bundles are large-ish. Needs a TTL and a size cap, or the server
  becomes an unbounded store of someone's chat history.
- **Chunked uploads.** Large sessions will exceed a single-request body limit.
- **Conflict handling.** Two profiles saving the same session name should
  not clobber each other; ids should be content-derived.

**Before starting:** decide whether the server ever sees plaintext. That choice
drives the whole schema.

---

## 2. Faithful turn-by-turn replay import

**Status:** blocked on Anthropic-side API availability.

**What users actually want** is for an imported session to look like the
original — alternating user/assistant bubbles — not one large transplanted
message plus a reply.

**Why it is blocked.** Getting real bubbles requires writing an arbitrary
message tree into a conversation. None of these exist:

| Attempted | Result |
|---|---|
| `POST …/chat_conversations/{uuid}` with `chat_messages` | 400 `"must update at least one field"` — metadata only |
| `POST …/chat_conversations/{uuid}/chat_messages` | 404 |
| `GET` / `DELETE` / `POST` / `PUT …/chat_conversations/{uuid}/chat_messages/{msgUuid}` | 404 |
| `POST …/chat_conversations/{uuid}/fork` | 404 |
| `…/export`, `/export_download/{uuid}`, `/shared_artifact/{uuid}` | 404 / 403 |
| `…/share/{uuid}` and `…/chat_conversations/{uuid}/share` | 405 on GET (POST-only public share) |
| `POST …/chat_conversations/{uuid}/tool_result` | exists, but requires a `tool_use_id` from a real assistant turn |
| Aborting the `/completion` SSE stream | does **not** stop generation; the turn persists anyway |

**The one partial workaround.** Replay each user turn through `/completion` so
bubbles alternate naturally. Rejected as the default because:

- every original assistant message is **regenerated**, so content fidelity is
  lost — the opposite of the point;
- an N-turn session costs N generations of the target profile's quota;
- on a limited profile it fails faster than the transplant does.

**If a write endpoint ever appears**, the change is contained:
`src/content/importRunner.ts` would post `bundle.turns` instead of
`buildPromptChunks(bundle)`, and `bundle.turns` already carries everything
needed — uuids, roles, ordered blocks, timestamps. `src/core/bundle.ts` and
`src/core/transcript.ts` need no changes.

---

## 3. Cross-account file and artifact transfer

**Status:** not feasible today.

File assets live at `/api/{org}/files/{file_uuid}/…` and are org-scoped. A
`file_uuid` from profile A does not resolve in profile B, and there is no
re-upload path a bundle could reference.

Would need either an upstream export that returns bytes, or a proxy the user
controls. Until then, files are recorded as explicit
`[file omitted: …]` placeholders so nothing is silently lost.

---

## 4. Multi-world build fallback

**Status:** not needed. Resolved during implementation.

The original plan assumed `@crxjs/vite-plugin` and had a hand-rolled multi-entry
Vite build as the documented fallback for emitting two content scripts with
different `world` values.

The hand-rolled build (`scripts/build.mjs`) turned out to be simpler and is now
the only path: three sequential Vite builds, each a self-contained IIFE, plus a
generated `manifest.json`. `@crxjs/vite-plugin` was dropped.

**Worth revisiting if** the project grows a popup or options page and
`lib`-mode-per-entry gets awkward.

---

## 5. Usage limits are not reliably available from the API

**Status:** worked around; upstream issue.

`GET /api/organizations/{org}/usage` returns
`{ five_hour: null, seven_day: null, limits: [], ... }` on the account this was
built against — for every query variant tried (`at_wall`, `cedar_ember`,
`include_periods`, `expand`, `skip_spend`, and none at all).

Meanwhile claude.ai's own sidebar shows live percentages. No usage request
appears in the network log on page load. The sidebar reads a `localStorage`
cache keyed `claudeai.<experiment>.<orgUuid>`:

```json
{"resetsAt":1791877800,"utilization":0.03,"observedAt":1791860201.881,"atWall":false}
```

which is kept current by SSE frames on the `/completion` stream. The cache is
stale between turns — observed reading 3% while the sidebar showed 6% on the
same page.

**Current behaviour.** `/usage` wins when it has data; otherwise the extension
reads that cache and labels the row **(cached)**. When neither source has
anything it says "Limits: n/a" rather than "0% used".

**Still open.**

- The 7-day window has no cache equivalent, so the weekly bar is only available
  when `/usage` cooperates.
- There is no way to *refresh* the cache; it only moves when a turn streams.
- A subscription that exposes usage as a normal endpoint would remove the whole
  fallback and the "(may lag)" caveat.

---

## 6. Reproduce the native "new conversation" creation exactly

**Status:** investigated; not achievable with the current API surface.

Captured from a real `/new` → send ("hi") on 2026-10-14, the app does:

1. generate the conversation uuid **client-side**
2. `POST /chat_conversations/{uuid}/completion`
3. `POST /chat_conversations/{uuid}/title` `{message_content, recent_titles}`
4. navigate to `/chat/{uuid}`

Step 1–2 is the interesting part: there is **no** `POST /chat_conversations`.
The conversation springs into existence with its first message, which is why
sending from `/new` never leaves an empty placeholder chat behind.

**It could not be reproduced.** Posting `/completion` to a freshly generated uuid
returns `404 chat_conversation_not_found`, tested with:

- a plain request
- the app's exact header set (`anthropic-client-platform`, `-client-sha`,
  `-device-id`)
- the conversation's own recorded model and `localStorage["default-model"]`

All four variants 404. No service worker is registered, so nothing is hiding in
a worker. The remaining untested variable is the **body**: the app gzips it
(`content-encoding: gzip`, via `completionGzipWorker`) and it certainly carries
more than the four keys this extension sends — tools, thinking config,
personalized styles, attachments. Something in there is presumably what tells
the server to create rather than look up.

**To close this:** capture one gzipped request body and decompress it
(`DecompressionStream('gzip')` in-page, or `zlib` in Node). The account used
here was at its usage limit, which disabled the composer and blocked a fresh
capture. Worth retrying from a profile with quota.

**Until then** the importer creates first, then navigates as soon as the first
prompt lands — so the empty chat exists for roughly one request, not for the
whole import.

---

## 7. Smaller items

- **Session browser.** List, preview and delete conversations in the dock
  without opening each one. `listConversations` already returns enough
  (`name`, `updated_at`, `current_leaf_message_uuid`, `has_assistant_outputs`).
- **Vault search.** The picker is a flat list. Sessions accumulate.
- **Reminder when the limit is near.** The dock shows a warning at 80%; a badge
  or a notification at `approaching_limit` would be less easy to miss.
- **Export the vault in bulk.** One `Export list` button exists and dumps
  metadata only; bundling all bodies into a zip would be more useful.
- **Model presets drift.** `MODEL_PRESETS` in `src/content/importDialog.ts` is a
  hardcoded list. It should come from the model selector the app already renders.
- **Reduced chunk ceiling.** At the default 120k chars most sessions are one
  prompt. A lower ceiling trades quota per session for more granular progress.
- **Import verification step.** After importing, offer a diff summary
  ("12 of 14 turns carried over, 2 omitted") rather than trusting the summary.