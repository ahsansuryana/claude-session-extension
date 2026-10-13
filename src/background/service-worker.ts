import { computeBadge } from './badge';
import { STORAGE_KEYS } from '../types/session';
import type { ClaudeUsage } from '../types/claude';

/**
 * Background service worker.
 *
 * Deliberately minimal: the content script already has the usage data, so the
 * worker's only job is to mirror it onto the toolbar icon so the user can see a
 * profile is out of quota without opening the tab.
 *
 * Nothing here may throw. A rejected promise in a service worker surfaces as an
 * uncaught error on every wake, so every API touch is guarded.
 */

const ALARM = 'sext:limits-poll';

interface LimitsSnapshot {
  usage: ClaudeUsage | null;
  at: number;
  org: string;
}

/**
 * `chrome.action` is undefined unless the manifest declares an `action`. Guard
 * rather than assume, so a manifest change degrades the badge instead of
 * breaking the worker.
 */
function action(): typeof chrome.action | undefined {
  return chrome.action ?? undefined;
}

async function setBadge(text: string, color?: string): Promise<void> {
  const api = action();
  if (!api) return;
  try {
    await api.setBadgeText({ text });
    if (color) await api.setBadgeBackgroundColor({ color });
  } catch {
    /* the extension may be reloading, or the action may not be ready yet */
  }
}

async function paintBadge(): Promise<void> {
  try {
    const raw = (await chrome.storage.local.get(STORAGE_KEYS.limitsSnapshot)) as Record<
      string,
      unknown
    >;
    const snapshot = raw[STORAGE_KEYS.limitsSnapshot] as LimitsSnapshot | undefined;
    const badge = computeBadge(snapshot?.usage ?? null);
    await setBadge(badge?.text ?? '', badge?.color);
  } catch {
    /* storage unavailable; leave the badge as-is */
  }
}

function registerAlarm(): void {
  try {
    chrome.alarms.create(ALARM, { periodInMinutes: 15 });
  } catch {
    /* alarms unavailable */
  }
}

chrome.runtime.onInstalled.addListener(registerAlarm);
chrome.runtime.onStartup.addListener(registerAlarm);

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) void paintBadge();
});

chrome.runtime.onMessage.addListener((message: unknown) => {
  if (
    typeof message === 'object' &&
    message !== null &&
    (message as { type?: unknown }).type === 'sext:resume-pending'
  ) {
    void setBadge('↻', '#8a5a00');
    return;
  }
  void paintBadge();
});

void paintBadge();