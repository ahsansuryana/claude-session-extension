import { call, installBridge } from '../bridge/port';
import { getSettings } from '../core/settings';
import { isExtensionGone, storageGet, storageSet } from '../core/storage';
import { STORAGE_KEYS, type ImportResumeToken } from '../types/session';
import type { ClaudeUsage } from '../types/claude';
import { mountDock } from './ui/dock';
import { STYLES } from './ui/styles';
import { currentConversationUuid, onRouteChange, parseRoute } from './router';
import { openSaveDialog } from './saveDialog';
import { openImportDialog } from './importDialog';

/**
 * Content-script entry point.
 *
 * Mounts one shadow root on claude.ai and keeps it in sync with the SPA route.
 * Everything network-facing goes through the MAIN-world bridge; everything
 * `chrome.*`-facing stays here in the isolated world.
 */

const HOST_ID = 'session-transfer-host';

interface Ui {
  /** Element that owns the shadow root. Never append UI here. */
  host: HTMLElement;
  /** Where all UI must be appended. */
  root: ShadowRoot;
}

function createUi(): Ui {
  const existing = document.getElementById(HOST_ID);
  if (existing instanceof HTMLElement && existing.shadowRoot) {
    return { host: existing, root: existing.shadowRoot };
  }

  const host = document.createElement('div');
  host.id = HOST_ID;
  host.setAttribute('data-sext', 'host');
  // `all: initial` resets every inherited property; `pointer-events: none`
  // (declared explicitly because an inline style would beat the stylesheet's
  // `:host` rule) guarantees the host never swallows clicks meant for the
  // page. `.dock` / `.overlay` / `.toast` opt back in.
  host.style.cssText = 'all: initial; pointer-events: none';

  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = STYLES;
  root.appendChild(style);

  document.documentElement.appendChild(host);
  return { host, root };
}

async function main(): Promise<void> {
  const { root } = createUi();
  installBridge();

  let usage: ClaudeUsage | null = null;
  let orgUuid = '';

  const dock = mountDock({
    root,
    usage: () => usage,
    orgUuid: () => orgUuid,
    onSave: () => {
      void openSaveDialog({
        root,
        conversationUuid: currentConversationUuid,
      });
    },
    onImport: () => {
      openImportDialog({
        root,
        onImported: (uuid) => {
          location.assign(`/chat/${uuid}`);
        },
      });
    },
  });

  onRouteChange((route) => dock.refresh(route));

  // Usage is advisory: a failure here must never break saving or importing.
  void (async () => {
    try {
      const org = await call<{ org: string }>('resolveActiveOrg', {});
      orgUuid = org.org;
      usage = await call<ClaudeUsage>('getUsage', { org: org.org });
      await storageSet({
        [STORAGE_KEYS.limitsSnapshot]: { usage, at: Date.now(), org: org.org },
      });
      const raw = await storageGet(STORAGE_KEYS.resumeToken);
      const pending = raw[STORAGE_KEYS.resumeToken] as ImportResumeToken | undefined;
      if (pending) {
        chrome.runtime
          .sendMessage({ type: 'sext:resume-pending', sessionName: pending.session_name })
          .catch(() => undefined);
      }
    } catch (error) {
      usage = null;
      // Reloading the extension orphans the content script in every open tab;
      // say so instead of leaving a dead dock behind.
      if (isExtensionGone(error)) {
        showReloadNotice(root);
        return;
      }
    }
    dock.refresh(parseRoute(location.pathname));
  })();

  void getSettings().catch(() => undefined);
  window.addEventListener('pagehide', () => dock.destroy(), { once: true });
}

/** Tell the user to reload after the extension context died. */
function showReloadNotice(root: ShadowRoot): void {
  if (root.querySelector('[data-sext="reload-notice"]')) return;
  const banner = document.createElement('div');
  banner.className = 'overlay';
  banner.setAttribute('data-sext', 'reload-notice');
  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.innerHTML =
    '<h2>Extension reloaded</h2>' +
    '<p class="muted small">Session Transfer was updated, so this tab lost its connection to the ' +
    'extension. Reload this tab to carry on.</p>' +
    '<div class="actions"><button class="primary" type="button">Reload tab</button></div>';
  panel.querySelector('button')?.addEventListener('click', () => location.reload());
  banner.appendChild(panel);
  root.appendChild(banner);
}

/** Mount the extension, surfacing any failure instead of dying silently. */
async function start(): Promise<void> {
  try {
    await main();
  } catch (error) {
    console.error('[Session Transfer] failed to mount:', error);
    const host = document.getElementById(HOST_ID);
    const root = host?.shadowRoot;
    if (!root) return;
    const banner = document.createElement('div');
    banner.className = 'notice notice-error';
    banner.textContent = `Session Transfer failed to start: ${
      error instanceof Error ? error.message : String(error)
    }`;
    root.appendChild(banner);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => void start(), { once: true });
} else {
  void start();
}