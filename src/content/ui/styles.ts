/**
 * Styles for the save-only build.
 *
 * Kept as a string so the UI lives inside a shadow root with no stylesheet
 * fetches (content scripts cannot use `chrome.runtime.getURL` for CSS assets
 * without extra web_accessible_resources entries).
 *
 * Positioning lives on the elements, never on `:host` - the host carries an
 * inline `all: initial` reset, and an inline style would beat any `:host` rule.
 * `pointer-events: none` on the host keeps the extension from swallowing clicks
 * meant for the page; interactive roots opt back in.
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
  --sext-radius: 10px;
  --sext-shadow: 0 4px 14px rgba(0,0,0,.14), 0 1px 3px rgba(0,0,0,.08);
  --sext-font: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;

  pointer-events: none;
  font-family: var(--sext-font);
  font-size: 13px;
  line-height: 1.45;
  color: var(--sext-fg);
}

@media (prefers-color-scheme: dark) {
  :host {
    --sext-bg: #2b2b29;
    --sext-fg: #f2f1ee;
    --sext-muted: #a3a19c;
    --sext-line: #3d3c39;
    --sext-accent: #e0835c;
    --sext-accent-fg: #1a1a19;
    --sext-soft: #323230;
    --sext-danger: #f2b8b5;
    --sext-shadow: 0 4px 14px rgba(0,0,0,.45), 0 1px 3px rgba(0,0,0,.35);
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
button:disabled { cursor: not-allowed; }
button.primary { background: var(--sext-accent); color: var(--sext-accent-fg); border-color: transparent; font-weight: 600; }
button.primary:hover:not(:disabled) { opacity: .9; background: var(--sext-accent); }
button.ghost { border-color: transparent; background: transparent; }

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

/* ---- floating action button ---- */
.fab-wrap {
  position: fixed;
  right: 14px;
  bottom: 14px;
  z-index: 2147483000;
  pointer-events: none;
}

.fab {
  pointer-events: auto;
  position: relative;
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  padding: 0;
  border-radius: 50%;
  border: 1px solid var(--sext-line);
  background: var(--sext-bg);
  color: var(--sext-muted);
  box-shadow: var(--sext-shadow);
  opacity: .55;
  transition: opacity .15s ease, color .15s ease, transform .15s ease;
}
.fab:hover:not(:disabled), .fab:focus-visible { opacity: 1; color: var(--sext-fg); }
.fab:active:not(:disabled) { transform: scale(.94); }
.fab:disabled { color: var(--sext-muted); }

/* Tooltip, revealed on hover only. */
.fab-tip {
  position: absolute;
  right: calc(100% + 8px);
  top: 50%;
  transform: translateY(-50%) translateX(4px);
  white-space: nowrap;
  font-size: 11.5px;
  color: var(--sext-muted);
  background: var(--sext-bg);
  border: 1px solid var(--sext-line);
  border-radius: 6px;
  padding: 3px 7px;
  box-shadow: var(--sext-shadow);
  opacity: 0;
  pointer-events: none;
  transition: opacity .12s ease, transform .12s ease;
}
.fab:hover .fab-tip, .fab:focus-visible .fab-tip {
  opacity: 1;
  transform: translateY(-50%) translateX(0);
}

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
  width: min(560px, 100%);
  max-height: min(80vh, 700px);
  overflow: auto;
  padding: 18px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.panel h2 { margin: 0; font-size: 15px; font-weight: 650; }

.row { display: flex; flex-direction: column; gap: 6px; }
.actions { display: flex; gap: 8px; justify-content: flex-end; align-items: center; }
.actions .grow { flex: 1; }

.muted { color: var(--sext-muted); }
.small { font-size: 11.5px; }

.checkbox { display: flex; align-items: center; gap: 7px; cursor: pointer; }
.checkbox input { margin: 0; }

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

.toast {
  position: fixed;
  right: 14px;
  bottom: 58px;
  max-width: 300px;
  padding: 9px 11px;
  border-radius: 9px;
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