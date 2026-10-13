/** Tiny DOM helpers. All UI lives inside a shadow root, so nothing here needs
 * to escape claude.ai's global styles or Tailwind preflight. */

export type Child = Node | string | number | null | undefined | false;

type Attrs = Record<string, string | number | boolean | null | undefined | EventListener>;

/** Hyperscript. `on*` attributes become listeners; everything else is set. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (key === 'class') {
      el.className = String(value);
    } else if (key === 'text') {
      el.textContent = String(value);
    } else if (key === 'style' && typeof value === 'string') {
      el.setAttribute('style', value);
    } else {
      el.setAttribute(key, value === true ? '' : String(value));
    }
  }
  append(el, children);
  return el;
}

export function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(
      typeof child === 'string' || typeof child === 'number'
        ? document.createTextNode(String(child))
        : child,
    );
  }
}

export function clear(node: Node): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export interface ModalHandle {
  close(): void;
  root: HTMLDivElement;
}

/**
 * Containers for the extension UI.
 *
 * Everything MUST be appended to the shadow root, never to the host element.
 * The host has no light-DOM children, so anything appended to it renders
 * completely unstyled (the stylesheet lives inside the shadow root).
 */
export type UiRoot = ShadowRoot;

let openModal: ModalHandle | null = null;

/**
 * Open a modal over the extension's shadow root. Only one at a time; opening a
 * second closes the first. Traps Escape and restores focus on close.
 */
export function showModal(
  root: UiRoot,
  build: (api: { close: () => void }) => HTMLElement,
): ModalHandle {
  openModal?.close();

  const previouslyFocused = (root.ownerDocument ?? document).activeElement as HTMLElement | null;

  const overlay = h('div', {
    class: 'overlay',
    onclick: (event: Event) => {
      if (event.target === overlay) handle.close();
    },
  });

  const panel = h('div', {
    class: 'panel',
    role: 'dialog',
    'aria-modal': 'true',
  });

  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      handle.close();
    }
  };

  const handle: ModalHandle = {
    root: overlay,
    close(): void {
      if (!overlay.isConnected) return;
      overlay.removeEventListener('keydown', onKeydown, true);
      overlay.remove();
      if (openModal === handle) openModal = null;
      previouslyFocused?.focus?.();
    },
  };

  overlay.appendChild(panel);
  append(panel, [build({ close: () => handle.close() })]);
  overlay.addEventListener('keydown', onKeydown, true);
  root.appendChild(overlay);
  openModal = handle;

  // Focus the first sensible control so keyboard users land inside the dialog.
  const focusable = panel.querySelector<HTMLElement>(
    'input:not([type=hidden]), textarea, select, button',
  );
  focusable?.focus();
  if (focusable instanceof HTMLInputElement) focusable.select();

  return handle;
}

export function toast(root: UiRoot, message: string, kind: 'info' | 'error' = 'info'): void {
  const el = h('div', { class: `toast toast-${kind}`, role: 'status' }, message);
  root.appendChild(el);
  setTimeout(() => el.classList.add('toast-out'), 3200);
  setTimeout(() => el.remove(), 3800);
}

/** Escape user text before it goes anywhere near innerHTML. */
export function text(value: unknown): string {
  const div = document.createElement('div');
  div.textContent = value === null || value === undefined ? '' : String(value);
  return div.innerHTML;
}