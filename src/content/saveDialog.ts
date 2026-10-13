import { call } from '../bridge/port';
import { buildBundle, makeVaultMeta } from '../core/bundle';
import { getSettings, patchSettings } from '../core/settings';
import { putVaultBundle } from '../core/vault';
import { renderPrompt } from '../core/transcript';
import type { ClaudeConversation } from '../types/claude';
import type { SessionBundle, SessionSource } from '../types/session';
import { bundleFilename, downloadJson } from './download';
import { h, showModal, toast } from './ui/dom';
import { formatWhen } from './ui/vaultList';

export interface SaveDialogContext {
  /** Shadow root to render the dialog into. */
  root: ShadowRoot;
  /** Resolved live so the dialog never acts on a stale route. */
  conversationUuid: () => string | null;
  onDone?: (bundle: SessionBundle, savedPath: string) => void;
}

/**
 * "Save session" dialog.
 *
 * The name defaults to the current conversation's title and is pre-selected so
 * typing replaces it. Captured block types follow settings and are previewed as
 * live counts before anything is written to disk.
 */
export async function openSaveDialog(ctx: SaveDialogContext): Promise<void> {
  const conversationUuid = ctx.conversationUuid();
  if (!conversationUuid) {
    toast(ctx.root, 'Open a conversation before saving.', 'error');
    return;
  }

  const settings = await getSettings();
  let org: { org: string; orgName: string; accountUuid: string; email: string };
  let conversation: ClaudeConversation;
  try {
    org = await call('resolveActiveOrg', {});
    conversation = await call('getConversation', { org: org.org, uuid: conversationUuid });
  } catch (error) {
    toast(ctx.root, `Could not read this conversation: ${describe(error)}`, 'error');
    return;
  }

  const source: SessionSource = {
    account_uuid: org.accountUuid || null,
    account_email: org.email || null,
    organization_uuid: org.org,
    organization_name: org.orgName || null,
    conversation_uuid: conversation.uuid,
    conversation_name: conversation.name ?? '',
    model: conversation.model ?? '',
    created_at: conversation.created_at ?? '',
    updated_at: conversation.updated_at ?? '',
    url: `${location.origin}/chat/${conversation.uuid}`,
  };

  let includeThinking = settings.includeThinking;
  let includeTools = settings.includeTools;
  let includeFiles = settings.includeFilePlaceholders;

  showModal(ctx.root, ({ close }) => {
    const nameInput = h('input', {
      type: 'text',
      value: conversation.name ?? '',
      placeholder: 'Session name',
      'aria-label': 'Session name',
    }) as HTMLInputElement;

    const statsSlot = h('div', { class: 'stats' });
    const errorSlot = h('div', {});
    const saveBtn = h('button', { class: 'primary', type: 'button' }, 'Save session') as HTMLButtonElement;

    const currentBundle = (): SessionBundle =>
      buildBundle({
        conversation,
        source,
        sessionName: nameInput.value,
        includeThinking,
        includeTools,
        includeFilePlaceholders: includeFiles,
      });

    const rebuildPreview = (): void => {
      try {
        const b = currentBundle();
        const promptChars = renderPrompt(b).length;
        statsSlot.replaceChildren(
          stat('Turns', String(b.stats.message_count)),
          stat('Blocks', String(b.stats.content_blocks)),
          stat('Prompt size', `${Math.round(promptChars / 1000)}k chars`),
          stat('Other branches', String(b.stats.branch_count)),
          ...(b.stats.omitted_files ? [stat('Files omitted', String(b.stats.omitted_files))] : []),
        );
      } catch (error) {
        statsSlot.replaceChildren(
          h('div', { class: 'notice notice-error' }, describe(error)),
        );
      }
    };

    const toggle = (
      label: string,
      checked: boolean,
      onChange: (next: boolean) => void,
    ): HTMLElement => {
      const input = h('input', { type: 'checkbox', checked }) as HTMLInputElement;
      input.addEventListener('change', () => onChange(input.checked));
      return h('label', { class: 'checkbox' }, input, label);
    };

    saveBtn.addEventListener('click', () => {
      saveBtn.disabled = true;
      errorSlot.replaceChildren();
      void (async () => {
        try {
          const bundle = currentBundle();
          const nowIso = new Date().toISOString();
          const bundleId = crypto.randomUUID();

          await putVaultBundle(
            bundle,
            makeVaultMeta(bundle, bundleId, 'saved', nowIso, conversation.uuid),
          );

          let savedPath = 'saved in this profile';
          if (settings.autoDownloadOnSave) {
            const filename = bundleFilename(bundle.session_name);
            downloadJson(filename, bundle);
            savedPath = `saved + downloaded ${filename}`;
          }

          await patchSettings({
            includeThinking,
            includeTools,
            includeFilePlaceholders: includeFiles,
          });

          close();
          toast(ctx.root, `"${bundle.session_name}" ${savedPath}`);
          ctx.onDone?.(bundle, savedPath);
        } catch (error) {
          errorSlot.replaceChildren(
            h('div', { class: 'notice notice-error' }, `Save failed: ${describe(error)}`),
          );
          saveBtn.disabled = false;
        }
      })();
    });

    rebuildPreview();
    nameInput.addEventListener('input', rebuildPreview);

    return h(
      'div',
      {},
      h('h2', {}, 'Save this session'),
      h(
        'p',
        { class: 'muted small' },
        'Captures the branch you are on, including thinking and tool calls. ' +
          'File contents cannot be moved between accounts, so they are recorded as placeholders.',
      ),
      h('div', { class: 'row' }, h('span', { class: 'muted small' }, 'Name'), nameInput),
      statsSlot,
      h(
        'div',
        { class: 'row' },
        toggle('Include thinking', includeThinking, (v) => {
          includeThinking = v;
          rebuildPreview();
        }),
        toggle('Include tool calls', includeTools, (v) => {
          includeTools = v;
          rebuildPreview();
        }),
        toggle('Record file placeholders', includeFiles, (v) => {
          includeFiles = v;
          rebuildPreview();
        }),
      ),
      h(
        'p',
        { class: 'muted small' },
        `From ${org.email || 'unknown account'}${conversation.created_at ? ` · started ${formatWhen(conversation.created_at)}` : ''}`,
      ),
      errorSlot,
      h(
        'div',
        { class: 'actions' },
        h('span', { class: 'grow' }),
        h('button', { type: 'button', onclick: () => close() }, 'Cancel'),
        saveBtn,
      ),
    );
  });
}

function stat(k: string, v: string): HTMLElement {
  return h(
    'div',
    { class: 'stat' },
    h('div', { class: 'k' }, k),
    h('div', { class: 'v' }, v),
  );
}

/** Normalise anything thrown across the bridge into a readable string. */
export function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null) {
    const e = error as { message?: unknown; code?: unknown };
    if (typeof e.message === 'string') return e.message;
  }
  return String(error);
}