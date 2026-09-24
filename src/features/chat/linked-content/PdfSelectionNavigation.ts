import type { App } from 'obsidian';

import type { BrowserSelectionContext } from '../../../utils/browser';
import { parseZoteroAttachmentReference } from './ZoteroAttachmentReference';

const ZOTFLOW_READER_VIEW = 'zotflow-zotero-reader-view';

/** Return to the exact PDF captured with a question, rather than the currently active paper. */
export async function openPdfSelectionSource(
  app: App,
  context: BrowserSelectionContext,
): Promise<boolean> {
  const path = context.pdfPath;
  if (!path) return false;

  const attachmentKey = parseZoteroAttachmentReference(path);
  if (!attachmentKey) {
    const suffix = context.page ? `#page=${context.page}` : '';
    await app.workspace.openLinkText(`${path}${suffix}`, '', 'tab');
    return true;
  }

  const leaves = app.workspace.getLeavesOfType(ZOTFLOW_READER_VIEW);
  let leaf = leaves.find(candidate => candidate.getViewState().state?.itemKey === attachmentKey);
  if (!leaf) {
    const nativeLeaf = app.workspace.getLeavesOfType('pdf')
      .find(candidate => candidate.getViewState().state?.file === path);
    if (nativeLeaf) {
      await app.workspace.revealLeaf(nativeLeaf);
      const nativeReader = nativeLeaf.view as typeof nativeLeaf.view & {
        pdfViewer?: { pdfViewer?: { scrollPageIntoView?: (options: { pageNumber: number }) => void } };
      };
      if (context.page) nativeReader.pdfViewer?.pdfViewer?.scrollPageIntoView?.({ pageNumber: context.page });
      return true;
    }
  }
  if (!leaf && context.libraryID !== undefined) {
    leaf = app.workspace.getLeaf('tab');
    await leaf.setViewState({
      type: ZOTFLOW_READER_VIEW,
      active: true,
      state: { libraryID: context.libraryID, itemKey: attachmentKey },
    });
  }
  if (!leaf) return false;

  await app.workspace.revealLeaf(leaf);
  if (context.page) {
    const reader = leaf.view as typeof leaf.view & {
      readerNavigate?: (navigation: { position: { pageIndex: number } }) => void;
    };
    reader.readerNavigate?.({ position: { pageIndex: context.page - 1 } });
  }
  return true;
}
