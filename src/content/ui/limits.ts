import type { ClaudeUsage } from '../../types/claude';
import { clear, h } from './dom';

/**
 * Usage-limit normalisation and rendering.
 *
 * claude.ai reports ~20 experimental usage buckets, almost all null on any
 * given organization, plus a generic `limits[]`. Everything here collapses
 * that into a few display rows - and, critically, reports `unknown` rather
 * than 0% when the API returned nothing usable, so the UI never implies the
 * user has quota when we simply do not know.
 */

export interface LimitRow {
  label: string;
  percent: number;
  resetsInMs: number | null;
  status: string;
  /** True when this row came from claude.ai's localStorage cache, not the API. */
  cached?: boolean;
}

export interface LimitSummary {
  rows: LimitRow[];
  exceeded: boolean;
  approaching: boolean;
  unknown: boolean;
}

interface UsageBucket {
  resets_at?: number;
  utilization?: number;
  status?: string;
}

const WINDOWS: Array<{ key: keyof ClaudeUsage; label: string }> = [
  { key: 'five_hour', label: '5-hour session' },
  { key: 'seven_day', label: 'Weekly' },
  { key: 'seven_day_cowork', label: 'Cowork weekly' },
];

const EXTRA_LABEL = 'Additional limit';
const MS = { minute: 60_000, hour: 3_600_000 };

/**
 * Fallback source for usage.
 *
 * On page load claude.ai makes **no** usage API request at all - the sidebar
 * percentages are rendered from a localStorage cache keyed
 * `claudeai.<experiment>.<orgUuid>`, which is kept current by SSE frames on the
 * completion stream. `GET /usage` meanwhile returns `limits: []` on several
 * organizations.
 *
 * So when the API says nothing, read the same cache the sidebar uses. Rows
 * sourced this way are flagged `cached` so the UI can say the number may be
 * slightly behind.
 */
export interface CachedSessionLimit {
  utilization: number;
  resetsAtMs: number;
  atWall: boolean;
  observedAtMs: number;
}

export function readCachedSessionLimit(orgUuid: string): CachedSessionLimit | null {
  if (typeof localStorage === 'undefined' || !orgUuid) return null;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith('claudeai.') || !key.endsWith(orgUuid)) continue;
      const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? 'null');
      if (!parsed || typeof parsed !== 'object') continue;
      const v = parsed as { utilization?: unknown; resetsAt?: unknown; atWall?: unknown; observedAt?: unknown };
      if (typeof v.utilization !== 'number') continue;
      return {
        utilization: v.utilization,
        resetsAtMs: typeof v.resetsAt === 'number' ? v.resetsAt * 1000 : 0,
        atWall: v.atWall === true,
        observedAtMs: typeof v.observedAt === 'number' ? v.observedAt * 1000 : 0,
      };
    }
  } catch {
    /* malformed cache entry, or storage blocked */
  }
  return null;
}

function isBucket(value: unknown): value is UsageBucket {
  return typeof value === 'object' && value !== null && 'status' in value;
}

function toRow(
  label: string,
  bucket: UsageBucket,
  nowMs: number,
  cached?: boolean,
): LimitRow {
  const utilization = typeof bucket.utilization === 'number' ? bucket.utilization : 0;
  // resets_at is unix SECONDS, not milliseconds.
  const resetsAt = typeof bucket.resets_at === 'number' ? bucket.resets_at * 1000 : null;
  return {
    label,
    percent: Math.max(0, Math.min(100, utilization * 100)),
    resetsInMs: resetsAt !== null && resetsAt > nowMs ? resetsAt - nowMs : null,
    status: bucket.status ?? 'ok',
    ...(cached ? { cached } : {}),
  };
}

export function summariseUsage(
  usage: ClaudeUsage | null,
  nowMs: number,
  cached?: CachedSessionLimit | null,
): LimitSummary {
  if (!usage) {
    return cached
      ? summariseUsage({}, nowMs, cached)
      : { rows: [], exceeded: false, approaching: false, unknown: true };
  }

  const rows: LimitRow[] = [];
  for (const { key, label } of WINDOWS) {
    const bucket = usage[key];
    if (isBucket(bucket)) rows.push(toRow(label, bucket, nowMs));
  }
  for (const limit of usage.limits ?? []) {
    if (!isBucket(limit)) continue;
    if (rows.some((r) => r.label === EXTRA_LABEL)) break;
    rows.push(toRow(EXTRA_LABEL, limit, nowMs));
  }

  // API said nothing - fall back to the cache the sidebar itself renders from.
  if (rows.length === 0 && cached) {
    rows.push({
      label: '5-hour session',
      percent: Math.max(0, Math.min(100, cached.utilization * 100)),
      resetsInMs: cached.resetsAtMs > nowMs ? cached.resetsAtMs - nowMs : null,
      status: cached.atWall ? 'exceeded_limit' : 'ok',
      cached: true,
    });
  }

  if (rows.length === 0) return { rows, exceeded: false, approaching: false, unknown: true };

  return {
    rows,
    exceeded: rows.some((r) => r.status === 'exceeded_limit'),
    approaching: rows.some((r) => r.status === 'approaching_limit'),
    unknown: false,
  };
}

export function formatReset(resetsInMs: number | null): string {
  if (resetsInMs === null) return 'reset time unknown';
  if (resetsInMs <= 0) return 'resetting now';
  const hours = Math.floor(resetsInMs / MS.hour);
  const minutes = Math.floor((resetsInMs % MS.hour) / MS.minute);
  if (hours >= 24) return `resets in ${Math.floor(hours / 24)}d ${hours % 24}h`;
  if (hours > 0) return `resets in ${hours}h ${minutes}m`;
  return `resets in ${minutes}m`;
}

export function barClass(row: LimitRow): string {
  if (row.status === 'exceeded_limit' || row.percent >= 100) return 'bar-fill over';
  if (row.status === 'approaching_limit' || row.percent >= 80) return 'bar-fill warn';
  return 'bar-fill';
}

export function chipState(summary: LimitSummary): {
  kind: 'ok' | 'warn' | 'danger';
  text: string;
} {
  if (summary.unknown) return { kind: 'ok', text: 'Limits: n/a' };
  const worst = summary.rows.reduce((a, b) => (b.percent > a.percent ? b : a));
  if (summary.exceeded) return { kind: 'danger', text: `Limit reached · ${worst.label}` };
  const pct = `${Math.round(worst.percent)}%`;
  return { kind: worst.percent >= 80 || summary.approaching ? 'warn' : 'ok', text: `${worst.label} ${pct}` };
}

export function renderLimitRows(summary: LimitSummary): HTMLElement {
  const container = h('div', { class: 'limits' });
  for (const row of summary.rows) {
    container.appendChild(
      h(
        'div',
        { class: 'limit-row' },
        h(
          'div',
          { class: 'limit-head' },
          h('span', {}, row.label + (row.cached ? ' (cached)' : '')),
          h('span', { class: 'muted' }, `${Math.round(row.percent)}% · ${formatReset(row.resetsInMs)}`),
        ),
        h(
          'div',
          { class: 'bar' },
          h('div', {
            class: barClass(row),
            style: `width:${Math.max(2, Math.min(100, row.percent))}%`,
          }),
        ),
      ),
    );
  }
  return container;
}

export function renderLimitDetail(
  container: HTMLElement,
  summary: LimitSummary,
  opts: { onSaveAndMove: () => void },
): void {
  clear(container);

  if (summary.unknown) {
    container.appendChild(
      h(
        'div',
        { class: 'notice' },
        'This organization did not report usage limits. You can still save and import sessions here.',
      ),
    );
    return;
  }

  container.appendChild(renderLimitRows(summary));

  if (summary.rows.some((r) => r.cached)) {
    container.appendChild(
      h(
        'div',
        { class: 'muted small' },
        'Read from claude.ai local storage; the API reports no limits for this organization, so this may lag slightly.',
      ),
    );
  }

  if (summary.exceeded) {
    container.appendChild(
      h(
        'div',
        { class: 'notice notice-warn' },
        'This profile has hit a usage limit. Save the conversation here, then import it in a different browser profile.',
      ),
    );
    const button = h('button', { class: 'primary', type: 'button' }, 'Save session & move profile');
    button.addEventListener('click', () => opts.onSaveAndMove());
    container.appendChild(h('div', { class: 'dock-actions' }, button));
  }
}