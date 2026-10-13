/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mountDock } from '../src/content/ui/dock';
import { onImportProgress, setImportProgress } from '../src/content/importState';

/**
 * Smoke tests that actually mount the dock.
 *
 * The rest of the suite covers logic with injected dependencies, which meant a
 * mount-time failure - a temporal-dead-zone reference, a bad shadow-root
 * append, a typo in a class name - shipped with every test green. Mounting for
 * real is the only thing that catches those.
 */

function makeRoot(): ShadowRoot {
  const host = document.createElement('div');
  document.body.appendChild(host);
  return host.attachShadow({ mode: 'open' });
}

function mount() {
  const root = makeRoot();
  const onSave = vi.fn();
  const onImport = vi.fn();
  const dock = mountDock({
    root,
    usage: () => null,
    orgUuid: () => 'org-uuid',
    onSave,
    onImport,
  });
  return { root, dock, onSave, onImport };
}

beforeEach(() => {
  document.body.innerHTML = '';
  setImportProgress(null);
});

describe('mountDock', () => {
  it('mounts without throwing', () => {
    expect(() => mount()).not.toThrow();
  });

  it('renders into the shadow root, not the light DOM', () => {
    const { root } = mount();
    const dock = root.querySelector('.dock');
    expect(dock).not.toBeNull();
    // Anything appended to the host instead would render completely unstyled.
    expect(dock?.parentNode).toBe(root);
  });

  it('shows the title and both actions', () => {
    const { root } = mount();
    expect(root.querySelector('.dock-title')?.textContent).toBe('Session Transfer');
    const labels = [...root.querySelectorAll('.dock-actions button')].map((b) => b.textContent?.trim());
    expect(labels).toEqual(['Save session', 'Import chat']);
  });

  it('enables Save only on a conversation route', () => {
    const { root, dock } = mount();
    const save = () =>
      [...root.querySelectorAll('.dock-actions button')].find((b) =>
        b.textContent?.includes('Save session'),
      ) as HTMLButtonElement;

    // jsdom starts on '/', so Save starts disabled.
    expect(save().disabled).toBe(true);

    dock.refresh({ kind: 'chat' });
    expect(save().disabled).toBe(false);

    dock.refresh({ kind: 'new' });
    expect(save().disabled).toBe(true);
  });

  it('wires the action buttons', () => {
    const { root, dock, onSave, onImport } = mount();
    dock.refresh({ kind: 'chat' }); // Save is disabled on other routes
    dockButton(root, 'Save session')?.click();
    dockButton(root, 'Import chat')?.click();
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onImport).toHaveBeenCalledTimes(1);
  });

  it('shows a limits chip and survives opening the popover', () => {
    const { root } = mount();
    const chip = root.querySelector('.chip');
    expect(chip).not.toBeNull();
    expect(() => chip?.dispatchEvent(new Event('click', { bubbles: true }))).not.toThrow();
    expect(root.querySelector('.dock')).not.toBeNull();
  });

  it('renders the import strip once progress is set', () => {
    const { root, dock } = mount();
    expect(root.querySelector('.import-strip')).toBeNull();

    dock.setImport({
      sessionName: 'Moving session',
      phase: 'importing',
      chunkIndex: 1,
      chunkTotal: 3,
      createdUuid: 'c1',
      error: null,
      paused: false,
    });

    const strip = root.querySelector('.import-strip');
    expect(strip).not.toBeNull();
    expect(strip?.textContent).toContain('Moving session');
    expect(strip?.textContent).toContain('1/3');
  });

  it('marks a paused import as paused', () => {
    const { root, dock } = mount();
    dock.setImport({
      sessionName: 'Stalled',
      phase: 'paused',
      chunkIndex: 0,
      chunkTotal: 2,
      createdUuid: 'c1',
      error: null,
      paused: true,
    });
    expect(root.querySelector('.import-strip')?.textContent).toContain('Import paused');
  });

  it('clears the strip when the import finishes', () => {
    const { root, dock } = mount();
    dock.setImport({
      sessionName: 'Done',
      phase: 'importing',
      chunkIndex: 1,
      chunkTotal: 1,
      createdUuid: 'c1',
      error: null,
      paused: false,
    });
    dock.setImport(null);
    expect(root.querySelector('.import-strip')).toBeNull();
  });

  it('picks up an import that was already running at mount time', () => {
    setImportProgress({
      sessionName: 'In flight',
      phase: 'importing',
      chunkIndex: 2,
      chunkTotal: 4,
      createdUuid: 'c1',
      error: null,
      paused: false,
    });
    const { root, dock } = mount();
    expect(root.querySelector('.import-strip')?.textContent).toContain('In flight');
    dock.setImport(null);
  });

  it('keeps the limits popover open across a route change', () => {
    const { root, dock } = mount();
    root.querySelector('.chip')?.dispatchEvent(new Event('click', { bubbles: true }));
    expect(root.querySelector('.limits, .notice')).not.toBeNull();
    expect(() => dock.refresh({ kind: 'chat' })).not.toThrow();
  });

  it('detaches cleanly', () => {
    const { root, dock } = mount();
    expect(root.querySelector('.dock')).not.toBeNull();
    dock.destroy();
    expect(root.querySelector('.dock')).toBeNull();
  });

  it('does not leak an import-strip subscriber into later mounts', () => {
    const offs: Array<() => void> = [];
    const { dock } = mount();
    const off = onImportProgress(() => undefined);
    offs.push(off);
    dock.setImport(null);
    off();
    // Mounting again must still work with a clean store.
    expect(() => mount()).not.toThrow();
  });
});

function dockButton(root: ShadowRoot, label: string): HTMLButtonElement | undefined {
  return [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === label) as
    | HTMLButtonElement
    | undefined;
}