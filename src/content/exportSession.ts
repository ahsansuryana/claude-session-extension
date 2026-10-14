import { call } from '../bridge/port';
import { ClaudeApiClient } from '../core/api';
import { markdownFilename, toMarkdown } from '../core/markdown';
import { leafPath } from '../core/tree';
import { storageGet, storageSet } from '../core/storage';
import { downloadText } from './download';
import type { ClaudeConversation } from '../types/claude';

/**
 * One click, one download.
 *
 * No dialog, no preview, no vault, no settings round-trip. The only work worth
 * paying for is reading the conversation.
 */

const ORG_CACHE_KEY = 'sext.org.uuid';

export interface ExportResult {
  filename: string;
  turns: number;
  chars: number;
}

export class ExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportError';
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null) {
    const e = error as { message?: unknown };
    if (typeof e.message === 'string') return e.message;
  }
  return String(error);
}

/**
 * Resolve the active org, cached per browser profile.
 *
 * `GET /api/bootstrap` is a large response and the org does not change, so it
 * is fetched at most once per profile rather than on every page load.
 */
async function activeOrg(): Promise<string> {
  const cached = await storageGet(ORG_CACHE_KEY);
  const uuid = cached[ORG_CACHE_KEY];
  if (typeof uuid === 'string' && uuid) return uuid;

  const org = await new ClaudeApiClient().resolveActiveOrg();
  if (!org?.org) throw new ExportError('Could not determine which Claude account is signed in.');
  await storageSet({ [ORG_CACHE_KEY]: org.org }).catch(() => undefined);
  return org.org;
}

/**
 * Read the current conversation and download it as Markdown, named after the
 * conversation itself.
 */
export async function exportCurrentConversation(
  conversationUuid: string,
): Promise<ExportResult> {
  try {
    const org = await activeOrg();
    const conversation = await call<ClaudeConversation>('getConversation', {
      org,
      uuid: conversationUuid,
    });

    // The active branch, not array order - see tree.ts.
    const path = leafPath(conversation);
    const markdown = toMarkdown(conversation, path);
    const filename = markdownFilename(conversation.name);

    downloadText(filename, markdown);
    return { filename, turns: path.length, chars: markdown.length };
  } catch (error) {
    throw new ExportError(describe(error));
  }
}