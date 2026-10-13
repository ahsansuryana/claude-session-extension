import type { ClaudeUsage } from '../../types/claude';
import { clear, h } from './dom';
import { chipState, readCachedSessionLimit, renderLimitDetail, summariseUsage } from './limits';

export interface DockHandle {
  refresh(route: { kind: string }): void;
  destroy(): void;
}

export interface DockCallbacks {
  onSave: () => void;
  onImport: () => void;
}

export interface DockOptions {
  /** Shadow root to render into - never the host element itself. */
  root: ShadowRoot;
  usage: () => ClaudeUsage | null;
  /** Resolved org, used to read claude.ai's cached usage when the API is empty. */
  orgUuid: () => string;
  onSave: () => void;
  onImport: () => void;
}

/**
 * Floating dock, bottom-right, inside the extension's own shadow root.
 *
 * Deliberately fixed-position rather than anchored into claude.ai's composer:
 * the app's DOM is regenerated constantly and its class names are build-hashed,
 * so anything coupled to its internals breaks on the next deploy.
 */
export function mountDock(opts: DockOptions): DockHandle {
  const { root } = opts;

  const dock = h('div', { class: 'dock', 'data-sext': 'dock' });
  const bar = h('div', { class: 'dock-bar' });
  const chipSlot = h('div', { class: 'dock-spacer' });
  const body = h('div', { class: 'dock-body' });

  bar.appendChild(h('span', { class: 'dock-title' }, 'Session Transfer'));
  bar.appendChild(chipSlot);
  dock.appendChild(bar);
  dock.appendChild(body);
  root.appendChild(dock);

  const summary = (): ReturnType<typeof summariseUsage> =>
    summariseUsage(opts.usage(), Date.now(), readCachedSessionLimit(opts.orgUuid()));

  const paintChip = (): void => {
    const s = summary();
    const chip = chipState(s);
    clear(chipSlot);
    chipSlot.appendChild(
      h(
        'button',
        {
          class: `chip chip-${chip.kind}${s.exceeded ? ' chip-danger' : ''}`,
          type: 'button',
          title: s.unknown
            ? 'This organization did not report usage limits.'
            : s.rows.map((r) => `${r.label}: ${Math.round(r.percent)}%`).join(' · '),
        },
        h('span', { class: 'chip-dot' }),
        chip.text,
      ),
    );
  };

  const currentKind = (): string => (location.pathname.startsWith('/chat/') ? 'chat' : 'new');

  const toggleDetail = (): void => {
    if (body.dataset.mode === 'limits') {
      renderActions(currentKind());
      return;
    }
    body.dataset.mode = 'limits';
    clear(body);
    renderLimitDetail(body, summary(), {
      onSaveAndMove: () => opts.onSave(),
    });
    body.appendChild(
      h(
        'button',
        {
          class: 'ghost',
          type: 'button',
          onclick: () => renderActions(currentKind()),
        },
        '← Back',
      ),
    );
  };

  chipSlot.addEventListener('click', (event) => {
    if ((event.target as HTMLElement).closest('.chip')) toggleDetail();
  });

  function renderActions(kind: string = currentKind()): void {
    delete body.dataset.mode;
    clear(body);

    const actions = h('div', { class: 'dock-actions' });

    const save = h('button', { class: 'primary', type: 'button' }, 'Save session');
    save.disabled = kind !== 'chat';
    save.title =
      kind === 'chat'
        ? 'Capture this conversation so it can be continued in another profile'
        : 'Open a conversation first';
    save.addEventListener('click', () => opts.onSave());
    actions.appendChild(save);

    const importBtn = h('button', { type: 'button' }, 'Import chat');
    importBtn.title = 'Import a saved session into this profile';
    importBtn.addEventListener('click', () => opts.onImport());
    actions.appendChild(importBtn);

    body.appendChild(actions);
    body.appendChild(
      h(
        'div',
        { class: 'dock-foot' },
        kind === 'chat'
          ? 'Saved sessions stay in this browser profile. Download the file to move them elsewhere.'
          : 'Open a conversation to save it. Importing works from any page.',
      ),
    );
  }

  const initialKind = location.pathname.startsWith('/chat/') ? 'chat' : 'new';
  renderActions(initialKind);
  paintChip();

  return {
    refresh(route): void {
      // Preserve the open limits popover across route changes.
      if (body.dataset.mode !== 'limits') renderActions(route.kind);
      else {
        renderLimitDetail(body, summary(), {
          onSaveAndMove: () => opts.onSave(),
        });
      }
      paintChip();
    },
    destroy(): void {
      dock.remove();
    },
  };
}