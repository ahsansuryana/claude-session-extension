import { parseBundle, summarize } from '../core/bundle';
import { buildPromptChunks } from '../core/chunker';
import { getVaultBundle, listVault } from '../core/vault';
import type { SessionBundle, VaultEntryMeta } from '../types/session';
import { call } from '../bridge/port';
import { describe } from './saveDialog';
import { clearResume, readResumeToken, runImport, type ImportProgress } from './importRunner';
import { clear, h, showModal, toast } from './ui/dom';
import { renderVaultList } from './ui/vaultList';

export interface ImportDialogContext {
  root: ShadowRoot;
  onImported: (uuid: string) => void;
}

type Tab = 'file' | 'vault';

/** Models offered in the pre-flight picker. */
const MODEL_PRESETS = ['claude-sonnet-5-5', 'claude-opus-4-5', 'claude-haiku-4-5'];

export function openImportDialog(ctx: ImportDialogContext): void {
  let tab: Tab = 'file';
  let selected: SessionBundle | null = null;
  let sourceLabel = '';
  let chosenModel = '';
  let running = false;
  let selectedMetaId: string | null = null;

  showModal(ctx.root, ({ close }) => {
    const resumeSlot = h('div', {});
    const previewSlot = h('div', {});
    const paneSlot = h('div', {});
    const errorSlot = h('div', {});
    const footerSlot = h('div', {});
    const tabStrip = h('div', { class: 'tabs', role: 'tablist' });

    const modelSelect = h('select', { 'aria-label': 'Target model' }) as HTMLSelectElement;

    const pane = async (next: Tab): Promise<void> => {
      tab = next;
      for (const [key, btn] of Object.entries(tabButtons)) {
        btn.setAttribute('aria-selected', String(key === tab));
      }
      clear(paneSlot);
      if (tab === 'file') {
        paneSlot.appendChild(filePane());
      } else {
        const entries = await listVault();
        paneSlot.appendChild(
          renderVaultList(
            entries,
            selectedMetaId,
            {
              emptyMessage:
                'No sessions saved in this browser profile yet. Open a conversation and use "Save session", or import a .claude-session.json file.',
              onSelect: (meta) => void selectFromVault(meta),
              onDelete: (meta) => void deleteEntry(meta),
            },
          ),
        );
      }
    };

    function filePane(): HTMLElement {
      const input = h('input', {
        type: 'file',
        accept: '.json,.claude-session.json,application/json',
        'aria-label': 'Session file',
      }) as HTMLInputElement;

      input.addEventListener('change', () => {
        const file = input.files?.[0];
        if (!file) return;
        void (async () => {
          try {
            const text = await file.text();
            selected = parseBundle(text);
            sourceLabel = `${file.name} (${formatBytes(file.size)})`;
            chosenModel = selected.source.model;
            renderPreview();
          } catch (error) {
            selected = null;
            errorSlot.replaceChildren(
              h('div', { class: 'notice notice-error' }, describe(error)),
            );
            clear(previewSlot);
          }
        })();
      });

      return h(
        'div',
        { class: 'row' },
        h('span', { class: 'muted small' },
          'Pick a .claude-session.json file exported from another browser profile.'),
        input,
      );
    }

    async function selectFromVault(meta: VaultEntryMeta): Promise<void> {
      selectedMetaId = meta.bundle_id;
      errorSlot.replaceChildren();
      try {
        selected = await getVaultBundle(meta.bundle_id);
        sourceLabel = `this profile · saved ${meta.saved_at.slice(0, 16).replace('T', ' ')}`;
        chosenModel = selected.source.model;
        renderPreview();
        // Repaint the list so the pressed state moves.
        await pane('vault');
      } catch (error) {
        errorSlot.replaceChildren(
          h('div', { class: 'notice notice-error' }, `Could not read that session: ${describe(error)}`),
        );
      }
    }

    async function deleteEntry(meta: VaultEntryMeta): Promise<void> {
      const { deleteVaultBundle } = await import('../core/vault');
      await deleteVaultBundle(meta.bundle_id);
      if (selectedMetaId === meta.bundle_id) {
        selectedMetaId = null;
        selected = null;
        clear(previewSlot);
      }
      await pane(tab);
    }

    function renderPreview(): void {
      clear(previewSlot);
      if (!selected) return;

      const chunks = buildPromptChunks(selected).length;
      previewSlot.replaceChildren(
        h(
          'div',
          { class: 'stats' },
          statCard('Name', selected.session_name),
          statCard('Turns', String(selected.stats.message_count)),
          statCard('Blocks', String(selected.stats.content_blocks)),
          statCard('Requests', String(chunks)),
        ),
        h(
          'p',
          { class: 'muted small' },
          `${summarize(selected)} · from ${sourceLabel}`,
        ),
        h(
          'p',
          { class: 'muted small' },
          `Importing sends the transcript to this profile as ${chunks === 1 ? 'one prompt' : `${chunks} prompts`}, ` +
            `which costs ${chunks} assistant ${chunks === 1 ? 'reply' : 'replies'} of this profile's quota.`,
        ),
      );

      modelSelect.replaceChildren(
        ...modelOptions(selected, chosenModel),
      );
      renderFooter();
    }

    function modelOptions(bundle: SessionBundle, chosen: string): HTMLElement[] {
      const values = [...new Set([chosen, bundle.source.model, ...MODEL_PRESETS].filter(Boolean))];
      return values.map(
        (m) => h('option', { value: m, selected: m === chosen }, m),
      );
    }

    function renderFooter(): void {
      clear(footerSlot);
      footerSlot.replaceChildren(
        h('div', { class: 'row' },
          h('span', { class: 'muted small' }, 'Target model'),
          modelSelect,
        ),
        h(
          'div',
          { class: 'actions' },
          h('span', { class: 'grow' }),
          h('button', { type: 'button', onclick: () => close() }, 'Cancel'),
          startButton(),
        ),
      );
    }

    function startButton(): HTMLElement {
      const btn = h('button', { class: 'primary', type: 'button' }, 'Import') as HTMLButtonElement;
      btn.disabled = !selected || running;
      btn.addEventListener('click', () => void start());
      return btn;
    }

    async function start(): Promise<void> {
      if (!selected || running) return;
      running = true;
      errorSlot.replaceChildren();

      const progressBar = h('div', { class: 'progress' });
      const progressFill = h('div', { class: 'progress-fill', style: 'width:0%' });
      progressBar.appendChild(progressFill);
      const progressLabel = h('p', { class: 'muted small' }, 'Preparing…');
      const progressSlot = h('div', {}, progressBar, progressLabel);
      previewSlot.appendChild(progressSlot);

      const onProgress = (p: ImportProgress): void => {
        const pct =
          p.chunkTotal > 0
            ? Math.round(((p.chunkIndex + (p.phase === 'done' ? 0 : 0)) / p.chunkTotal) * 100)
            : 0;
        progressFill.style.width = `${Math.min(100, pct)}%`;
        progressLabel.textContent = progressText(p);
      };

      try {
        const result = await runImport(selected, { model: modelSelect.value || null, onProgress });
        close();
        toast(ctx.root, `Imported "${selected.session_name}"`);
        ctx.onImported(result.createdUuid);
      } catch (error) {
        running = false;
        const message = describe(error);
        errorSlot.replaceChildren(
          h(
            'div',
            { class: `notice ${isLimit(message) ? 'notice-warn' : 'notice-error'}` },
            message,
          ),
        );
        renderFooter();
      }
    }

    const tabButtons: Record<Tab, HTMLButtonElement> = {
      file: h('button', { class: 'tab', role: 'tab', type: 'button' }, 'From file') as HTMLButtonElement,
      vault: h('button', { class: 'tab', role: 'tab', type: 'button' }, 'From this profile') as HTMLButtonElement,
    };
    tabStrip.appendChild(tabButtons.file);
    tabStrip.appendChild(tabButtons.vault);
    tabButtons.file.addEventListener('click', () => void pane('file'));
    tabButtons.vault.addEventListener('click', () => void pane('vault'));

    // Offer a resume if a previous import was interrupted by a quota wall.
    void (async () => {
      const token = await readResumeToken();
      if (!token) return;
      const banner = h(
        'div',
        { class: 'notice notice-warn' },
        h(
          'div',
          {},
          `An import of "${token.session_name}" stopped at part ${token.next_chunk} of ${token.chunk_total} because this profile hit its limit.`,
        ),
        h(
          'div',
          { class: 'actions', style: 'margin-top:8px' },
          h(
            'button',
            {
              type: 'button',
              onclick: () => {
                void openResume(ctx, token.bundle_id, () => close());
              },
            },
            'Resume that import',
          ),
          h(
            'button',
            {
              class: 'ghost danger',
              type: 'button',
              onclick: (e: Event) => {
                // Capture the node synchronously: `currentTarget` is nulled once
                // the listener returns, so it cannot be read after the await.
                const banner = (e.currentTarget as HTMLElement | null)?.closest('.notice') ?? null;
                void (async () => {
                  await clearResume();
                  banner?.remove();
                })().catch((error: unknown) => {
                  banner?.remove();
                  void describe(error);
                });
              },
            },
            'Discard',
          ),
        ),
      );
      resumeSlot.replaceChildren(banner);
    })();

    void pane('file');

    return h(
      'div',
      {},
      h('h2', {}, 'Import a session'),
      h(
        'p',
        { class: 'muted small' },
        'A session is moved as its transcript. This profile receives a new conversation that ' +
          'continues from the end of the original thread.',
      ),
      resumeSlot,
      tabStrip,
      paneSlot,
      previewSlot,
      errorSlot,
      footerSlot,
    );
  });
}

async function openResume(
  ctx: ImportDialogContext,
  bundleId: string,
  onClose: () => void,
): Promise<void> {
  const token = await readResumeToken();
  if (!token) {
    onClose();
    return;
  }

  const entries = await listVault();
  // Look up by the token's own id only. Falling back to "the first saved
  // session" would resume the wrong transcript.
  const meta = entries.find((e) => e.bundle_id === bundleId);
  if (!meta) {
    toast(
      ctx.root,
      'That import can no longer be resumed - its saved session is missing. Import the file again.',
      'error',
    );
    await clearResume();
    onClose();
    return;
  }

  let bundle: SessionBundle;
  try {
    bundle = await getVaultBundle(meta.bundle_id);
  } catch (error) {
    toast(ctx.root, `Could not read that session: ${describe(error)}`, 'error');
    await clearResume();
    onClose();
    return;
  }

  const { resumeImport } = await import('./importRunner');
  try {
    const result = await resumeImport(bundle);
    if (result) {
      onClose();
      toast(ctx.root, `Resumed import of "${bundle.session_name}"`);
      ctx.onImported(result.createdUuid);
    }
  } catch (error) {
    toast(ctx.root, `Resume failed: ${describe(error)}`, 'error');
  }
}

function progressText(p: ImportProgress): string {
  switch (p.phase) {
    case 'validating':
      return 'Validating the session file…';
    case 'creating':
      return 'Creating the new conversation…';
    case 'importing':
      return `Importing part ${p.chunkIndex + 1} of ${p.chunkTotal}…`;
    case 'paused':
      return `Paused at part ${p.chunkIndex} of ${p.chunkTotal} — this profile is out of quota.`;
    case 'done':
      return `Done — ${p.chunkTotal} part(s) imported.`;
    case 'failed':
      return `Failed: ${p.error ?? 'unknown error'}`;
    default:
      return '';
  }
}

function isLimit(message: string): boolean {
  return /usage limit|limit/i.test(message);
}

function statCard(k: string, v: string): HTMLElement {
  return h('div', { class: 'stat' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v));
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Resolve the active org for the pre-flight copy. Used by the dock CTA. */
export async function activeOrgLabel(): Promise<string> {
  const org = await call<{ email: string; orgName: string }>('resolveActiveOrg', {});
  return `${org.email || 'unknown account'}${org.orgName ? ` (${org.orgName})` : ''}`;
}