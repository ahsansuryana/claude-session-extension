# Backlog

Everything here was tried and dropped, or is blocked. Kept so the reasoning is
not rediscovered from scratch.

---

## 1. Import — moving a session into another account

**Status:** removed from `main` on 2026-10-14. Previously implemented, working,
then pulled when the extension was trimmed to a single save button.

**Why it went:** the panel covered too much of claude.ai's own UI. Import was
the bulk of that surface. It remains recoverable: **the `.claude-session.json`
bundle format is still produced by the save button**, and `parseBundle` /
`migrateBundle` in `src/core/bundle.ts` still validate it. Only the panel, the
vault and the upload path were removed.

### What it did

Download a `.claude-session.json` in one profile, import it in another, get a
conversation that continues from the thread's end. Ports were blocked by a
quota wall paused and resumed against the same conversation rather than leaving
a half-built duplicate.

### Why a faithful copy is not possible

Getting real alternating chat bubbles requires writing an arbitrary message
tree into a conversation. None of these exist:

| Attempted | Result |
|---|---|
| `POST …/chat_conversations/{uuid}` with `chat_messages` | 400 `"must update at least one field"` — metadata only |
| `POST …/chat_conversations/{uuid}/chat_messages` | 404 |
| `GET`/`DELETE`/`POST`/`PUT …/chat_conversations/{uuid}/chat_messages/{msgUuid}` | 404 |
| `POST …/chat_conversations/{uuid}/fork` | 404 |
| `…/export`, `/export_download/{uuid}`, `/shared_artifact/{uuid}` | 404 / 403 |
| `…/share/{uuid}` and `…/chat_conversations/{uuid}/share` | 405 on GET — POST-only public share |
| `POST …/chat_conversations/{uuid}/tool_result` | exists, but needs a `tool_use_id` from a real assistant turn |
| Aborting the `/completion` SSE stream | does **not** stop generation; the turn persists anyway |

The only mutation that creates content is `POST …/completion`, whose `prompt`
must be a **plain string** (`content: []` → `400 content: Extra inputs are not
permitted`; `personal_styles` → `400 … Extra inputs are not permitted`).

So an import is necessarily a **context transplant**: the transcript is posted
as prompt text. Content fidelity is total; only the rendering differs — one
large message instead of alternating bubbles. A prompt up to 1,000,000
characters is accepted; chunking at 120,000 keeps each generation reasonable,
at a cost of one assistant reply per chunk.

**If a write endpoint ever appears**, the change is contained: post
`transcriptTurns` instead of `buildPromptChunks(bundle)`. Everything needed is
already captured per turn — uuid, role, ordered blocks, timestamps.

---

## 2. Reproduce the native conversation creation

**Status:** investigated; not achievable from outside the app.

Captured from a real `/new` → send ("hi") on 2026-10-14, claude.ai does:

1. generate the conversation uuid **client-side**
2. `POST /chat_conversations/{uuid}/completion`
3. `POST /chat_conversations/{uuid}/title` `{message_content, recent_titles}`
4. navigate to `/chat/{uuid}`

Step 1–2 is the interesting part: there is **no** `POST /chat_conversations`.
The conversation springs into existence with its first message, so sending from
`/new` never leaves an empty placeholder chat in the sidebar.

**It could not be reproduced.** Posting `/completion` to a freshly generated
uuid returns `404 chat_conversation_not_found`. Tested with a plain request, the
app's exact header set (`anthropic-client-platform`, `-client-sha`,
`-device-id`), and both the conversation's own recorded model and
`localStorage["default-model"]` — four variants, all 404. No service worker is
registered, so nothing is hiding in a worker.

**The untested variable is the body.** The app gzips it
(`content-encoding: gzip`, via `completionGzipWorker`) and it certainly carries
more than the four keys sent here — tools, thinking config, personalized styles,
attachments. Something in there presumably tells the server to create rather
than look up.

**To close this:** capture one gzipped request body and decompress it
(`DecompressionStream('gzip')` in-page, or `zlib` in Node). The account used
here was at its usage limit, which disabled the composer and blocked a fresh
capture. Retry from a profile with quota.

**Also worth knowing:** `POST …/title` does **not** overwrite an existing
title. It is an auto-titler — it proposes one and echoes back the current title.
Renaming goes through `PUT …/chat_conversations/{uuid} {name}` (202), and
`POST …/chat_conversations {name}` stores the name at creation time.

---

## 3. Session sync server

**Status:** not started.

**The problem.** Every session move is manual: download a file in profile 1,
drag it to profile 2, import it. Browser profiles have fully isolated extension
storage and there is no shared channel between them.

**Shape.**

- `POST /sessions` — upsert a bundle; returns an id and a short opaque slug.
- `GET /sessions` — `session_name`, `saved_at`, `account_email`,
  `message_count`, `chars`. Metadata only, so the picker renders without
  downloading bodies.
- `GET /sessions/{slug}` — fetch the bundle.
- `DELETE /sessions/{slug}`.

**Open decisions.**

- **Auth.** Bundles contain private conversation content. A
  passphrase-derived key with client-side encryption before upload keeps the
  server unable to read anything, at the cost of server-side search.
- **Retention.** Needs a TTL and a size cap, or the server becomes an unbounded
  store of someone's chat history.
- **Chunked uploads.** Large sessions exceed a single-request body limit.
- **Conflicts.** Two profiles saving the same name must not clobber each other;
  ids should be content-derived.

**Before starting:** decide whether the server ever sees plaintext. That choice
drives the whole schema.

---

## 4. Cross-account file and artifact transfer

**Status:** not feasible.

File assets live at `/api/{org}/files/{file_uuid}/…` and are org-scoped. A
`file_uuid` from one account does not resolve in another, and there is no
re-upload path. The exporter records them as
`[File omitted: name (N KB) — contents cannot be moved between accounts.]` so
nothing is silently lost.

Would need an upstream export that returns bytes, or a proxy the user controls.

---

## 5. Usage limits are not reliably in the API

**Status:** observed, worked around, no longer surfaced.

`GET /api/organizations/{org}/usage` returned
`{ five_hour: null, seven_day: null, limits: [] }` on the account this was
built against — for every variant tried (`at_wall`, `cedar_ember`,
`include_periods`, `expand`, `skip_spend`, and none at all).

Meanwhile claude.ai's own sidebar showed live percentages, and **no usage
request appears in the network log on page load**. The sidebar renders from a
`localStorage` cache:

```json
{"resetsAt":1791877800,"utilization":0.03,"observedAt":1791860201.881,"atWall":false}
```

kept current by SSE frames on the `/completion` stream. The cache is stale
between turns — observed reading 3% while the sidebar showed 6% on the same
page.

The previous build preferred the API and fell back to that cache, labelling
cached rows so the number was not mistaken for live. **Both were removed** when
the UI was trimmed: the chip was the main thing making the panel large, and the
request it needed on page load was itself a cost.

**Still true if anyone rebuilds this:** the 7-day window has no cache
equivalent, so a weekly figure is only available when `/usage` cooperates.

---

## 6. Smaller items

- **Tool visibility toggle.** The exporter always includes `tool_use` /
  `tool_result`. A setting to drop them would shorten files considerably for
  sessions with noisy tool output.
- **Thinking visibility toggle.** Same, for thinking blocks — they are verbose.
- **Assistant-only export.** Sometimes you want just the answers.
- **Append rather than replace.** If the same session name exists, offer to
  append to the existing file instead of downloading a second one.
- **Streaming export.** Long conversations take seconds. Writing the blob
  incrementally is not possible with `<a download>`, but a `showSaveFilePicker`
  + `FileSystemWritableFileStream` path would avoid holding it all in memory.