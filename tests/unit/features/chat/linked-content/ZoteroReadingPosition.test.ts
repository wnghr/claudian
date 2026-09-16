import path from 'node:path';

import {
  findZotFlowViewStateKey,
  parseZoteroReaderStatePage,
  parseZotFlowViewStatePage,
  ZoteroReadingPositionReader,
} from '@/features/chat/linked-content/ZoteroReadingPosition';

const STORAGE_ROOT = path.join('C:', 'Users', 'me', 'Zotero', 'storage');
const DATA_FILE = path.join('C:', 'Users', 'me', 'vault', '.obsidian', 'plugins', 'zotflow', 'data.json');
const ATTACHMENT_KEY = '8ZJQUTW2';

function viewStateJson(pageIndex: number, key = `19952292:${ATTACHMENT_KEY}`) {
  return JSON.stringify({
    viewStates: {
      [key]: {
        primaryViewState: { pageIndex, scale: 'page-width' },
      },
    },
  });
}

describe('parsing stored positions', () => {
  it('reads the page index ZotFlow stores for an attachment', () => {
    expect(parseZotFlowViewStatePage(viewStateJson(2), 19952292, ATTACHMENT_KEY)).toBe(2);
  });

  it('falls back to the secondary view when the primary has no page', () => {
    const json = JSON.stringify({
      viewStates: {
        [`19952292:${ATTACHMENT_KEY}`]: { secondaryViewState: { pageIndex: 7 } },
      },
    });
    expect(parseZotFlowViewStatePage(json, 19952292, ATTACHMENT_KEY)).toBe(7);
  });

  it('matches on the attachment key alone when the library is unknown', () => {
    // All we have for a `zotero/<KEY>.pdf` path is the key, and Zotero item keys
    // are globally unique, so the library segment can be skipped.
    expect(parseZotFlowViewStatePage(viewStateJson(4), null, ATTACHMENT_KEY)).toBe(4);
    expect(parseZotFlowViewStatePage(viewStateJson(4), null, 'ZZZZ9999')).toBeNull();
    expect(parseZotFlowViewStatePage('not json', null, ATTACHMENT_KEY)).toBeNull();
  });

  it('reads Zotero\'s own reader state, ignoring malformed values', () => {
    expect(parseZoteroReaderStatePage(JSON.stringify({ pageIndex: 238 }))).toBe(238);
    expect(parseZoteroReaderStatePage(JSON.stringify({ pageIndex: -1 }))).toBeNull();
    expect(parseZoteroReaderStatePage(JSON.stringify({ pageIndex: 'x' }))).toBeNull();
  });

  it('does not confuse one attachment with another in the same library', () => {
    const states = { [`19952292:${ATTACHMENT_KEY}`]: {}, '19952292:OTHER999': {} };
    expect(findZotFlowViewStateKey(states, null, ATTACHMENT_KEY)).toBe(`19952292:${ATTACHMENT_KEY}`);
    expect(findZotFlowViewStateKey(states, 19952292, 'MISSING9')).toBeNull();
  });
});

describe('ZoteroReadingPositionReader', () => {
  function reader(files: Record<string, { text: string; mtimeMs: number }>) {
    return new ZoteroReadingPositionReader({
      storageRoot: STORAGE_ROOT,
      zotFlowDataFile: DATA_FILE,
      readText: async filePath => {
        const entry = files[filePath];
        if (!entry) throw new Error('ENOENT');
        return entry.text;
      },
      statFile: async filePath => {
        const entry = files[filePath];
        if (!entry) throw new Error('ENOENT');
        return { mtimeMs: entry.mtimeMs };
      },
    });
  }

  const readerStateFile = path.join(STORAGE_ROOT, ATTACHMENT_KEY, '.zotero-reader-state');

  it('reports the ZotFlow page as a 1-based number', async () => {
    const positions = reader({ [DATA_FILE]: { text: viewStateJson(272), mtimeMs: 10 } });
    await expect(positions.read({ attachmentKey: ATTACHMENT_KEY, libraryID: 19952292 }))
      .resolves.toEqual({ page: 273, recordedAt: 10, source: 'zotflow-view-state' });
  });

  it('prefers Zotero\'s state when Zotero was used more recently', async () => {
    // The two writers drift: reading in Zotero Desktop after Obsidian leaves a
    // newer .zotero-reader-state, and the stale data.json entry must lose.
    const positions = reader({
      [DATA_FILE]: { text: viewStateJson(2), mtimeMs: 100 },
      [readerStateFile]: { text: JSON.stringify({ pageIndex: 238 }), mtimeMs: 200 },
    });
    await expect(positions.read({ attachmentKey: ATTACHMENT_KEY, libraryID: 19952292 }))
      .resolves.toEqual({ page: 239, recordedAt: 200, source: 'zotero-reader-state' });
  });

  it('keeps ZotFlow ahead of Zotero when a live reader confirms the entry', async () => {
    // data.json is written for every paper, so its mtime alone is not evidence
    // about *this* attachment - an open reader is.
    const positions = reader({
      [DATA_FILE]: { text: viewStateJson(2), mtimeMs: 100 },
      [readerStateFile]: { text: JSON.stringify({ pageIndex: 238 }), mtimeMs: 200 },
    });
    await expect(positions.read({
      attachmentKey: ATTACHMENT_KEY,
      libraryID: 19952292,
      preferViewState: true,
    })).resolves.toEqual({ page: 3, recordedAt: 100, source: 'zotflow-view-state' });
  });

  it('uses Zotero\'s state for a paper ZotFlow has never opened', async () => {
    const positions = reader({ [readerStateFile]: { text: JSON.stringify({ pageIndex: 4 }), mtimeMs: 5 } });
    await expect(positions.read({ attachmentKey: ATTACHMENT_KEY, libraryID: 19952292 }))
      .resolves.toEqual({ page: 5, recordedAt: 5, source: 'zotero-reader-state' });
  });

  it('reports nothing rather than guessing when neither writer has a position', async () => {
    await expect(reader({}).read({ attachmentKey: ATTACHMENT_KEY, libraryID: 19952292 }))
      .resolves.toBeNull();
  });
});
