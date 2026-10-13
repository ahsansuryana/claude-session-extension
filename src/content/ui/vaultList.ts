import { clear, h } from './dom';
import type { VaultEntryMeta } from '../../types/session';

export interface VaultListOptions {
  emptyMessage?: string;
  onSelect: (meta: VaultEntryMeta) => void;
  onDelete?: (meta: VaultEntryMeta) => void;
}

/** Render the saved-session picker. Returns the container so callers can refresh. */
export function renderVaultList(
  entries: VaultEntryMeta[],
  selectedId: string | null,
  opts: VaultListOptions,
): HTMLElement {
  const container = h('div', { class: 'list' });

  if (entries.length === 0) {
    container.appendChild(
      h(
        'div',
        { class: 'notice' },
        opts.emptyMessage ??
          'Nothing saved in this profile yet. Save a session here, or import a .claude-session.json file.',
      ),
    );
    return container;
  }

  for (const entry of entries) {
    const row = h(
      'button',
      {
        class: 'list-item',
        type: 'button',
        'aria-pressed': String(entry.bundle_id === selectedId),
        onclick: () => opts.onSelect(entry),
      },
      h('span', { class: 'name' }, entry.session_name),
      h(
        'span',
        { class: 'meta' },
        [
          entry.message_count === 1 ? '1 turn' : `${entry.message_count} turns`,
          entry.origin === 'imported' ? 'imported' : 'saved',
          formatWhen(entry.saved_at),
          entry.account_email ?? 'unknown account',
        ].join(' · '),
      ),
    );

    if (opts.onDelete) {
      const del = h('button', {
        class: 'ghost danger',
        type: 'button',
        title: 'Delete from this profile',
        'aria-label': `Delete ${entry.session_name}`,
        onclick: (event: Event) => {
          event.stopPropagation();
          opts.onDelete?.(entry);
        },
      });
      del.textContent = '\u00d7';
      row.appendChild(del);
    }

    container.appendChild(row);
  }

  return container;
}

export function formatWhen(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 'unknown date';
  const diff = Date.now() - then;
  const mins = Math.round(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(then).toLocaleDateString();
}

export function refreshInto(container: HTMLElement, next: HTMLElement): void {
  clear(container);
  container.appendChild(next);
}