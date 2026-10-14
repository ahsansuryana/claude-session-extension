# Session Transfer — save-only build

> **Branch `save-only`.** A trimmed build: **Save session only.**
> Import, the vault picker and usage/limit tracking were removed because the
> panel was covering too much of claude.ai's own UI.
> The full transfer feature lives on [`main`](https://github.com/ahsansuryana/claude-session-extension/tree/main).

Save the whole conversation — messages, thinking, tool calls — to a portable
JSON file, so a session can be picked up somewhere else or archived before a
profile runs out of quota.

The extension is now a **single 34px button** in the bottom-right corner. No
panel, no title bar, nothing to expand. It sits at 55% opacity until you hover
it, and disables itself on pages that are not conversations.

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

A small ⌷ save icon appears in the bottom-right. On a conversation it is active;
on `/new` it is dimmed.

### Use

1. Open the conversation you want to keep.
2. Click the save icon.
3. Retype the name if you want — it defaults to the conversation's own title.
4. Choose what to capture (thinking, tool calls, file placeholders). The dialog
   shows live counts and the resulting size.
5. **Save session**. It goes into this profile's vault *and* downloads as
   `<name>.claude-session.json`.

---

## What was removed, and why

| Removed | Reason |
|---|---|
| Import chat button + dialog + runner | Not needed for a save-only build |
| Vault picker | Only existed to pick an import source |
| Usage / limits chip and popover | Occupied the top of the panel permanently |
| Toolbar badge, alarms, service worker | Showed quota status; now that nothing reads usage, it is dead weight |

The transfer **library** is untouched: `core/api.ts` (including `complete`),
`core/sse.ts` and `core/chunker.ts` are still present and tested. They are what
`main` needs for import, so merging back stays a UI-only revert.

Permissions dropped to just `storage`, and there is no background worker.
`dist/` is 23.9 KB instead of 46.7 KB.

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
| `src/core/api.ts` | **The only module that knows claude.ai URLs.** |
| `src/core/tree.ts` | Resolves the active branch of a conversation. |
| `src/core/transcript.ts` | Messages → portable turns → prompt string. |
| `src/core/bundle.ts` | Builds, validates and versions the portable file. |
| `src/core/vault.ts` | Per-profile storage with quota eviction. |
| `src/content/ui/fab.ts` | The 34px button. |
| `src/content/saveDialog.ts` | The save flow. |
| `src/bridge/` | The two-world RPC. |
| `tests/` | 138 tests. `npm test`. |

---

## The API this depends on

claude.ai's JSON API is private and unversioned. Verified 2026-10-13. Auth is
**first-party session cookies only** — no API key, and notably *not* an
`anthropic-version` header.

| Purpose | Request |
|---|---|
| Account + orgs | `GET /api/bootstrap` |
| Read conversation | `GET /api/organizations/{org}/chat_conversations/{uuid}?tree=True&rendering_mode=messages&render_all_tools=true&include_inline_comparison=true&consistency=strong` |
| Rename / star / archive | `PUT /api/organizations/{org}/chat_conversations/{uuid}` (metadata only) |
| Delete | `POST /api/organizations/{org}/chat_conversations/delete_many` `{conversation_uuids}` |

Note the capital-T `tree=True`. The plausible-looking
`/chat_conversations/{uuid}/tree` route returns 404.

### `chat_messages` is a tree, not a list

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
`[2, 3]`. The abandoned branch is counted and shown in the dialog, never
silently mixed in.

### Files cannot be moved

File assets are org-scoped at `/api/{org}/files/{file_uuid}/…`, so a bundle from
one account cannot reference or re-upload anything into another. Files are
recorded as `[file omitted: name (N KB) - not transferred across accounts]`.

---

## The bundle format

```jsonc
{
  "format": "claude-session-transfer",
  "version": 1,
  "exported_at": "2026-10-13T13:24:00.000Z",
  "session_name": "My session",
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
`file` placeholder. Older files are upgraded by `migrateBundle`; a file from a
**newer** version is rejected with an explanatory message.

---

## Privacy

Everything stays on your machine. The extension talks only to `https://claude.ai`
and stores sessions in `chrome.storage.local`. There is no server, no API key,
and no analytics. Permissions: `storage`, and host access to `https://claude.ai`.

## Licence

No licence file yet — add one before distributing this.

See [BACKLOG.md](./BACKLOG.md) for what is planned next, and
[implementation_plan.md](./implementation_plan.md) for the original design and
the API findings it was built on.