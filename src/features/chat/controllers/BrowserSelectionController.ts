import type { App, ItemView } from 'obsidian';
import { Notice } from 'obsidian';

import type { BrowserSelectionContext } from '../../../utils/browser';
import { openPdfSelectionSource } from '../linked-content/PdfSelectionNavigation';
import type { ComposerContextTray } from '../ui/ComposerContextTray';

const BROWSER_SELECTION_POLL_INTERVAL = 250;

type BrowserLikeWebview = HTMLElement & {
  executeJavaScript?: (code: string, userGesture?: boolean) => Promise<unknown>;
};

export class BrowserSelectionController {
  private app: App;
  private contextTray: ComposerContextTray;
  private inputEl: HTMLElement;
  private onVisibilityChange: (() => void) | null;
  private onUserSelectionChanged: (() => void) | null;
  private storedSelection: BrowserSelectionContext | null = null;
  private pollInterval: number | null = null;
  private pollInFlight = false;

  constructor(
    app: App,
    contextTray: ComposerContextTray,
    inputEl: HTMLElement,
    onVisibilityChange?: () => void,
    onUserSelectionChanged?: () => void,
  ) {
    this.app = app;
    this.contextTray = contextTray;
    this.inputEl = inputEl;
    this.onVisibilityChange = onVisibilityChange ?? null;
    this.onUserSelectionChanged = onUserSelectionChanged ?? null;
  }

  start(): void {
    if (this.pollInterval) return;
    this.pollInterval = window.setInterval(() => {
      void this.#poll();
    }, BROWSER_SELECTION_POLL_INTERVAL);
  }

  stop(): void {
    if (this.pollInterval) {
      window.clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    this.clear();
  }

  async #poll(): Promise<void> {
    if (this.pollInFlight) return;
    this.pollInFlight = true;
    try {
      const browserView = this.#getActiveBrowserView();
      if (!browserView) {
        this.#clearWhenInputIsNotFocused();
        return;
      }

      const selectedText = await this.extractSelectedText(browserView.containerEl);
      if (selectedText) {
        const nextContext = this.#buildContext(browserView.view, browserView.viewType, browserView.containerEl, selectedText);
        if (!this.#isSameSelection(nextContext, this.storedSelection)) {
          this.storedSelection = nextContext;
          this.updateIndicator();
          this.onUserSelectionChanged?.();
        }
      } else {
        this.#clearWhenInputIsNotFocused();
      }
    } catch {
      // Ignore transient polling errors to keep selection tracking resilient.
    } finally {
      this.pollInFlight = false;
    }
  }

  #getActiveBrowserView(): { view: ItemView; viewType: string; containerEl: HTMLElement } | null {
    const activeLeaf = this.app.workspace.getMostRecentLeaf?.();
    const activeView = activeLeaf?.view as ItemView | undefined;
    if (!activeView) return null;
    const containerEl = (activeView as unknown as { containerEl?: HTMLElement }).containerEl;
    if (!containerEl) return null;

    const viewType = activeView.getViewType?.() ?? '';
    if (!this.#isBrowserLikeView(viewType, containerEl)) return null;

    return { view: activeView, viewType, containerEl };
  }

  #isBrowserLikeView(viewType: string, containerEl: HTMLElement): boolean {
    const normalized = viewType.toLowerCase();
    if (
      normalized === 'pdf'
      || normalized === 'zotflow-zotero-reader-view'
      || normalized === 'zotflow-local-zotero-reader-view'
      || normalized.includes('surfing')
      || normalized.includes('browser')
      || normalized.includes('webview')
    ) {
      return true;
    }

    return Boolean(containerEl.querySelector('iframe, webview'));
  }

  private async extractSelectedText(containerEl: HTMLElement): Promise<string | null> {
    const ownerDoc = containerEl.ownerDocument;
    const docSelection = this.#extractSelectionFromDocument(ownerDoc, containerEl);
    if (docSelection) return docSelection;

    const frameSelection = this.#extractSelectionFromIframes(containerEl);
    if (frameSelection) return frameSelection;

    return await this.#extractSelectionFromWebviews(containerEl);
  }

  #extractSelectionFromDocument(doc: Document, scopeEl: HTMLElement): string | null {
    const selection = doc.getSelection();
    const selectedText = selection?.toString().trim();
    if (selectedText) {
      const anchorNode = selection?.anchorNode;
      const focusNode = selection?.focusNode;
      if ((anchorNode && scopeEl.contains(anchorNode)) || (focusNode && scopeEl.contains(focusNode))) {
        return selectedText;
      }
    }

    return this.#extractSelectionFromActiveInput(doc, scopeEl);
  }

  #extractSelectionFromActiveInput(doc: Document, scopeEl: HTMLElement): string | null {
    const activeEl = doc.activeElement;
    if (!activeEl || !scopeEl.contains(activeEl)) return null;

    if (activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'INPUT') {
      const { value, selectionStart, selectionEnd } = activeEl as HTMLTextAreaElement | HTMLInputElement;
      if (typeof selectionStart !== 'number' || typeof selectionEnd !== 'number' || selectionStart === selectionEnd) return null;
      return value.slice(selectionStart, selectionEnd).trim() || null;
    }

    return null;
  }

  #extractSelectionFromIframes(containerEl: HTMLElement): string | null {
    for (const frameDoc of this.#frameDocuments(containerEl)) {
      if (!frameDoc.body) continue;
      const frameSelection = this.#extractSelectionFromDocument(frameDoc, frameDoc.body);
      if (frameSelection) return frameSelection;
    }
    return null;
  }

  #frameDocuments(containerEl: HTMLElement): Document[] {
    const documents: Document[] = [];
    const visit = (root: ParentNode, depth: number): void => {
      if (depth > 4) return;
      for (const iframe of Array.from(root.querySelectorAll('iframe'))) {
        try {
          const frameDoc = iframe.contentDocument ?? iframe.contentWindow?.document;
          if (!frameDoc || documents.includes(frameDoc)) continue;
          documents.push(frameDoc);
          visit(frameDoc, depth + 1);
        } catch {
          // Ignore inaccessible iframe contexts (cross-origin restrictions).
        }
      }
    };
    visit(containerEl, 1);
    return documents;
  }

  async #extractSelectionFromWebviews(containerEl: HTMLElement): Promise<string | null> {
    const webviews = Array.from(containerEl.querySelectorAll<BrowserLikeWebview>('webview'));
    for (const webview of webviews) {
      if (typeof webview.executeJavaScript !== 'function') continue;
      try {
        const result = await webview.executeJavaScript(
          'window.getSelection ? window.getSelection().toString() : ""',
          true
        );
        if (typeof result === 'string' && result.trim()) {
          return result.trim();
        }
      } catch {
        // Ignore inaccessible webview contexts.
      }
    }
    return null;
  }

  #buildContext(
    view: ItemView,
    viewType: string,
    containerEl: HTMLElement,
    selectedText: string
  ): BrowserSelectionContext {
    const title = this.#extractViewTitle(view);
    const pdf = this.#pdfIdentity(view, viewType);
    if (pdf) {
      const page = this.#selectedPdfPage(containerEl);
      const navigation = page ? { position: { pageIndex: page - 1 } } : undefined;
      const url = pdf.attachmentKey && pdf.libraryID !== undefined
        ? `obsidian://zotflow?type=open-attachment&libraryID=${pdf.libraryID}&key=${pdf.attachmentKey}`
          + (navigation ? `&navigation=${encodeURIComponent(JSON.stringify(navigation))}` : '')
        : undefined;
      return {
        source: `pdf:${pdf.path}`,
        selectedText,
        title,
        pdfPath: pdf.path,
        ...(page ? { page } : {}),
        ...(pdf.libraryID !== undefined ? { libraryID: pdf.libraryID } : {}),
        ...(url ? { url } : {}),
      };
    }
    const url = this.#extractViewUrl(view, containerEl);
    const source = url ? `browser:${url}` : `browser:${viewType || 'unknown'}`;

    return {
      source,
      selectedText,
      title,
      url,
    };
  }

  #pdfIdentity(view: ItemView, viewType: string): {
    path: string;
    attachmentKey?: string;
    libraryID?: number;
  } | null {
    if (!['pdf', 'zotflow-zotero-reader-view', 'zotflow-local-zotero-reader-view'].includes(viewType)) {
      return null;
    }
    const state = view.getState?.() as Record<string, unknown> | undefined;
    const itemKey = typeof state?.itemKey === 'string' ? state.itemKey.trim() : '';
    const libraryID = typeof state?.libraryID === 'number' && Number.isFinite(state.libraryID)
      ? state.libraryID : undefined;
    if (itemKey) return { path: `zotero/${itemKey}.pdf`, attachmentKey: itemKey, libraryID };
    const file = typeof state?.file === 'string' ? state.file.trim() : '';
    return file ? { path: file, libraryID } : null;
  }

  #selectedPdfPage(containerEl: HTMLElement): number | null {
    const documents: Document[] = [containerEl.ownerDocument, ...this.#frameDocuments(containerEl)];
    for (const doc of documents) {
      const selection = doc.getSelection();
      if (!selection?.toString().trim()) continue;
      const anchor = selection.anchorNode;
      if (!anchor || (doc === containerEl.ownerDocument && !containerEl.contains(anchor))) continue;
      const element = anchor.nodeType === 1 ? anchor as Element : anchor.parentElement;
      const pageEl = element?.closest('[data-page-number], [data-page-index]');
      if (!pageEl) continue;
      const pageNumberAttr = pageEl.getAttribute('data-page-number');
      const pageNumber = pageNumberAttr === null ? null : Number(pageNumberAttr);
      if (pageNumber !== null && Number.isSafeInteger(pageNumber) && pageNumber > 0) return pageNumber;
      const pageIndexAttr = pageEl.getAttribute('data-page-index');
      const pageIndex = pageIndexAttr === null ? null : Number(pageIndexAttr);
      if (pageIndex !== null && Number.isSafeInteger(pageIndex) && pageIndex >= 0) return pageIndex + 1;
    }
    return null;
  }

  #extractViewTitle(view: ItemView): string | undefined {
    const displayText = view.getDisplayText?.();
    if (displayText?.trim()) return displayText.trim();

    const title = (view as unknown as { title?: unknown }).title;
    return typeof title === 'string' && title.trim() ? title.trim() : undefined;
  }

  #extractViewUrl(view: ItemView, containerEl: HTMLElement): string | undefined {
    const rawView = view as unknown as Record<string, unknown>;
    const directCandidates = [
      rawView.url,
      rawView.currentUrl,
      rawView.currentURL,
      rawView.src,
    ];

    for (const candidate of directCandidates) {
      if (typeof candidate === 'string' && candidate.trim()) {
        return candidate.trim();
      }
    }

    const embeddableEl = containerEl.querySelector<HTMLElement>('iframe[src], webview[src]');
    const embeddedSrc = embeddableEl?.getAttribute('src');
    if (embeddedSrc?.trim()) {
      return embeddedSrc.trim();
    }

    return undefined;
  }

  #isSameSelection(
    left: BrowserSelectionContext | null,
    right: BrowserSelectionContext | null
  ): boolean {
    if (!left || !right) return false;
    return left.source === right.source
      && left.selectedText === right.selectedText
      && left.title === right.title
      && left.url === right.url
      && left.pdfPath === right.pdfPath
      && left.page === right.page;
  }

  #clearWhenInputIsNotFocused(): void {
    if (this.inputEl.contains(this.inputEl.ownerDocument.activeElement)) return;
    if (this.storedSelection) {
      this.storedSelection = null;
      this.updateIndicator();
      this.onUserSelectionChanged?.();
    }
  }

  private updateIndicator(): void {
    if (this.storedSelection) {
      const lineCount = this.storedSelection.selectedText.split(/\r?\n/).length;
      const lineLabel = lineCount === 1 ? 'line' : 'lines';
      const label = this.storedSelection.pdfPath
        ? `PDF${this.storedSelection.page ? ` · p.${this.storedSelection.page}` : ''} · ${lineCount} ${lineLabel} selected`
        : `${lineCount} ${lineLabel} selected`;
      this.contextTray.setItems('browser-selection', [{
        id: 'browser-selection',
        kind: 'selection',
        label,
        icon: this.storedSelection.pdfPath ? 'file-text' : 'globe',
        ariaLabel: label,
        ...(this.storedSelection.pdfPath ? {
          title: this.storedSelection.pdfPath,
          onActivate: () => {
            const context = this.storedSelection;
            if (!context) return;
            void openPdfSelectionSource(this.app, context).then(opened => {
              if (!opened) new Notice('请先在阅读器中打开该附件，再点击来源。');
            }).catch(error => new Notice(`无法打开 PDF 来源：${String(error)}`));
          },
        } : {}),
        onRemove: () => {
          this.clear();
          this.onUserSelectionChanged?.();
        },
      }]);
    } else {
      this.contextTray.clearItems('browser-selection');
    }
    this.updateContextRowVisibility();
  }

  updateContextRowVisibility(): void {
    this.onVisibilityChange?.();
  }

  getContext(): BrowserSelectionContext | null {
    return this.storedSelection;
  }

  hasSelection(): boolean {
    return this.storedSelection !== null;
  }

  clear(): void {
    this.storedSelection = null;
    this.updateIndicator();
  }
}
