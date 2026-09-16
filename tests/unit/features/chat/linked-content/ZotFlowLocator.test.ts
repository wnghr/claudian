import {
  parseAttachmentLinks,
  parseSourceNoteIdentity,
  parseZotFlowLink,
  resolveTargetFromReaderState,
  resolveTargetFromReference,
  resolveTargetFromSourceNote,
  ZOTFLOW_LOCAL_READER_VIEW_TYPE,
  ZOTFLOW_REMOTE_READER_VIEW_TYPE,
  ZotFlowLocator,
  type ZotFlowReaderState,
} from '@/features/chat/linked-content/ZotFlowLocator';

const NOTE_PATH = '文献/My Library/@asilehanLightdrivenDancingNematic2025a.md';

/** Trimmed from the real source note in the reference vault. */
const SOURCE_NOTE = `---
citationKey: asilehanLightdrivenDancingNematic2025a
title: Light-driven dancing of nematic colloids
zotflow-locked: true
zotero-key: YYWDW33L
item-version: 7599
library-id: 19952292
---
# Light-driven dancing of nematic colloids
## Attachments
- [main.pdf](obsidian://zotflow?type=open-attachment&libraryID=19952292&key=8ZJQUTW2)
- [supp.pdf](obsidian://zotflow?type=open-attachment&libraryID=19952292&key=FW3FUIXR)
## Annotations
> [!zotflow-image-#ffd400] [main.pdf, p.7](obsidian://zotflow?type=open-annotation&libraryID=19952292&key=E6QCQBKE)
`;

describe('parsing ZotFlow links', () => {
  it('separates attachments from annotations', () => {
    expect(parseZotFlowLink('obsidian://zotflow?type=open-attachment&libraryID=19952292&key=8ZJQUTW2'))
      .toEqual({ key: '8ZJQUTW2', kind: 'attachment', libraryID: 19952292 });
    expect(parseZotFlowLink('obsidian://zotflow?type=open-annotation&libraryID=19952292&key=E6QCQBKE'))
      .toMatchObject({ kind: 'annotation' });
    expect(parseZotFlowLink('obsidian://zotflow?type=open-note&key=8ZJQUTW2')).toBeNull();
    expect(parseZotFlowLink('https://example.com/paper.pdf')).toBeNull();
  });

  it('lists attachment links in note order without duplicates', () => {
    expect(parseAttachmentLinks(SOURCE_NOTE).map(link => link.key)).toEqual(['8ZJQUTW2', 'FW3FUIXR']);
    expect(parseAttachmentLinks(`${SOURCE_NOTE}\n${SOURCE_NOTE}`).map(link => link.key))
      .toEqual(['8ZJQUTW2', 'FW3FUIXR']);
  });

  it('reads the note identity, where `zotero-key` is the parent item', () => {
    expect(parseSourceNoteIdentity(SOURCE_NOTE)).toEqual({
      citationKey: 'asilehanLightdrivenDancingNematic2025a',
      libraryID: 19952292,
      parentItemKey: 'YYWDW33L',
    });
    expect(parseSourceNoteIdentity('# no frontmatter')).toEqual({
      citationKey: null,
      libraryID: null,
      parentItemKey: null,
    });
  });
});

describe('resolveTargetFromSourceNote', () => {
  it('maps a note onto its first PDF attachment, not its parent item key', () => {
    const target = resolveTargetFromSourceNote(SOURCE_NOTE, NOTE_PATH);
    expect(target).toMatchObject({
      attachmentKey: '8ZJQUTW2',
      libraryID: 19952292,
      origin: 'source-note',
      parentItemKey: 'YYWDW33L',
      sourceNotePath: NOTE_PATH,
      sourcePath: 'zotero/8ZJQUTW2.pdf',
    });
  });

  it('skips a snapshot listed first once a real PDF is known', () => {
    const noteWithSnapshotFirst = SOURCE_NOTE.replace(
      '- [main.pdf](obsidian://zotflow?type=open-attachment&libraryID=19952292&key=8ZJQUTW2)\n',
      '- [page.html](obsidian://zotflow?type=open-attachment&libraryID=19952292&key=XA2U4Y29)\n'
        + '- [main.pdf](obsidian://zotflow?type=open-attachment&libraryID=19952292&key=8ZJQUTW2)\n',
    );
    const target = resolveTargetFromSourceNote(
      noteWithSnapshotFirst,
      NOTE_PATH,
      new Set(['8ZJQUTW2']),
    );
    expect(target?.attachmentKey).toBe('8ZJQUTW2');
  });

  it('reports nothing when the note lists no attachments', () => {
    expect(resolveTargetFromSourceNote('# empty note', NOTE_PATH)).toBeNull();
  });
});

describe('resolveTargetFromReaderState', () => {
  it('reads the attachment the remote reader reports', () => {
    const readPage = jest.fn();
    const reader: ZotFlowReaderState = {
      state: { itemKey: '8ZJQUTW2', libraryID: 19952292 },
      viewType: ZOTFLOW_REMOTE_READER_VIEW_TYPE,
      readPage,
    };
    const target = resolveTargetFromReaderState(reader);
    expect(target).toMatchObject({
      attachmentKey: '8ZJQUTW2',
      origin: 'reader',
      sourcePath: 'zotero/8ZJQUTW2.pdf',
    });
    expect(target?.readPage).toBe(readPage);
  });

  it('reads the vault path the local reader reports', () => {
    const reader: ZotFlowReaderState = {
      state: { file: '文献/PDF/paper.pdf' },
      viewType: ZOTFLOW_LOCAL_READER_VIEW_TYPE,
    };
    expect(resolveTargetFromReaderState(reader)).toMatchObject({
      attachmentKey: null,
      origin: 'local-reader',
      sourcePath: '文献/PDF/paper.pdf',
    });
  });

  it('ignores reader views it does not understand', () => {
    expect(resolveTargetFromReaderState({ state: { itemKey: '8ZJQUTW2' }, viewType: 'other-view' }))
      .toBeNull();
    expect(resolveTargetFromReaderState({ state: null, viewType: ZOTFLOW_REMOTE_READER_VIEW_TYPE }))
      .toBeNull();
  });
});

describe('resolveTargetFromReference', () => {
  it('accepts a pasted ZotFlow link and a bare attachment reference', () => {
    expect(resolveTargetFromReference('obsidian://zotflow?type=open-attachment&libraryID=19952292&key=8ZJQUTW2'))
      .toMatchObject({ attachmentKey: '8ZJQUTW2', origin: 'link' });
    expect(resolveTargetFromReference('zotero/8ZJQUTW2.pdf'))
      .toMatchObject({ attachmentKey: '8ZJQUTW2', origin: 'reference', sourcePath: 'zotero/8ZJQUTW2.pdf' });
  });

  it('leaves plain vault paths for the note resolver', () => {
    expect(resolveTargetFromReference('论文/PDF/paper.pdf')).toBeNull();
  });
});

describe('ZotFlowLocator.resolve', () => {
  function locator(overrides: Partial<ConstructorParameters<typeof ZotFlowLocator>[0]> = {}) {
    return new ZotFlowLocator({
      readNote: async () => SOURCE_NOTE,
      listReaderStates: () => [],
      ...overrides,
    });
  }

  it('resolves a linked source note even though the note key is a parent item', async () => {
    await expect(locator().resolve(NOTE_PATH)).resolves.toMatchObject({
      attachmentKey: '8ZJQUTW2',
      sourcePath: 'zotero/8ZJQUTW2.pdf',
    });
  });

  it('follows the open reader when nothing is named', async () => {
    const locatorWithReader = locator({
      listReaderStates: () => [{
        state: { itemKey: '6UM5DTDQ', libraryID: 19952292 },
        viewType: ZOTFLOW_REMOTE_READER_VIEW_TYPE,
      }],
    });
    await expect(locatorWithReader.resolve(undefined)).resolves.toMatchObject({
      attachmentKey: '6UM5DTDQ',
      origin: 'reader',
    });
  });

  it('lets an explicit reference win over the open reader', async () => {
    const locatorWithReader = locator({
      listReaderStates: () => [{
        state: { itemKey: '6UM5DTDQ', libraryID: 19952292 },
        viewType: ZOTFLOW_REMOTE_READER_VIEW_TYPE,
      }],
    });
    await expect(locatorWithReader.resolve('zotero/8ZJQUTW2.pdf'))
      .resolves.toMatchObject({ attachmentKey: '8ZJQUTW2' });
  });

  it('keeps an explicit vault PDF ahead of an unrelated open reader', async () => {
    const locatorWithReader = locator({
      listReaderStates: () => [{
        state: { itemKey: '6UM5DTDQ', libraryID: 19952292 },
        viewType: ZOTFLOW_REMOTE_READER_VIEW_TYPE,
      }],
    });
    await expect(locatorWithReader.resolve('论文/PDF/paper.pdf'))
      .resolves.toMatchObject({ sourcePath: '论文/PDF/paper.pdf', origin: 'reference' });
  });

  it('asks Zotero which attachment is a real PDF', async () => {
    const asked: string[] = [];
    const locatorWithProbe = locator({
      isPdfAttachment: async key => {
        asked.push(key);
        return key === 'FW3FUIXR';
      },
    });
    await expect(locatorWithProbe.resolve(NOTE_PATH))
      .resolves.toMatchObject({ attachmentKey: 'FW3FUIXR' });
    expect(asked).toEqual(['8ZJQUTW2', 'FW3FUIXR']);
  });

  it('reports nothing when there is no reader and no reference', async () => {
    await expect(locator().resolve(undefined)).resolves.toBeNull();
    await expect(locator({ readNote: async () => null }).resolve('missing/note.md')).resolves.toBeNull();
  });
});
