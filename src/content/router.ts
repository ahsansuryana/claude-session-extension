/**
 * claude.ai is a SPA. There is no `popstate` when React Router pushes a new
 * view, and no event at all when it swaps history entries programmatically, so
 * navigation is detected by patching history and by watching the body.
 *
 * A debounce is essential: the app rewrites `document.body` constantly while a
 * response streams in, which would otherwise re-render the dock hundreds of
 * times per second.
 */

export type RouteKind = 'chat' | 'new' | 'other';

export interface Route {
  kind: RouteKind;
  conversationUuid: string | null;
}

const CHAT_RE = /^\/chat\/([0-9a-fA-F-]{36})\/?$/;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function parseRoute(pathname: string): Route {
  const chat = CHAT_RE.exec(pathname);
  if (chat) return { kind: 'chat', conversationUuid: chat[1] ?? null };
  if (pathname === '/new' || pathname === '/new/') {
    return { kind: 'new', conversationUuid: null };
  }
  return { kind: 'other', conversationUuid: null };
}

function sameRoute(a: Route, b: Route): boolean {
  return a.kind === b.kind && a.conversationUuid === b.conversationUuid;
}

export function onRouteChange(cb: (route: Route) => void, debounceMs = 150): () => void {
  let last = parseRoute(location.pathname);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const emit = (): void => {
    if (disposed) return;
    const next = parseRoute(location.pathname);
    if (sameRoute(next, last)) return;
    last = next;
    cb(next);
  };

  const schedule = (): void => {
    if (disposed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(emit, debounceMs);
  };

  // Patch history so pushState/replaceState are observed.
  const { pushState, replaceState } = history;
  history.pushState = function patchedPushState(...args) {
    const result = pushState.apply(this, args);
    schedule();
    return result;
  };
  history.replaceState = function patchedReplaceState(...args) {
    const result = replaceState.apply(this, args);
    schedule();
    return result;
  };

  window.addEventListener('popstate', schedule);

  const observer = new MutationObserver(schedule);
  const attach = (): void => {
    if (document.body) observer.observe(document.body, { childList: true, subtree: true });
  };
  attach();

  return () => {
    disposed = true;
    if (timer) clearTimeout(timer);
    observer.disconnect();
    window.removeEventListener('popstate', schedule);
    history.pushState = pushState;
    history.replaceState = replaceState;
  };
}

/** Current conversation uuid if the URL is a chat, else null. */
export function currentConversationUuid(): string | null {
  const route = parseRoute(location.pathname);
  return route.kind === 'chat' && UUID_RE.test(route.conversationUuid ?? '')
    ? route.conversationUuid
    : null;
}