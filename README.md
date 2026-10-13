# Session Transfer

A Chrome extension for moving a Claude conversation between browser profiles.

Profile A runs out of quota, but the conversation isn't finished. Save the whole
session — messages, thinking, tool calls — and import it into profile B, which
continues from where A stopped.

---

## Quick start

```bash
npm install
npm run build
```

Then load it:

1. Open `chrome://extensions`
2. Turn on **Developer mode**
3. **Load unpacked** → select the `dist/` folder
4. Open or reload <https://claude.ai>

You should see a **Session Transfer** dock in the bottom-right corner.

> Install it separately in **each** browser profile you want to move sessions
> between. Chrome profiles have completely isolated extension storage — that is
> exactly why a session has to travel as a file.

### Daily use

**In the profile that is about to hit its limit**

1. Open the conversation.
2. **Save session** in the dock. The name defaults to the conversation's title
   and is pre-selected — retype it if you want.
3. Toggle what to include (thinking, tool calls, file placeholders). The dialog
   shows live counts and the resulting prompt size.
4. **Save session**. It goes into that profile's vault *and* downloads as
   `<name>.claude-session.json`.

**In the other profile**

1. Open claude.ai — you land on `/new`.
2. **Import chat** in the dock.
3. **From file** → pick the downloaded `.claude-session.json`. (Or **From this
   profile** if you previously imported it here.)
4. Check the preview — turn count, block count, and how many prompts it will
   cost — pick a model, then **Import**.
5. The moment the conversation exists, the page moves to it — the same thing
   claude.ai does the instant you send a message. The rest of the transcript
   keeps streaming, and the dock shows a progress strip until it finishes.

### Navigation and titles

Importing navigates to `/chat/{uuid}` as soon as the **first** prompt lands, not
when the whole import finishes. Waiting for every chunk would strand you on
`/new` for the entire import, and strand you there permanently if a quota wall
pauses it part-way.

The conversation does appear in the sidebar as a new chat — it *is* a new
conversation in that account, so that is unavoidable. What matching the native
flow buys is that it never sits there empty under a placeholder name.

Two naming mechanisms exist and they are not interchangeable:

| Call | Effect |
|---|---|
| `POST /chat_conversations` `{name}` | creates, and the name is stored and listed |
| `PUT /chat_conversations/{uuid}` `{name}` | renames; returns 202 |
| `POST /chat_conversations/{uuid}/title` `{message_content}` | **does not overwrite** an existing title — it is an auto-titler that proposes one and echoes back the current title |

The importer uses create + `PUT`. Switching to `/title` would silently do
nothing.

---

## How it works

```
claude.ai page
├── main-world.js   (MAIN world)     owns fetch() → claude.ai API
└── content.js      (ISOLATED world) owns the UI and chrome.* APIs
        └── talks to main-world.js over window.postMessage
```

Two worlds because the claude.ai API is **cookie-authenticated and
same-origin only**. A content script in the isolated world cannot reliably make
an authenticated same-origin request; a script in the `MAIN` world is literally
the page, so first-party cookies attach automatically and there is no CORS
preflight. `world: "MAIN"` in the manifest also bypasses page CSP, which
injecting a `<script src="chrome-extension://…">` would not.

`src/types/protocol.ts` is the shared, dependency-free contract between them.

### Source layout

| Path | Role |
|---|---|
| `src/core/api.ts` | **The only module that knows claude.ai URLs.** All endpoints isolated here. |
| `src/core/tree.ts` | Resolves the active branch of a conversation. |
| `src/core/transcript.ts` | Messages → portable turns → prompt string. |
| `src/core/chunker.ts` | Splits an oversized transcript into prompts. |
| `src/core/bundle.ts` | Builds, validates and versions the portable file. |
| `src/core/vault.ts` | Per-profile storage with quota eviction. |
| `src/content/` | Dock, dialogs, router, Shadow-DOM UI. |
| `src/bridge/` | The two-world RPC. |
| `tests/` | 194 tests. `npm test`. |

---

## The API this depends on

claude.ai's JSON API is private and unversioned. Everything below was verified
against live traffic on **2026-10-13**. Re-derive it from DevTools → Network if
something breaks.

Auth is **first-party session cookies only** — no API key, and notably *not* an
`anthropic-version` header.

| Purpose | Request |
|---|---|
| Account + orgs | `GET /api/bootstrap` |
| List conversations | `GET /api/organizations/{org}/chat_conversations_v2?limit&offset&archived&consistency=eventual` |
| Read conversation | `GET /api/organizations/{org}/chat_conversations/{uuid}?tree=True&rendering_mode=messages&render_all_tools=true&include_inline_comparison=true&consistency=strong` |
| Create conversation | `POST /api/organizations/{org}/chat_conversations` `{name, model}` |
| **Send a turn** | `POST /api/organizations/{org}/chat_conversations/{uuid}/completion` `{prompt, parent_message_uuid, rendering_mode, model}` → SSE |
| Auto-title | `POST /api/organizations/{org}/chat_conversations/{uuid}/title` `{message_content, recent_titles}` — proposes a title; does not overwrite an existing one |
| Rename / star / archive | `PUT /api/organizations/{org}/chat_conversations/{uuid}` (metadata only) |
| Delete | `POST /api/organizations/{org}/chat_conversations/delete_many` `{conversation_uuids}` |
| Usage limits | `GET /api/organizations/{org}/usage?at_wall=1&cedar_ember=1&skip_spend=1` |
| Usage fallback | `localStorage["claudeai.<experiment>.<orgUuid>"]` — see below |

Note the capital-T `tree=True`. The plausible-looking
`/chat_conversations/{uuid}/tree` route returns 404.

### A third constraint: usage is not reliably in the API

On the account this was developed against, `/usage` returns
`{ five_hour: null, seven_day: null, limits: [], ... }` for **every** query
variant tried, while the sidebar simultaneously shows "Sesi (5j): 6%" and
"Mingguan: 2%". No usage request appears in the network log on page load at all.

The sidebar renders from a `localStorage` entry:

```json
{"resetsAt":1791877800,"utilization":0.03,"prevUtilization":null,
 "observedAt":1791860201.881,"atWall":false,"fired":[],"shown":false}
```

`utilization` and `resetsAt` (unix seconds) come from SSE frames on the
`/completion` stream. The extension uses `/usage` when it has data and falls
back to this cache otherwise, marking cached rows so the number is not mistaken
for live.

### Two constraints that shape the whole design

**1. There is no message-write API.**

These were all probed and do not exist:

- `POST …/chat_conversations/{uuid}` with `chat_messages` → metadata only
- `POST …/chat_conversations/{uuid}/chat_messages` → 404
- `GET`/`DELETE`/`POST`/`PUT …/chat_conversations/{uuid}/chat_messages/{msg}` → 404
- `…/chat_conversations/{uuid}/fork` → 404
- conversation export / share-import routes → 404 or 403

The only mutation that creates content is `/completion`, whose `prompt` must be
a **plain string** (`content: []` → `400 content: Extra inputs are not
permitted`; `personal_styles` → `400 … Extra inputs are not permitted`).

So an import is a **context transplant**: the transcript is posted as prompt
text. Content fidelity is total; only the bubble layout differs — the imported
session shows the history as one large message followed by Claude's reply,
rather than as alternating bubbles.

Two consequences are handled explicitly:

- **Aborting the SSE stream does not stop generation.** Verified: aborting after
  `message_start` still persists a complete assistant turn server-side. So the
  importer never aborts mid-chunk.
- **A prompt up to 1,000,000 characters is accepted** (verified). The default
  120,000-char chunking is about keeping generations reasonable, not a server
  limit. Each chunk costs one assistant reply of the target profile's quota, and
  the import dialog shows the chunk count before you commit.

**2. `chat_messages` is a tree, not a list.**

Editing or regenerating forks a branch. Siblings share a `parent_message_uuid`
and `index` is non-monotonic. `chat_messages[len-1]` is **not** the last turn.

A real example from the account this was developed against:

```
index  sender      parent_message_uuid
0      human       00000000-0000-4000-8000-000000000000   ← abandoned branch
1      assistant   01a13330-45c2-71f1-…
2      human       00000000-0000-4000-8000-000000000000   ← active branch
3      assistant   01a13330-a368-77f1-…
current_leaf_message_uuid = message 3
```

`src/core/tree.ts` walks back from `current_leaf_message_uuid` and exports
`[2, 3]`. The abandoned branch is counted and shown in the save dialog, never
silently mixed in.

### Files cannot be moved

File assets are org-scoped at `/api/{org}/files/{file_uuid}/…`, so a bundle from
profile A cannot reference or re-upload anything into profile B. Files are
recorded as `[file omitted: name (N KB) - not transferred across accounts]`.

---

## The bundle format

```jsonc
{
  "format": "claude-session-transfer",
  "version": 1,
  "exported_at": "2026-10-13T13:24:00.000Z",
  "session_name": "My session",          // becomes the imported conversation's title
  "source": {
    "account_uuid": "…", "account_email": "…",
    "organization_uuid": "…", "organization_name": "…",
    "conversation_uuid": "…", "conversation_name": "…",
    "model": "claude-sonnet-5-5",
    "created_at": "…", "updated_at": "…", "url": "https://claude.ai/chat/…"
  },
  "stats": {
    "message_count": 12,     // on the active branch
    "branch_count": 3,       // total in tree − active path
    "content_blocks": 31, "chars": 28410, "omitted_files": 1
  },
  "turns": [
    {
      "index": 0,
      "role": "user",
      "source_uuid": "…",    // provenance only, never re-sent
      "created_at": "…",
      "blocks": [ { "type": "text", "text": "…", "citations": [] } ]
    }
  ]
}
```

Block types: `text`, `thinking`, `tool_use`, `tool_result`, and the synthesised
`file` placeholder.

Older files are upgraded by `migrateBundle`; a file from a **newer** version is
rejected with an explanatory message rather than silently misread.

---

## Resilience

**Quota runs out mid-import.** The importer persists a resume token
(`sext.import.resume`) after every successful chunk. When the target profile
hits `exceeded_limit`, it pauses, keeps the half-built conversation, and the
next time you open the import dialog offers to **resume that import** —
continuing against the same conversation instead of creating a duplicate.

**Vulnerable to heading spoofing.** Turn headings are what the chunker splits
on, so a message containing a literal `## Turn 4 - Assistant` line would forge a
turn boundary. All authored content gets a zero-width space injected after
`## Turn`, which renders identically and cannot match the splitter.

**Unknown limits.** Some organizations return every usage bucket as `null`. On
page load claude.ai makes **no** usage request at all — the sidebar percentages
are rendered from a `localStorage` cache keyed `claudeai.<experiment>.<orgUuid>`,
kept current by SSE frames on the completion stream. So when `/usage` says
nothing, the extension reads that same cache. Those rows are labelled
**(cached)** with a note that the number may lag, and a real API response always
wins over the cache. When neither source has data the UI says "Limits: n/a"
rather than showing `0% used`, because reporting zero would imply quota we
cannot confirm exists.

---

## Development

```bash
npm run dev        # rebuild dist/ on change (load dist/ unpacked to see it live)
npm run typecheck  # tsc --noEmit, strict
npm test           # 194 tests
npm run build      # typecheck + build

node scripts/live-check.mjs   # bundle the live-check harness
```

`scripts/live-check.entry.ts` runs the entire pipeline — read → bundle →
chunk → create → `/completion` → verify → delete — against a real logged-in
claude.ai tab. It always cleans up after itself. Load `.playwright-mcp/live-check.js`
into a claude.ai tab and call `__sextLiveCheck('<conversation-uuid>')`.

See [BACKLOG.md](./BACKLOG.md) for what is planned next, and
[implementation_plan.md](./implementation_plan.md) for the original design and
the API findings it was built on.

### Testing notes

`tests/e2e.test.ts` replays a payload captured verbatim from claude.ai,
including the sibling-branch structure, through a `fetch` that enforces the real
server contract (strict body keys, parent chaining, SSE framing).

`tests/api.test.ts` asserts the exact request shapes — `tree=True` present,
`/tree` absent, `conversation_uuids` not `conversation_ids`, `personal_styles`
never sent. These are the details that break silently.

---

## Privacy

Everything stays on your machine. The extension talks only to `https://claude.ai`
and stores sessions in `chrome.storage.local`. There is no server, no API key,
and no analytics. Permissions: `storage`, `alarms`, and host access to
`https://claude.ai`.

## Licence

No licence file yet — add one before distributing this.