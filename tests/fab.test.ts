/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mountFab } from '../src/content/ui/fab';
import { parseRoute } from '../src/content/router';
import { STYLES } from '../src/content/ui/styles';

/**
 * Smoke tests that actually mount the UI.
 *
 * Logic is tested through injected dependencies elsewhere, which means a
 * mount-time fault - a temporal-dead-zone reference, an append to the host
 * instead of the shadow root, a missing namespace on an SVG element - ships
 * with every other test green. Mounting for real is the only thing that
 * catches those.
 */

function mount() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });
  const onSave = vi.fn();
  const fab = mountFab({ root, onSave });
  return { host, root, fab, onSave };
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('mountFab', () => {
  it('mounts without throwing', () => {
    expect(() => mount()).not.toThrow();
  });

  it('renders into the shadow root, not the light DOM', () => {
    const { host, root } = mount();
    const wrap = root.querySelector('.fab-wrap');
    expect(root.querySelector('.fab')).not.toBeNull();
    // Appended to the host instead, it would render unstyled and full-size.
    expect(wrap?.parentNode).toBe(root);
    expect(host.children).toHaveLength(0);
  });

  it('stays small enough not to cover claude.ai UI', () => {
    // jsdom does not cascade shadow-root stylesheets through getComputedStyle,
    // so assert on the stylesheet itself - which is what the browser applies.
    const rule = cssRule('.fab {', STYLES);
    expect(rule).toContain('width: 34px');
    expect(rule).toContain('height: 34px');
    expect(rule).toContain('border-radius: 50%');
    // Positioned by the wrapper, which is what actually sits on screen.
    const wrapper = cssRule('.fab-wrap {', STYLES);
    expect(wrapper).toContain('position: fixed');
    expect(wrapper).toContain('right: 14px');
    expect(wrapper).toContain('bottom: 14px');
  });

  it('dims itself until hovered so it stays unobtrusive', () => {
    expect(cssRule('.fab {', STYLES)).toContain('opacity: .55');
    expect(cssRule('.fab:hover:not(:disabled)', STYLES)).toContain('opacity: 1');
  });

  it('never lets the host intercept page clicks', () => {
    // `all: initial` resets pointer-events to auto; the stylesheet has to put
    // it back to none, or a zero-size host still swallows clicks.
    expect(cssRule(':host {', STYLES)).toContain('pointer-events: none');
    expect(cssRule('.fab {', STYLES)).toContain('pointer-events: auto');
  });

  it('renders the icon as real SVG, not an unknown element', () => {
    const { root } = mount();
    const icon = root.querySelector('.fab svg');
    expect(icon).not.toBeNull();
    // createElement('svg') would produce HTMLUnknownElement with no namespace.
    expect(icon?.namespaceURI).toBe('http://www.w3.org/2000/svg');
    const shapes = [...(icon?.querySelectorAll('path, polyline') ?? [])];
    expect(shapes.length).toBeGreaterThan(0);
    // Un-stroked shapes render as solid black blobs instead of an outline.
    for (const shape of shapes) {
      expect(shape.getAttribute('fill')).toBe('none');
      expect(shape.getAttribute('stroke')).toBe('currentColor');
    }
  });

  it('carries an accessible label', () => {
    const { root } = mount();
    const button = root.querySelector('.fab');
    expect(button?.getAttribute('aria-label')).toBe('Save session');
    expect(root.querySelector('.fab-tip')?.textContent).toBe('Save session');
  });

  it('fires onSave when clicked', () => {
    const { root, onSave } = mount();
    (root.querySelector('.fab') as HTMLButtonElement).click();
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('is disabled off a conversation, and says why', () => {
    const { root, fab, onSave } = mount();
    fab.setEnabled(false);
    const button = root.querySelector('.fab') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe('Open a conversation first');
    expect(root.querySelector('.fab-wrap')?.classList.contains('is-disabled')).toBe(true);

    button.click();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('is enabled on a conversation', () => {
    const { root, fab } = mount();
    fab.setEnabled(true);
    const button = root.querySelector('.fab') as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(button.title).toBe('Save this conversation');
  });

  it('detaches cleanly', () => {
    const { root, fab } = mount();
    expect(root.querySelector('.fab')).not.toBeNull();
    fab.destroy();
    expect(root.querySelector('.fab')).toBeNull();
  });

  it('drives itself from the route', () => {
    expect(parseRoute('/chat/471bbd5c-3d8e-4fd5-a1f7-c36344b5fd41').kind).toBe('chat');
    expect(parseRoute('/new').kind).toBe('new');
  });
});
/** Body of the first CSS rule whose selector list starts with `open`. */
function cssRule(open: string, css: string): string {
  const start = css.indexOf(open);
  expect(start, `no rule starting with ${open}`).toBeGreaterThan(-1);
  return css.slice(start, css.indexOf('}', start));
}
