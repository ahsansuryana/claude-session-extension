import { call } from '../bridge/port';
import { ClaudeApiClient } from '../core/api';
import { buildBundle, summarize } from '../core/bundle';
import { storageGet, storageSet } from '../core/storage';
import {
  STORAGE_KEYS,
  type AccountCache,
  type SessionBundle,
  type SessionSource,
} from '../types/session';
import type { ClaudeConversation } from '../types/claude';
import { bundleFilename, downloadJson } from './download';

/**
 * One click, one download.
 *
 * No dialog, no preview, no vault, no settings round-trip. The only work worth
 * paying for is reading the conversation.
 */

export interface ExportResult {
  filename: string;
  summary: string;
  bundle: SessionBundle;
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

function isAccountCache(value: unknown): value is AccountCache {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as AccountCache).org === 'string' &&
    (value as AccountCache).org !== ''
  );
}

/**
 * Resolve the active org, caching it per profile.
 *
 * `GET /api/bootstrap` is a large response and the account does not change, so
 * it is fetched at most once per browser profile rather than on every page
 * load. The whole record is cached, not just the uuid - the bundle's
 * provenance fields have to be filled in on later clicks when bootstrap is
 * skipped entirely.
 */
async function activeAccount(): Promise<AccountCache> {
  const cached = await storageGet(STORAGE_KEYS.account);
  const hit = cached[STORAGE_KEYS.account];
  if (isAccountCache(hit)) return hit;

  const account = await new ClaudeApiClient().resolveActiveOrg();
  if (!account.org) throw new ExportError('Could not determine which Claude account is signed in.');

  await storageSet({ [STORAGE_KEYS.account]: account }).catch(() => undefined);
  return account;
}

/** Read the current conversation and download it as a session bundle. */
export async function exportCurrentConversation(
  conversationUuid: string,
): Promise<ExportResult> {
  try {
    const account = await activeAccount();
    const conversation = await call<ClaudeConversation>('getConversation', {
      org: account.org,
      uuid: conversationUuid,
    });

    const source: SessionSource = {
      account_uuid: account.accountUuid || null,
      account_email: account.email || null,
      organization_uuid: account.org,
      organization_name: account.orgName || null,
      conversation_uuid: conversation.uuid,
      conversation_name: conversation.name ?? '',
      model: conversation.model ?? 'unknown',
      created_at: conversation.created_at ?? '',
      updated_at: conversation.updated_at ?? conversation.created_at ?? '',
      url: `https://claude.ai/chat/${conversation.uuid}`,
    };

    // The active branch, not array order - see tree.ts.
    const bundle = buildBundle({
      conversation,
      source,
      includeThinking: true,
      includeTools: true,
    });

    const filename = bundleFilename(bundle.session_name);
    downloadJson(filename, bundle);

    return { filename, summary: summarize(bundle), bundle };
  } catch (error) {
    throw new ExportError(describe(error));
  }
}