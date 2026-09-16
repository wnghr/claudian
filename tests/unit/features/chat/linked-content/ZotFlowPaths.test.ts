import { parseZotFlowStoragePath } from '@/features/chat/linked-content/ZotFlowPaths';

describe('parseZotFlowStoragePath', () => {
  it('reads the storage folder ZotFlow already has configured', () => {
    // Real value from the reference vault's ZotFlow data.json.
    const dataJson = JSON.stringify({
      settings: { useZoteroStorage: true, zoteroStoragePath: 'C:\\Users\\wangh\\Zotero\\storage' },
      viewStates: {},
    });

    expect(parseZotFlowStoragePath(dataJson)).toBe('C:\\Users\\wangh\\Zotero\\storage');
  });

  it('reports nothing rather than an empty path', () => {
    expect(parseZotFlowStoragePath(JSON.stringify({ settings: { zoteroStoragePath: '  ' } })))
      .toBeNull();
    expect(parseZotFlowStoragePath(JSON.stringify({ settings: {} }))).toBeNull();
    expect(parseZotFlowStoragePath(JSON.stringify({}))).toBeNull();
    expect(parseZotFlowStoragePath('not json')).toBeNull();
  });

  it('leaves a storage folder usable as a data directory for the resolver', () => {
    // `resolveZoteroStorageRoot` accepts either shape, which is what lets the
    // ZotFlow value be passed through without rewriting it.
    expect(parseZotFlowStoragePath(JSON.stringify({
      settings: { zoteroStoragePath: 'D:\\Zotero\\storage' },
    }))).toBe('D:\\Zotero\\storage');
  });
});
