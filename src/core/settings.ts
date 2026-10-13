import { DEFAULT_MAX_PROMPT_CHARS } from './chunker';
import { storageGet, storageSet } from './storage';
import { STORAGE_KEYS } from '../types/session';

export interface Settings {
  /** Ceiling for a single `completion.prompt`. Each chunk costs one generation. */
  maxPromptChars: number;
  includeThinking: boolean;
  includeTools: boolean;
  /** Record dropped files as placeholders rather than silently omitting them. */
  includeFilePlaceholders: boolean;
  /** null = use the model recorded in the bundle. */
  defaultModel: string | null;
  autoDownloadOnSave: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  maxPromptChars: DEFAULT_MAX_PROMPT_CHARS,
  includeThinking: true,
  includeTools: true,
  includeFilePlaceholders: true,
  defaultModel: null,
  autoDownloadOnSave: true,
};


/** Unknown values on disk are dropped rather than trusted. */
function coerce(raw: unknown): Settings {
  const value = (raw ?? {}) as Partial<Settings>;
  const num = Number(value.maxPromptChars);
  return {
    maxPromptChars:
      Number.isFinite(num) && num > 0 ? Math.floor(num) : DEFAULT_SETTINGS.maxPromptChars,
    includeThinking: value.includeThinking ?? DEFAULT_SETTINGS.includeThinking,
    includeTools: value.includeTools ?? DEFAULT_SETTINGS.includeTools,
    includeFilePlaceholders:
      value.includeFilePlaceholders ?? DEFAULT_SETTINGS.includeFilePlaceholders,
    defaultModel: typeof value.defaultModel === 'string' ? value.defaultModel : null,
    autoDownloadOnSave: value.autoDownloadOnSave ?? DEFAULT_SETTINGS.autoDownloadOnSave,
  };
}

export async function getSettings(): Promise<Settings> {
  const raw = await storageGet(STORAGE_KEYS.settings);
  return coerce(raw[STORAGE_KEYS.settings]);
}

export async function patchSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await getSettings();
  const next = coerce({ ...current, ...patch });
  await storageSet({ [STORAGE_KEYS.settings]: next });
  return next;
}