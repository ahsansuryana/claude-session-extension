/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mountFab, type FabState } from '../src/content/ui/fab';
import { STYLES } from '../src/content/ui/styles';
import { parseRoute } from '../src/content/router';

/**
 * Smoke tests that mount the button for real.
 *
 * Logic elsewhere is tested through injected dependencies, which means a
 * mount-time fault ships with every other test green. Mounting is the only
 * thing that catches those.
 */

function mount() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });
  const fab = mountFab({ root });
  return { host, root, fab };
}

const button = (root: ShadowRoot): HTMLButtonElement =>
  root.querySelector('.fab') as HTMLButtonElement;

beforeEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
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
    const wrapper = cssRule('.fab-wrap {', STYLES);
    expect(wrapper).toContain('position: fixed');
    expect(wrapper).toContain('right: 14px');
    expect(wrapper).toContain('bottom: 14px');
  });

  it('dims itself until hovered so it stays unobtrusive', () => {
    expect(cssRule('.fab {', STYLES)).toContain('opacity: .55');
  });

  it('never lets the host intercept page clicks', () => {
    // `all: initial` resets pointer-events to auto; the stylesheet has to put
    // it back to none, or a zero-size host still swallows clicks.
    expect(cssRule(':host {', STYLES)).toContain('pointer-events: none');
    expect(cssRule('.fab {', STYLES)).toContain('pointer-events: auto');
  });

  it('renders real SVG outlines, not black blobs', () => {
    const { root } = mount();
    const shapes = [...root.querySelectorAll('.fab-glyph path, .fab-glyph polyline, .fab-glyph circle')];
    expect(shapes.length).toBeGreaterThan(0);
    for (const shape of shapes) {
      // createElement('svg') defaults to fill:black.
      expect(shape.getAttribute('fill')).toBe('none');
      expect(shape.getAttribute('stroke')).toBe('currentColor');
    }
  });

  it('starts idle and disabled until a conversation is detected', () => {
    const { root, fab } = mount();
    expect(root.querySelector('.fab-wrap')?.getAttribute('data-state')).toBe('idle');
    expect(button(root).disabled).toBe(true);

    fab.setEnabled(true);
    expect(button(root).disabled).toBe(false);
  });

  it('explains why it is disabled off a conversation', () => {
    const { root, fab } = mount();
    fab.setEnabled(false);
    expect(button(root).title).toBe('Open a conversation first');
    expect(root.querySelector('.fab-tip')?.textContent).toBe('Open a conversation first');
  });

  it('detaches cleanly', () => {
    const { root, fab } = mount();
    expect(root.querySelector('.fab')).not.toBeNull();
    fab.destroy();
    expect(root.querySelector('.fab')).toBeNull();
  });
});

describe('state machine', () => {
  it('swaps the glyph per state', () => {
    const { root, fab } = mount();
    const seen: Record<FabState, string> = {
      idle: 'path',
      busy: 'circle',
      done: 'polyline',
      error: 'circle',
    };
    for (const state of ['busy', 'done', 'error', 'idle'] as FabState[]) {
      fab.setState(state);
      expect(root.querySelector(`.fab-glyph ${seen[state]}`), state).not.toBeNull();
      expect(root.querySelector('.fab-wrap')?.getAttribute('data-state')).toBe(state);
    }
  });

  it('spins while busy and blocks further clicks', () => {
    const { root, fab } = mount();
    fab.setEnabled(true);
    fab.setState('busy');
    const b = button(root);
    expect(b.disabled).toBe(true);
    expect(b.classList.contains('is-busy')).toBe(true);
    expect(b.getAttribute('aria-busy')).toBe('true');
    expect(root.querySelector('.spin')).not.toBeNull();
  });

  it('settles back to idle after done or error', async () => {
    vi.useFakeTimers();
    try {
      const { root, fab } = mount();
      fab.setState('done');
      expect(root.querySelector('.fab-wrap')?.getAttribute('data-state')).toBe('done');
      await vi.advanceTimersByTimeAsync(1600);
      expect(root.querySelector('.fab-wrap')?.getAttribute('data-state')).toBe('idle');
    } finally {
      vi.useRealTimers();
    }
  });

  it('offers a retry after a failure', () => {
    const { root, fab } = mount();
    fab.setState('error');
    expect(button(root).title).toContain('retry');
  });
});

describe('route wiring', () => {
  it('enables only on a conversation route', () => {
    const chat = parseRoute('/chat/471bbd5c-3d8e-4fd5-a1f7-c36344b5fd41');
    expect(chat.kind).toBe('chat');
    expect(parseRoute('/new').kind).toBe('new');
  });
});

/** Body of the first CSS rule whose selector list starts with `open`. */
function cssRule(open: string, css: string): string {
  const start = css.indexOf(open);
  expect(start, `no rule starting with ${open}`).toBeGreaterThan(-1);
  return css.slice(start, css.indexOf('}', start));
}