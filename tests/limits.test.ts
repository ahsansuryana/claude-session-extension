import { describe, expect, it, vi } from 'vitest';
import { barClass, chipState, formatReset, readCachedSessionLimit, summariseUsage } from '../src/content/ui/limits';
import { computeBadge } from '../src/background/badge';
import type { ClaudeUsage } from '../src/types/claude';

const NOW = 1_700_000_000_000;
const TWO_HOURS_MS = 7_200_000;

function usage(over: Partial<ClaudeUsage> = {}): ClaudeUsage {
  return { ...over };
}

describe('summariseUsage', () => {
  it('reports unknown for a null payload', () => {
    expect(summariseUsage(null, NOW)).toMatchObject({ unknown: true, rows: [] });
  });

  it('reports unknown rather than 0% when the org returns no limits', () => {
    // The inspected org returns every bucket as null. Showing "0% used" here
    // would falsely imply plenty of quota.
    const s = summariseUsage(
      usage({ five_hour: null, seven_day: null, limits: [], member_dashboard_available: false }),
      NOW,
    );
    expect(s.unknown).toBe(true);
  });

  it('reads the named 5-hour and weekly windows', () => {
    const s = summariseUsage(
      usage({
        five_hour: { resets_at: NOW / 1000 + TWO_HOURS_MS / 1000, utilization: 0.42, status: 'ok' },
        seven_day: { resets_at: NOW / 1000, utilization: 0.9, status: 'approaching_limit' },
      }),
      NOW,
    );
    expect(s.unknown).toBe(false);
    expect(s.rows.map((r) => r.label)).toEqual(['5-hour session', 'Weekly']);
    expect(s.rows[0]?.percent).toBeCloseTo(42);
    expect(s.approaching).toBe(true);
    expect(s.exceeded).toBe(false);
  });

  it('flags an exceeded limit', () => {
    const s = summariseUsage(
      usage({ five_hour: { utilization: 1, status: 'exceeded_limit' } }),
      NOW,
    );
    expect(s.exceeded).toBe(true);
  });

  it('converts resets_at from seconds and drops stale windows', () => {
    const s = summariseUsage(
      usage({
        five_hour: { resets_at: NOW / 1000 + 3600, utilization: 0.1, status: 'ok' },
        seven_day: { resets_at: NOW / 1000 - 10, utilization: 0.1, status: 'ok' },
      }),
      NOW,
    );
    expect(s.rows[0]?.resetsInMs).toBeCloseTo(3_600_000, -3);
    expect(s.rows[1]?.resetsInMs).toBeNull();
  });

  it('includes extra entries from the generic limits array once', () => {
    const s = summariseUsage(
      usage({
        limits: [
          { utilization: 0.3, status: 'ok' },
          { utilization: 0.4, status: 'ok' },
        ],
      }),
      NOW,
    );
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0]?.label).toBe('Additional limit');
  });

  it('clamps a nonsensical utilization', () => {
    const s = summariseUsage(usage({ five_hour: { utilization: 5, status: 'ok' } }), NOW);
    expect(s.rows[0]?.percent).toBe(100);
  });

  it('defaults a missing utilization to 0', () => {
    const s = summariseUsage(usage({ five_hour: { status: 'ok' } }), NOW);
    expect(s.rows[0]?.percent).toBe(0);
  });

  it('skips malformed entries', () => {
    const s = summariseUsage(
      { limits: [null as never, 'nope' as never, { utilization: 0.2, status: 'ok' }] },
      NOW,
    );
    expect(s.rows).toHaveLength(1);
  });
});

describe('cached usage fallback', () => {
  const NOW = 1_700_000_000_000;

  function installStorage(entries: Record<string, string>): void {
    const map = new Map(Object.entries(entries));
    vi.stubGlobal('localStorage', {
      get length() {
        return map.size;
      },
      key: (i: number) => [...map.keys()][i] ?? null,
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
      clear: () => map.clear(),
    });
  }

  const ORG = '00000000-0000-4000-8000-000000000001';

  it('reads the cache key claude.ai uses for the sidebar meter', () => {
    installStorage({
      [`claudeai.ochre_heron_tide.${ORG}`]: JSON.stringify({
        resetsAt: NOW / 1000 + 3600,
        utilization: 0.42,
        atWall: false,
        observedAt: NOW / 1000,
      }),
    });
    expect(readCachedSessionLimit(ORG)).toMatchObject({ utilization: 0.42, atWall: false });
    vi.unstubAllGlobals();
  });

  it('falls back to the cache when the API reports no limits', () => {
    const cached = {
      utilization: 0.42,
      resetsAtMs: NOW + 3_600_000,
      atWall: false,
      observedAtMs: NOW,
    };
    const s = summariseUsage({ limits: [], five_hour: null }, NOW, cached);
    expect(s.unknown).toBe(false);
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0]).toMatchObject({ percent: 42, cached: true, status: 'ok' });
    expect(chipState(s).text).toContain('42%');
  });

  it('marks a cached row as at-wall when the cache says so', () => {
    const s = summariseUsage(null, NOW, {
      utilization: 1,
      resetsAtMs: NOW + 1000,
      atWall: true,
      observedAtMs: NOW,
    });
    expect(s.exceeded).toBe(true);
    expect(chipState(s).kind).toBe('danger');
  });

  it('prefers real API data over the cache', () => {
    const s = summariseUsage(
      { five_hour: { utilization: 0.9, status: 'approaching_limit' } },
      NOW,
      { utilization: 0.01, resetsAtMs: NOW, atWall: false, observedAtMs: NOW },
    );
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0]?.cached).toBeUndefined();
    expect(s.rows[0]?.percent).toBe(90);
  });

  it('returns null for a malformed cache entry', () => {
    installStorage({ [`claudeai.x.${ORG}`]: 'not json' });
    expect(readCachedSessionLimit(ORG)).toBeNull();
    installStorage({ [`claudeai.x.${ORG}`]: JSON.stringify({ noUtilization: true }) });
    expect(readCachedSessionLimit(ORG)).toBeNull();
    vi.unstubAllGlobals();
  });

  it('ignores cache keys belonging to another org', () => {
    installStorage({ 'claudeai.x.some-other-org': JSON.stringify({ utilization: 0.9 }) });
    expect(readCachedSessionLimit(ORG)).toBeNull();
    vi.unstubAllGlobals();
  });

  it('survives absent storage', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(readCachedSessionLimit(ORG)).toBeNull();
    vi.unstubAllGlobals();
  });
});

describe('formatReset', () => {
  it.each([
    [null, 'reset time unknown'],
    [0, 'resetting now'],
    [5 * 60_000, 'resets in 5m'],
    [90 * 60_000, 'resets in 1h 30m'],
    [50 * 3_600_000, 'resets in 2d 2h'],
  ])('formats %i ms as %s', (input, expected) => {
    expect(formatReset(input as number | null)).toBe(expected);
  });
});

describe('chipState / barClass', () => {
  it('shows n/a for unknown', () => {
    expect(chipState(summariseUsage(null, NOW))).toEqual({ kind: 'ok', text: 'Limits: n/a' });
  });

  it('shows a danger chip when a limit is reached', () => {
    const chip = chipState(summariseUsage(usage({ five_hour: { utilization: 1, status: 'exceeded_limit' } }), NOW));
    expect(chip.kind).toBe('danger');
    expect(chip.text).toContain('Limit reached');
  });

  it('switches to a warning chip at 80%', () => {
    expect(chipState(summariseUsage(usage({ five_hour: { utilization: 0.85, status: 'ok' } }), NOW)).kind).toBe(
      'warn',
    );
  });

  it('maps status to a bar colour', () => {
    expect(barClass({ label: 'x', percent: 10, resetsInMs: null, status: 'ok' })).toBe('bar-fill');
    expect(barClass({ label: 'x', percent: 85, resetsInMs: null, status: 'ok' })).toBe('bar-fill warn');
    expect(barClass({ label: 'x', percent: 20, resetsInMs: null, status: 'approaching_limit' })).toBe(
      'bar-fill warn',
    );
    expect(barClass({ label: 'x', percent: 100, resetsInMs: null, status: 'exceeded_limit' })).toBe(
      'bar-fill over',
    );
  });
});

describe('computeBadge', () => {
  it('returns null when usage is unknown', () => {
    expect(computeBadge(null)).toBeNull();
    expect(computeBadge({ limits: [], five_hour: null, seven_day: null })).toBeNull();
  });

  it('flags an exceeded limit loudly', () => {
    expect(computeBadge({ limits: [{ utilization: 1, status: 'exceeded_limit' }] })).toEqual({
      text: '!',
      color: '#b3261e',
    });
  });

  it('warns near the ceiling', () => {
    expect(computeBadge({ five_hour: { utilization: 0.9, status: 'ok' } })?.color).toBe('#8a5a00');
  });

  it('shows the peak utilization across windows', () => {
    expect(computeBadge({ five_hour: { utilization: 0.2, status: 'ok' }, seven_day: { utilization: 0.5, status: 'ok' } })).toEqual({
      text: '50%',
      color: '#1e6b3a',
    });
  });

  it('treats an approaching status as a warning even at low utilization', () => {
    expect(computeBadge({ limits: [{ utilization: 0.1, status: 'approaching_limit' }] })?.color).toBe(
      '#8a5a00',
    );
  });
});