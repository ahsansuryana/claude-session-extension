import type { ClaudeUsage } from '../types/claude';

export interface Badge {
  text: string;
  color: string;
}

/**
 * Toolbar badge state.
 *
 * Returns null when there is nothing meaningful to say. In particular, an org
 * that reports no limits must NOT show a "0%" badge - that reads as "you have
 * plenty of quota", which is an assumption we cannot make.
 */
export function computeBadge(usage: ClaudeUsage | null): Badge | null {
  if (!usage) return null;

  const limits: Array<{ status?: string; utilization?: number }> = [
    ...(usage.limits ?? []),
  ];
  for (const key of ['five_hour', 'seven_day', 'seven_day_cowork'] as const) {
    const bucket = usage[key];
    if (bucket && typeof bucket === 'object') limits.push(bucket);
  }

  if (limits.length === 0) return null;

  if (limits.some((l) => l.status === 'exceeded_limit')) {
    return { text: '!', color: '#b3261e' };
  }

  const peak = limits.reduce((max, l) => {
    const u = typeof l.utilization === 'number' ? l.utilization : 0;
    return u > max ? u : max;
  }, 0);

  // `utilization` is a 0..1 fraction.
  if (peak >= 0.8 || limits.some((l) => l.status === 'approaching_limit')) {
    return { text: `${Math.round(peak * 100)}%`, color: '#8a5a00' };
  }

  return { text: `${Math.round(peak * 100)}%`, color: '#1e6b3a' };
}