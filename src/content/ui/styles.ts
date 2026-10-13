/**
 * Dock styles. Kept as a string so the whole UI can live inside a shadow root
 * with no stylesheet fetches (content scripts cannot use `chrome.runtime.getURL`
 * for CSS assets without extra web_accessible_resources entries).
 *
 * Positioning lives on `.dock` / `.overlay` / `.toast`, never on `:host`: the
 * host element carries an inline `all: initial` reset, and an inline style
 * would beat any `:host` rule here.
 *
 * `pointer-events: none` on the host keeps the extension from swallowing clicks
 * meant for the page; it is inherited, so each interactive root opts back in.
 */

export const STYLES = `
:host, * { box-sizing: border-box; }

:host {
  --sext-bg: #ffffff;
  --sext-fg: #1a1a19;
  --sext-muted: #6b6b68;
  --sext-line: #e3e2df;
  --sext-accent: #c96442;
  --sext-accent-fg: #ffffff;
  --sext-soft: #f5f4f2;
  --sext-danger: #b3261e;
  --sext-warn: #8a5a00;
  --sext-ok: #1e6b3a;
  --sext-radius: 12px;
  --sext-shadow: 0 8px 28px rgba(0,0,0,.16), 0 2px 6px rgba(0,0,0,.08);
  --sext-font: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --sext-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;

  pointer-events: none;
  font-family: var(--sext-font);
  font-size: 13px;
  line-height: 1.45;
  color: var(--sext-fg);
}

@media (prefers-color-scheme: dark) {
  :host {
    --sext-bg: #262624;
    --sext-fg: #f2f1ee;
    --sext-muted: #a3a19c;
    --sext-line: #3d3c39;
    --sext-accent: #e0835c;
    --sext-accent-fg: #1a1a19;
    --sext-soft: #323230;
    --sext-danger: #f2b8b5;
    --sext-warn: #e5c07b;
    --sext-ok: #7fd6a0;
    --sext-shadow: 0 8px 28px rgba(0,0,0,.5), 0 2px 6px rgba(0,0,0,.4);
  }
}

button {
  font: inherit;
  cursor: pointer;
  border-radius: 8px;
  border: 1px solid var(--sext-line);
  background: var(--sext-bg);
  color: var(--sext-fg);
  padding: 6px 10px;
  transition: background .12s ease, border-color .12s ease, opacity .12s ease;
}
button:hover:not(:disabled) { background: var(--sext-soft); }
button:focus-visible { outline: 2px solid var(--sext-accent); outline-offset: 2px; }
button:disabled { opacity: .5; cursor: not-allowed; }
button.primary { background: var(--sext-accent); color: var(--sext-accent-fg); border-color: transparent; font-weight: 600; }
button.primary:hover:not(:disabled) { opacity: .9; background: var(--sext-accent); }
button.ghost { border-color: transparent; background: transparent; }
button.ghost:hover:not(:disabled) { background: var(--sext-soft); }
button.danger { color: var(--sext-danger); }

input[type="text"], textarea, select {
  font: inherit;
  width: 100%;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--sext-line);
  background: var(--sext-bg);
  color: var(--sext-fg);
}
input:focus-visible, textarea:focus-visible, select:focus-visible {
  outline: 2px solid var(--sext-accent);
  outline-offset: -1px;
  border-color: transparent;
}
input[type="checkbox"] { accent-color: var(--sext-accent); }

/* ---- dock ---- */
.dock {
  position: fixed;
  right: 18px;
  bottom: 18px;
  z-index: 2147483000;
  pointer-events: auto;
  background: var(--sext-bg);
  border: 1px solid var(--sext-line);
  border-radius: var(--sext-radius);
  box-shadow: var(--sext-shadow);
  overflow: hidden;
  min-width: 260px;
  max-width: 320px;
}

.dock-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  background: var(--sext-soft);
  border-bottom: 1px solid var(--sext-line);
}
.dock-title { font-weight: 600; font-size: 12px; letter-spacing: .01em; }
.dock-spacer { flex: 1; }
.dock-body { padding: 10px; display: flex; flex-direction: column; gap: 8px; }
.dock-actions { display: flex; gap: 8px; }
.dock-actions button { flex: 1; }
.dock-foot { font-size: 11px; color: var(--sext-muted); }

.chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  padding: 3px 8px;
  border-radius: 999px;
  border: 1px solid var(--sext-line);
  background: var(--sext-bg);
  cursor: pointer;
  white-space: nowrap;
}
.chip:hover { background: var(--sext-soft); }
.chip-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--sext-muted); }
.chip-ok .chip-dot { background: var(--sext-ok); }
.chip-warn .chip-dot { background: var(--sext-warn); }
.chip-danger { border-color: var(--sext-danger); color: var(--sext-danger); }
.chip-danger .chip-dot { background: var(--sext-danger); }

/* ---- modal ---- */
.overlay {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,.45);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  z-index: 2147483100;
  pointer-events: auto;
}
.panel {
  background: var(--sext-bg);
  color: var(--sext-fg);
  border-radius: 14px;
  border: 1px solid var(--sext-line);
  box-shadow: var(--sext-shadow);
  width: min(620px, 100%);
  max-height: min(80vh, 720px);
  overflow: auto;
  padding: 18px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.panel h2 { margin: 0; font-size: 15px; font-weight: 650; }
.panel h3 { margin: 0 0 6px; font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: var(--sext-muted); }

.row { display: flex; flex-direction: column; gap: 6px; }
.row-inline { display: flex; align-items: center; gap: 8px; }
.actions { display: flex; gap: 8px; justify-content: flex-end; align-items: center; }
.actions .grow { flex: 1; }

.muted { color: var(--sext-muted); }
.small { font-size: 11.5px; }
.mono { font-family: var(--sext-mono); font-size: 11.5px; }

.checkbox { display: flex; align-items: center; gap: 7px; cursor: pointer; }
.checkbox input { margin: 0; }

.tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--sext-line); }
.tab {
  border: none;
  border-bottom: 2px solid transparent;
  border-radius: 0;
  background: transparent;
  padding: 7px 10px;
  color: var(--sext-muted);
}
.tab[aria-selected="true"] { color: var(--sext-fg); border-bottom-color: var(--sext-accent); font-weight: 600; }

.list { display: flex; flex-direction: column; gap: 4px; max-height: 260px; overflow: auto; }
.list-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
  text-align: left;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid transparent;
  background: transparent;
}
.list-item:hover { background: var(--sext-soft); }
.list-item[aria-pressed="true"] { border-color: var(--sext-accent); background: var(--sext-soft); }
.list-item .name { font-weight: 550; }
.list-item .meta { font-size: 11px; color: var(--sext-muted); }

.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(96px, 1fr)); gap: 8px; }
.stat { background: var(--sext-soft); border-radius: 8px; padding: 8px 10px; }
.stat .k { font-size: 10.5px; text-transform: uppercase; letter-spacing: .05em; color: var(--sext-muted); }
.stat .v { font-size: 15px; font-weight: 650; }

.notice {
  border-radius: 8px;
  padding: 9px 11px;
  font-size: 12px;
  border: 1px solid var(--sext-line);
  background: var(--sext-soft);
}
.notice-error { border-color: var(--sext-danger); color: var(--sext-danger); }
.notice-warn { border-color: var(--sext-warn); color: var(--sext-warn); }

.limits { display: flex; flex-direction: column; gap: 8px; }
.limit-row { display: flex; flex-direction: column; gap: 4px; }
.limit-head { display: flex; justify-content: space-between; font-size: 11.5px; }
.bar { height: 6px; border-radius: 999px; background: var(--sext-soft); overflow: hidden; }
.bar-fill { height: 100%; background: var(--sext-ok); border-radius: 999px; }
.bar-fill.warn { background: var(--sext-warn); }
.bar-fill.over { background: var(--sext-danger); }

.progress { height: 6px; border-radius: 999px; background: var(--sext-soft); overflow: hidden; }
.progress-fill { height: 100%; background: var(--sext-accent); transition: width .2s ease; }

.toast {
  position: fixed;
  right: 18px;
  bottom: 18px;
  max-width: 320px;
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--sext-bg);
  border: 1px solid var(--sext-line);
  box-shadow: var(--sext-shadow);
  font-size: 12.5px;
  z-index: 2147483200;
  pointer-events: auto;
  transition: opacity .5s ease, transform .3s ease;
}
.toast-out { opacity: 0; transform: translateY(6px); }
.toast-error { border-color: var(--sext-danger); color: var(--sext-danger); }

@media (prefers-reduced-motion: reduce) {
  * { transition: none !important; animation: none !important; }
}
`;

export default STYLES;