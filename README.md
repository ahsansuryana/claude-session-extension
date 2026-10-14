# Session Transfer

Click a 34px button in the bottom-right of claude.ai and the current
conversation is downloaded as `<session name>.md` — messages, thinking, and tool
calls included.

No dialog, no preview, no options. The button spins while it works, then
downloads and goes quiet.

Built for one job: when a profile is running low on quota and you want the
conversation out of it in a form you can read, edit or archive.

---

## Quick start

```bash
npm install
npm run build
```

1. Open `chrome://extensions`
2. Turn on **Developer mode**
3. **Load unpacked** → select the `dist/` folder
4. Open or reload <https://claude.ai>

A save icon appears in the bottom-right corner. It is enabled on conversations
and dimmed everywhere else. Click it; you get a Markdown file.

---

## Why it is fast

Three things made saving feel slow. All are gone:

- **No work on page load.** An earlier build called `GET /api/bootstrap` on
  every claude.ai page to draw a usage chip. The extension now makes no network
  call until you click.
- **The org is cached.** `/api/bootstrap` is a large response and the
  organization does not change, so it is fetched at most once per browser
  profile. Only the conversation itself is fetched per click.
- **Nothing is rendered twice.** The old save dialog called `renderPrompt`
  purely to count characters for a size preview — the entire transcript was
  built twice per save. With no preview, it is built once.

Measured in a live tab: the spinner appears **59 ms** after the click. The
remaining ~2.5 s is the conversation API round trip, which is the data itself.

`dist/` is 21.8 KB total.

---

## What the Markdown looks like

```markdown
# Contoh soal yang membingungkan

- Source: https://claude.ai/chat/9d8626c6-…
- Model: claude-sonnet-5-5
- Started: 2026-10-12T15:15:24.544444Z
- Exported: 2026-10-14T02:50:44.132Z
- 2 turns · 0 tool calls

---

## Turn 1 · User

tolong buatkan contoh soal kayak gini, …

## Turn 2 · Assistant

> **Thinking** — Menyusun soal latihan

Berikut contoh soalnya…
```

Thinking becomes a blockquote, tool calls and results become fenced blocks, and
files are recorded as a note rather than silently dropped:

```
*[File omitted: 1000391085.jpg (418 KB) — contents cannot be moved between accounts.]*
```

The filename is the conversation's own title, slugged: `Contoh soal yang
membingungkan` → `contoh-soal-yang-membingungkan.md`.

---

## How it works

```
claude.ai page
├── main-world.js   (MAIN world)     owns fetch() → claude.ai API
└── content.js      (ISOLATED world) owns the UI and chrome.* APIs
        └── talks to main-world.js over window.postMessage
```

Two worlds because the claude.ai API is **cookie-authenticated and same-origin
only**. A content script in the isolated world cannot reliably make an
authenticated same-origin request; a script in the `MAIN` world is literally the
page, so first-party cookies attach automatically and there is no CORS
preflight. `world: "MAIN"` also bypasses page CSP.

`src/types/protocol.ts` is the shared, dependency-free contract between them.

### Source layout

| Path | Role |
|---|---|
| `src/core/markdown.ts` | Conversation → Markdown, plus the filename rule. |
| `src/core/tree.ts` | Resolves the active branch. |
| `src/core/api.ts` | **The only module that knows claude.ai URLs.** |
| `src/core/storage.ts` | `chrome.storage` with dead-context detection. |
| `src/content/exportSession.ts` | Click → fetch → render → download. |
| `src/content/ui/fab.ts` | The button and its state machine. |
| `src/bridge/` | The two-world RPC. |
| `tests/` | 69 tests. `npm test`. |

---

## The API this depends on

claude.ai's JSON API is private and unversioned. Verified 2026-10-13. Auth is
**first-party session cookies only** — no API key, and notably *not* an
`anthropic-version` header.

| Purpose | Request |
|---|---|
| Account + orgs | `GET /api/bootstrap` (cached per profile) |
| Read conversation | `GET /api/organizations/{org}/chat_conversations/{uuid}?tree=True&rendering_mode=messages&render_all_tools=true&include_inline_comparison=true&consistency=strong` |

Note the capital-T `tree=True`. The plausible-looking
`/chat_conversations/{uuid}/tree` route returns 404.

Re-derive both from DevTools → Network if either stops working;
`src/core/api.ts` is the only file that needs to change.

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
`[2, 3]`. The file header states how many branch messages were left out.

---

## Privacy

Everything stays on your machine. The extension talks only to `https://claude.ai`
and caches one organization id in `chrome.storage.local`. There is no server, no
API key, and no analytics. Permissions: `storage`, and host access to
`https://claude.ai`.

---

## Development

```bash
npm run dev        # rebuild dist/ on change
npm run typecheck  # tsc --noEmit, strict
npm test           # 69 tests
npm run build      # typecheck + build
```

`tests/fab.test.ts` mounts the button against jsdom rather than testing it
through injected fakes. Logic tests missed three mount-time faults that only
showed up in a browser — a temporal-dead-zone reference, an append to the host
instead of the shadow root, and an SVG built without its namespace. If you
touch the UI, keep mounting it.

---

## Licence

No licence file yet — add one before distributing this.

[implementation_plan.md](./implementation_plan.md) records the original design
and the API findings this was built on. [BACKLOG.md](./BACKLOG.md) lists what
was tried and why it was dropped.