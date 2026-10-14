import { clear, h, svg } from './dom';

export interface FabHandle {
  /** Enable or disable according to the route. */
  setEnabled(enabled: boolean): void;
  destroy(): void;
}

export interface FabOptions {
  root: ShadowRoot;
  onSave: () => void;
}

/**
 * A single 34px save button, bottom-right, inside the extension's shadow root.
 *
 * Deliberately a floating action button rather than a panel: anything with a
 * title bar, a limits chip or two buttons covered enough of claude.ai's own UI
 * to get in the way. One glyph, 34x34, fades to 55% opacity until hover, and
 * gets out of the way entirely on non-conversation pages.
 */
export function mountFab(opts: FabOptions): FabHandle {
  const { root } = opts;

  // Without fill="none" and stroke, every shape renders as a filled black
  // blob rather than an outline.
  const stroke = {
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.8',
    'stroke-linecap': 'round' as const,
    'stroke-linejoin': 'round' as const,
  };

  const icon = svg(
    'svg',
    { viewBox: '0 0 24 24', width: '16', height: '16', 'aria-hidden': 'true' },
    svg('path', { ...stroke, d: 'M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z' }),
    svg('polyline', { ...stroke, points: '17 21 17 13 7 13 7 21' }),
    svg('polyline', { ...stroke, points: '7 3 7 8 15 8' }),
  );

  const label = h('span', { class: 'fab-tip' }, 'Save session');

  const button = h(
    'button',
    {
      class: 'fab',
      type: 'button',
      'aria-label': 'Save session',
      title: 'Save this conversation',
      onclick: () => opts.onSave(),
    },
    icon,
    label,
  );

  const wrap = h('div', { class: 'fab-wrap' });
  wrap.appendChild(button);
  root.appendChild(wrap);

  return {
    setEnabled(enabled: boolean): void {
      button.disabled = !enabled;
      label.textContent = enabled ? 'Save session' : 'Open a conversation first';
      button.title = enabled
        ? 'Save this conversation'
        : 'Open a conversation first';
      wrap.classList.toggle('is-disabled', !enabled);
    },
    destroy(): void {
      clear(root);
      wrap.remove();
    },
  };
}