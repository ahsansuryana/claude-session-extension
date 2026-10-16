import { currentConversationUuid } from '../router';
import { exportCurrentConversation } from '../exportSession';
import { isExtensionGone } from '../../core/storage';
import { clear, h, svg, toast } from './dom';

export type FabState = 'idle' | 'busy' | 'done' | 'error';

export interface FabHandle {
  /** Enable or disable according to the route. */
  setEnabled(enabled: boolean): void;
  setState(state: FabState): void;
  destroy(): void;
}

export interface FabOptions {
  root: ShadowRoot;
}

const STROKE = {
  fill: 'none',
  stroke: 'currentColor',
  'stroke-width': '1.8',
  'stroke-linecap': 'round' as const,
  'stroke-linejoin': 'round' as const,
};

/** Floppy-disk outline. */
const SAVE_ICON = (): SVGElement =>
  svg(
    'svg',
    { viewBox: '0 0 24 24', width: '16', height: '16', 'aria-hidden': 'true' },
    svg('path', { ...STROKE, d: 'M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z' }),
    svg('polyline', { ...STROKE, points: '17 21 17 13 7 13 7 21' }),
    svg('polyline', { ...STROKE, points: '7 3 7 8 15 8' }),
  );

/** Three-quarter ring, spun by CSS. */
const SPIN_ICON = (): SVGElement =>
  svg(
    'svg',
    { viewBox: '0 0 24 24', width: '16', height: '16', 'aria-hidden': 'true', class: 'spin' },
    svg('circle', { ...STROKE, cx: '12', cy: '12', r: '9', 'stroke-opacity': '.25' }),
    svg('path', { ...STROKE, d: 'M21 12a9 9 0 0 0-9-9' }),
  );

const CHECK_ICON = (): SVGElement =>
  svg(
    'svg',
    { viewBox: '0 0 24 24', width: '16', height: '16', 'aria-hidden': 'true' },
    svg('polyline', { ...STROKE, points: '20 6 9 17 4 12' }),
  );

const ALERT_ICON = (): SVGElement =>
  svg(
    'svg',
    { viewBox: '0 0 24 24', width: '16', height: '16', 'aria-hidden': 'true' },
    svg('circle', { ...STROKE, cx: '12', cy: '12', r: '9' }),
    svg('line', { ...STROKE, x1: '12', y1: '8', x2: '12', y2: '12' }),
    svg('line', { ...STROKE, x1: '12', y1: '16', x2: '12.01', y2: '16' }),
  );

const ICONS: Record<FabState, () => SVGElement> = {
  idle: SAVE_ICON,
  busy: SPIN_ICON,
  done: CHECK_ICON,
  error: ALERT_ICON,
};

/**
 * A single 34px button, bottom-right, inside the extension's shadow root.
 *
 * Clicking exports the current conversation to Markdown straight away - there
 * is no dialog to open, no preview to render and no vault to write, which is
 * what makes it feel instant.
 */
export function mountFab(opts: FabOptions): FabHandle {
  const { root } = opts;

  const glyph = h('span', { class: 'fab-glyph' });
  const tip = h('span', { class: 'fab-tip' }, 'Save session');

  const button = h(
    'button',
    {
      class: 'fab',
      type: 'button',
      'aria-label': 'Save session as Markdown',
      title: 'Save this conversation as Markdown',
      onclick: () => void onClick(),
    },
    glyph,
    tip,
  );

  const wrap = h('div', { class: 'fab-wrap' });
  wrap.appendChild(button);
  root.appendChild(wrap);

  let state: FabState = 'idle';
  let enabled = false;
  let resetTimer: ReturnType<typeof setTimeout> | null = null;

  function paint(): void {
    clear(glyph);
    glyph.appendChild(ICONS[state]());
    button.setAttribute('aria-busy', String(state === 'busy'));
    wrap.dataset.state = state;

    const busy = state === 'busy';
    button.disabled = busy || !enabled;
    button.classList.toggle('is-busy', busy);

    const tips: Record<FabState, string> = {
      idle: enabled ? 'Save session as .md' : 'Open a conversation first',
      busy: 'Saving…',
      done: 'Saved',
      error: 'Failed - click to retry',
    };
    tip.textContent = tips[state];
    button.title = tips[state];
  }

  function setState(next: FabState): void {
    state = next;
    paint();
    if (resetTimer) clearTimeout(resetTimer);
    // done/error settle back to idle so the button is reusable.
    if (next === 'done' || next === 'error') {
      resetTimer = setTimeout(() => {
        resetTimer = null;
        setState('idle');
      }, 1600);
    }
  }

  async function onClick(): Promise<void> {
    const uuid = currentConversationUuid();
    if (!uuid) {
      setState('error');
      return;
    }

    setState('busy');
    try {
      const result = await exportCurrentConversation(uuid);
      setState('done');
      toast(root, `Saved ${result.filename} · ${result.summary}`);
    } catch (error) {
      setState('error');
      // Reloading the extension orphans this tab; say so instead of showing a
      // raw platform error.
      toast(
        root,
        isExtensionGone(error)
          ? 'Extension was reloaded - reload this tab'
          : error instanceof Error
            ? error.message
            : String(error),
        'error',
      );
    }
  }

  paint();

  return {
    setEnabled(next: boolean): void {
      enabled = next;
      wrap.classList.toggle('is-disabled', !next);
      paint();
    },
    setState,
    destroy(): void {
      if (resetTimer) clearTimeout(resetTimer);
      wrap.remove();
      clear(root);
    },
  };
}