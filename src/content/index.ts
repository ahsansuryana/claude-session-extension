import { installBridge } from '../bridge/port';
import { mountFab } from './ui/fab';
import { STYLES } from './ui/styles';
import { onRouteChange, parseRoute, type Route } from './router';

/**
 * Content-script entry point.
 *
 * One 34px button that exports the current conversation to Markdown. Nothing
 * runs on page load - no API call, no dialog - because every extra request
 * makes claude.ai itself feel slower.
 *
 * Network calls go through the MAIN-world bridge, which owns `fetch`;
 * `chrome.*` stays here in the isolated world.
 */

const HOST_ID = 'session-transfer-host';

/** Bumped when the UI shape changes, so a stale host is replaced. */
const UI_VERSION = '3';

function createUi(): ShadowRoot {
  const existing = document.getElementById(HOST_ID);
  if (existing instanceof HTMLElement && existing.dataset.sextVersion === UI_VERSION) {
    return existing.shadowRoot as ShadowRoot;
  }
  // A tab that outlived an extension update would otherwise keep the old
  // stylesheet and the old UI with no explanation.
  existing?.remove();

  const host = document.createElement('div');
  host.id = HOST_ID;
  host.dataset.sextVersion = UI_VERSION;
  host.setAttribute('data-sext', 'host');
  // `all: initial` resets every inherited property; `pointer-events: none`
  // guarantees the host never swallows clicks meant for the page.
  host.style.cssText = 'all: initial; pointer-events: none';

  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = STYLES;
  root.appendChild(style);

  document.documentElement.appendChild(host);
  return root;
}

function main(): void {
  const root = createUi();
  installBridge();

  const fab = mountFab({ root });
  const apply = (route: Route): void => fab.setEnabled(route.kind === 'chat');
  onRouteChange(apply);
  apply(parseRoute(location.pathname));

  window.addEventListener('pagehide', () => fab.destroy(), { once: true });
}

/** Mount the extension, surfacing any failure instead of dying silently. */
function start(): void {
  try {
    main();
  } catch (error) {
    console.error('[Session Transfer] failed to mount:', error);
    const root = document.getElementById(HOST_ID)?.shadowRoot;
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
  document.addEventListener('DOMContentLoaded', start, { once: true });
} else {
  start();
}