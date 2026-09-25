/** @jest-environment jsdom */

import { BrowserSelectionController } from '@/features/chat/controllers/BrowserSelectionController';

function createMockContextTray() {
  return {
    setItems: jest.fn(),
    clearItems: jest.fn(),
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('BrowserSelectionController', () => {
  let controller: BrowserSelectionController;
  let app: any;
  let contextTray: ReturnType<typeof createMockContextTray>;
  let inputEl: HTMLTextAreaElement;
  let containerEl: HTMLElement;
  let selectionText = 'selected web snippet';
  let getSelectionSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    selectionText = 'selected web snippet';

    contextTray = createMockContextTray();
    inputEl = document.createElement('textarea');
    document.body.appendChild(inputEl);
    containerEl = document.createElement('div');
    const selectionAnchor = document.createElement('span');
    containerEl.appendChild(selectionAnchor);

    getSelectionSpy = jest.spyOn(document, 'getSelection').mockImplementation(() => ({
      toString: () => selectionText,
      anchorNode: selectionAnchor,
      focusNode: selectionAnchor,
    } as unknown as Selection));

    const view = {
      getViewType: () => 'surfing-view',
      getDisplayText: () => 'Surfing',
      containerEl,
      currentUrl: 'https://example.com',
    };

    app = {
      workspace: {
        activeLeaf: { view },
        getMostRecentLeaf: jest.fn(() => ({ view })),
      },
    };

    controller = new BrowserSelectionController(app, contextTray as any, inputEl);
  });

  afterEach(() => {
    controller.stop();
    inputEl.remove();
    getSelectionSpy.mockRestore();
    jest.useRealTimers();
  });

  it('captures browser selection and updates indicator', async () => {
    controller.start();
    jest.advanceTimersByTime(250);
    await flushMicrotasks();

    expect(controller.getContext()).toEqual({
      source: 'browser:https://example.com',
      selectedText: 'selected web snippet',
      title: 'Surfing',
      url: 'https://example.com',
    });
    expect(contextTray.setItems).toHaveBeenLastCalledWith('browser-selection', [
      expect.objectContaining({
        label: '1 line selected',
      }),
    ]);
    expect(contextTray.setItems.mock.calls[0][1][0]).not.toHaveProperty('title');
  });

  it('captures the exact ZotFlow attachment and selected PDF page', async () => {
    const page = containerEl.createDiv();
    page.setAttribute('data-page-number', '7');
    const selectionAnchor = page.createSpan({ text: 'selected paper text' });
    getSelectionSpy.mockImplementation(() => ({
      toString: () => selectionText,
      anchorNode: selectionAnchor,
      focusNode: selectionAnchor,
    } as unknown as Selection));
    const view = {
      getViewType: () => 'zotflow-zotero-reader-view',
      getDisplayText: () => 'Main paper PDF',
      getState: () => ({ libraryID: 1, itemKey: 'PAPER123' }),
      containerEl,
    };
    app.workspace.getMostRecentLeaf.mockReturnValue({ view });

    controller.start();
    jest.advanceTimersByTime(250);
    await flushMicrotasks();

    expect(controller.getContext()).toMatchObject({
      source: 'pdf:zotero/PAPER123.pdf',
      selectedText: selectionText,
      pdfPath: 'zotero/PAPER123.pdf',
      page: 7,
      libraryID: 1,
    });
    expect(controller.getContext()?.url).toContain('key=PAPER123');
    expect(contextTray.setItems).toHaveBeenLastCalledWith('browser-selection', [
      expect.objectContaining({ label: 'PDF · p.7 · 1 line selected' }),
    ]);
  });

  it('reads a ZotFlow PDF selection inside its nested reader iframe', async () => {
    const outerFrame = document.createElement('iframe');
    containerEl.appendChild(outerFrame);
    const outerDocument = document.implementation.createHTMLDocument('reader');
    Object.defineProperty(outerFrame, 'contentDocument', { value: outerDocument });
    const innerFrame = outerDocument.createElement('iframe');
    outerDocument.body.appendChild(innerFrame);
    const innerDocument = document.implementation.createHTMLDocument('pdf');
    Object.defineProperty(innerFrame, 'contentDocument', { value: innerDocument });
    const page = innerDocument.createElement('div');
    page.setAttribute('data-page-number', '3');
    const selectionAnchor = innerDocument.createElement('span');
    page.appendChild(selectionAnchor);
    innerDocument.body.appendChild(page);
    getSelectionSpy.mockImplementation(() => ({
      toString: () => '', anchorNode: null, focusNode: null,
    } as unknown as Selection));
    const innerSelection = jest.spyOn(innerDocument, 'getSelection').mockImplementation(() => ({
      toString: () => 'nested PDF text',
      anchorNode: selectionAnchor,
      focusNode: selectionAnchor,
    } as unknown as Selection));
    const view = {
      getViewType: () => 'zotflow-zotero-reader-view',
      getDisplayText: () => 'Paper',
      getState: () => ({ libraryID: 1, itemKey: 'PAPER123' }),
      containerEl,
    };
    app.workspace.getMostRecentLeaf.mockReturnValue({ view });

    controller.start();
    jest.advanceTimersByTime(250);
    await flushMicrotasks();

    expect(controller.getContext()).toMatchObject({
      selectedText: 'nested PDF text', pdfPath: 'zotero/PAPER123.pdf', page: 3,
    });
    innerSelection.mockRestore();
  });

  it('shows line-based indicator text for multi-line browser selection', async () => {
    selectionText = 'line 1\nline 2';
    controller.start();
    jest.advanceTimersByTime(250);
    await flushMicrotasks();

    expect(contextTray.setItems).toHaveBeenLastCalledWith('browser-selection', [
      expect.objectContaining({ label: '2 lines selected' }),
    ]);
  });

  it('clears selection when text is deselected and input is not focused', async () => {
    controller.start();
    jest.advanceTimersByTime(250);
    await flushMicrotasks();
    expect(controller.hasSelection()).toBe(true);

    selectionText = '';
    jest.advanceTimersByTime(250);
    await flushMicrotasks();

    expect(controller.hasSelection()).toBe(false);
    expect(contextTray.clearItems).toHaveBeenCalledWith('browser-selection');
  });

  it('keeps selection while input is focused', async () => {
    controller.start();
    jest.advanceTimersByTime(250);
    await flushMicrotasks();
    expect(controller.hasSelection()).toBe(true);

    selectionText = '';
    inputEl.focus();
    jest.advanceTimersByTime(250);
    await flushMicrotasks();

    expect(controller.hasSelection()).toBe(true);
  });

  it('clears selection when clear is called', async () => {
    controller.start();
    jest.advanceTimersByTime(250);
    await flushMicrotasks();
    expect(controller.hasSelection()).toBe(true);

    controller.clear();

    expect(controller.hasSelection()).toBe(false);
    expect(contextTray.clearItems).toHaveBeenCalledWith('browser-selection');
  });

  it('clears selection from the tray remove action', async () => {
    controller.start();
    jest.advanceTimersByTime(250);
    await flushMicrotasks();

    const items = contextTray.setItems.mock.calls[0][1];
    items[0].onRemove();

    expect(controller.hasSelection()).toBe(false);
    expect(contextTray.clearItems).toHaveBeenCalledWith('browser-selection');
  });

  it('handles polling errors without unhandled rejection', async () => {
    const extractSpy = jest.spyOn(controller as any, 'extractSelectedText')
      .mockRejectedValueOnce(new Error('poll failed'));

    controller.start();
    jest.advanceTimersByTime(250);
    await flushMicrotasks();

    expect(extractSpy).toHaveBeenCalled();
    expect(controller.hasSelection()).toBe(false);
  });
});
