import type { App } from 'obsidian';
import { Notice, setIcon } from 'obsidian';

import type { PaperCacheStatus, PaperLibraryEntry } from '../../core/library/PaperLibrary';
import { t } from '../../i18n/i18n';

export interface PaperCacheSettingsHost {
  listPapers(): Promise<readonly PaperLibraryEntry[]>;
  rebuildPaperCache(sourcePath: string): Promise<void>;
}

function statusLabel(status: PaperCacheStatus): string {
  const keys: Record<PaperCacheStatus, 'settings.paperCache.status.ready' | 'settings.paperCache.status.stale' | 'settings.paperCache.status.missing'> = {
    ready: 'settings.paperCache.status.ready',
    stale: 'settings.paperCache.status.stale',
    missing: 'settings.paperCache.status.missing',
  };
  return t(keys[status]);
}

function formatParsedAt(parsedAt: string | null): string {
  if (!parsedAt) return t('settings.paperCache.notParsed');
  const timestamp = Date.parse(parsedAt);
  if (!Number.isFinite(timestamp)) return parsedAt;
  return new Date(timestamp).toLocaleString();
}

function matchesFilter(entry: PaperLibraryEntry, filter: string): boolean {
  const needle = filter.trim().toLocaleLowerCase();
  if (!needle) return true;
  return [entry.citekey, entry.title, entry.pdfPath, entry.cachePath]
    .some(value => value?.toLocaleLowerCase().includes(needle));
}

export class PaperCacheSettings {
  private readonly rootEl: HTMLDivElement;
  private filter = '';
  private renderGeneration = 0;
  private readonly activeRebuilds = new Set<string>();

  constructor(
    containerEl: HTMLElement,
    private readonly host: PaperCacheSettingsHost,
    private readonly app: App,
  ) {
    this.rootEl = containerEl.createDiv({ cls: 'claudian-paper-cache-settings' });
    void this.render();
  }

  async refresh(): Promise<void> {
    await this.render();
  }

  private async render(): Promise<void> {
    const generation = ++this.renderGeneration;
    this.rootEl.empty();

    const header = this.rootEl.createDiv({ cls: 'claudian-paper-cache-header' });
    const headerCopy = header.createDiv({ cls: 'claudian-paper-cache-header-copy' });
    headerCopy.createDiv({
      cls: 'claudian-paper-cache-title',
      text: t('settings.paperCache.title'),
    });
    headerCopy.createDiv({
      cls: 'claudian-paper-cache-description',
      text: t('settings.paperCache.description'),
    });

    const headerActions = header.createDiv({ cls: 'claudian-paper-cache-header-actions' });
    const refreshButton = headerActions.createEl('button', {
      cls: 'claudian-settings-action-btn',
      attr: { 'aria-label': t('settings.paperCache.refresh') },
    });
    setIcon(refreshButton, 'refresh-cw');
    refreshButton.addEventListener('click', () => {
      void this.render();
    });

    let entries: readonly PaperLibraryEntry[];
    try {
      entries = await this.host.listPapers();
    } catch (error) {
      if (generation !== this.renderGeneration) return;
      this.rootEl.createDiv({
        cls: 'claudian-paper-cache-error',
        text: error instanceof Error ? error.message : t('settings.paperCache.loadFailed'),
      });
      return;
    }
    if (generation !== this.renderGeneration) return;

    const readyCount = entries.filter(entry => entry.cache === 'ready').length;
    const outdated = entries.filter(entry => entry.cache !== 'ready' && entry.pdfPath);
    const toolbar = this.rootEl.createDiv({ cls: 'claudian-paper-cache-toolbar' });
    const search = toolbar.createEl('input', {
      cls: 'claudian-paper-cache-filter',
      attr: {
        type: 'search',
        placeholder: t('settings.paperCache.filterPlaceholder'),
        'aria-label': t('settings.paperCache.filterLabel'),
      },
    });
    search.value = this.filter;
    search.addEventListener('input', () => {
      this.filter = search.value;
      void this.render();
    });

    const rebuildAll = toolbar.createEl('button', {
      cls: 'claudian-paper-cache-rebuild-all-button',
      text: t('settings.paperCache.rebuildOutdated'),
      attr: { type: 'button' },
    });
    rebuildAll.disabled = outdated.length === 0;
    rebuildAll.addEventListener('click', () => {
      void this.rebuildOutdated(entries);
    });

    this.rootEl.createDiv({
      cls: 'claudian-paper-cache-summary',
      text: t('settings.paperCache.summary', {
        total: entries.length,
        ready: readyCount,
        outdated: outdated.length,
      }),
    });

    const visibleEntries = entries.filter(entry => matchesFilter(entry, this.filter));
    if (visibleEntries.length === 0) {
      this.rootEl.createDiv({
        cls: 'claudian-paper-cache-empty',
        text: entries.length === 0
          ? t('settings.paperCache.empty')
          : t('settings.paperCache.noMatches'),
      });
      return;
    }

    const list = this.rootEl.createDiv({ cls: 'claudian-paper-cache-list' });
    for (const entry of visibleEntries) {
      this.renderEntry(list, entry);
    }
  }

  private renderEntry(list: HTMLDivElement, entry: PaperLibraryEntry): void {
    const row = list.createDiv({ cls: 'claudian-paper-cache-row' });
    const copy = row.createDiv({ cls: 'claudian-paper-cache-row-copy' });
    copy.createDiv({ cls: 'claudian-paper-cache-row-title', text: entry.title });
    copy.createDiv({
      cls: 'claudian-paper-cache-row-meta',
      text: [
        entry.citekey,
        statusLabel(entry.cache),
        entry.pages ? t('settings.paperCache.pages', { count: entry.pages }) : null,
        formatParsedAt(entry.parsedAt),
      ].filter(Boolean).join(' · '),
    });
    copy.createDiv({
      cls: 'claudian-paper-cache-row-path',
      text: entry.cachePath ?? t('settings.paperCache.noCachePath'),
    });

    const actions = row.createDiv({ cls: 'claudian-paper-cache-row-actions' });
    const cachePath = entry.cachePath;
    if (cachePath) {
      const openButton = actions.createEl('button', {
        cls: 'claudian-paper-cache-open-button',
        text: t('settings.paperCache.openCache'),
        attr: { type: 'button' },
      });
      openButton.addEventListener('click', () => {
        void this.app.workspace.openLinkText(cachePath, '', false);
      });
    }
    if (entry.pdfPath) {
      const rebuildButton = actions.createEl('button', {
        cls: 'claudian-paper-cache-rebuild-button',
        text: this.activeRebuilds.has(entry.pdfPath)
          ? t('settings.paperCache.rebuilding')
          : t('settings.paperCache.rebuild'),
        attr: { type: 'button' },
      });
      rebuildButton.disabled = this.activeRebuilds.has(entry.pdfPath);
      rebuildButton.addEventListener('click', () => {
        void this.rebuildOne(entry);
      });
    }
  }

  private async rebuildOne(entry: PaperLibraryEntry): Promise<void> {
    if (!entry.pdfPath || this.activeRebuilds.has(entry.pdfPath)) return;
    this.activeRebuilds.add(entry.pdfPath);
    try {
      await this.host.rebuildPaperCache(entry.pdfPath);
      new Notice(t('settings.paperCache.rebuildSucceeded', { name: entry.title }));
    } catch (error) {
      new Notice(t('settings.paperCache.rebuildFailed', {
        name: entry.title,
        message: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      this.activeRebuilds.delete(entry.pdfPath);
      await this.render();
    }
  }

  private async rebuildOutdated(entries: readonly PaperLibraryEntry[]): Promise<void> {
    const candidates = entries.filter(entry => entry.cache !== 'ready' && entry.pdfPath);
    if (candidates.length === 0) return;
    for (const entry of candidates) {
      await this.rebuildOne(entry);
    }
    new Notice(t('settings.paperCache.rebuildAllSucceeded', { count: candidates.length }));
  }
}
