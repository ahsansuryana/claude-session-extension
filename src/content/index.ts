import { call, installBridge } from '../bridge/port';
import { isExtensionGone } from '../core/storage';
import { mountFab, type FabHandle } from './ui/fab';
import { STYLES } from './ui/styles';
import { currentConversationUuid, onRouteChange, parseRoute, type Route } from './router';
import { openSaveDialog } from './saveDialog';

/**
 * Content-script entry point.
 *
 * Save-only build: one 34px button. Import and usage tracking were removed on
 * the `save-only` branch; the transfer code still lives on `main`.
 *
 * Everything network-facing goes through the MAIN-world bridge, which owns
 * `fetch`; everything `chrome.*`-facing stays here in the isolated world.
 */

const HOST_ID = 'session-transfer-host';

/**
 * Bumped whenever `STYLES` changes shape. A tab that outlives an extension
 * update would otherwise keep the old stylesheet (and the old UI) with no
 * explanation, because re-using the host is what makes mounting idempotent.
 */
const UI_VERSION = '1';

interface Ui {
  /** Element that owns the shadow root. Never append UI here. */
  host: HTMLElement;
  /** Where all UI must be appended. */
  root: ShadowRoot;
}

function createUi(): Ui {
  const existing = document.getElementById(HOST_ID);
  if (existing instanceof HTMLElement && existing.dataset.sextVersion === UI_VERSION) {
    return { host: existing, root: existing.shadowRoot as ShadowRoot };
  }
  // Stale host from a previous build: replace it rather than layering new UI
  // on top of old styles.
  existing?.remove();

  const host = document.createElement('div');
  host.id = HOST_ID;
  host.dataset.sextVersion = UI_VERSION;
  host.setAttribute('data-sext', 'host');
  // `all: initial` resets every inherited property; `pointer-events: none`
  // guarantees the host never swallows clicks meant for the page. The FAB opts
  // back in.
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

  const fab: FabHandle = mountFab({
    root,
    onSave: () => {
      void openSaveDialog({ root, conversationUuid: currentConversationUuid });
    },
  });

  const apply = (route: Route): void => fab.setEnabled(route.kind === 'chat');
  onRouteChange(apply);
  apply(parseRoute(location.pathname));

  // Touch the API once so a dead extension context is reported here rather
  // than on the user's first save.
  void call('resolveActiveOrg', {}).catch((error: unknown) => {
    if (isExtensionGone(error)) showReloadNotice(root);
  });

  window.addEventListener('pagehide', () => fab.destroy(), { once: true });
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