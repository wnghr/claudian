import type { PaperLibraryEntry } from '@/core/library/PaperLibrary';
import type { PaperCacheSettingsHost } from '@/shared/settings/PaperCacheSettings';
import { PaperCacheSettings } from '@/shared/settings/PaperCacheSettings';

interface MockElement {
  children: MockElement[];
  cls?: string;
  textContent: string;
  value: string;
  disabled?: boolean;
  events: Map<string, () => void>;
  addEventListener(event: string, listener: () => void): void;
  createDiv(options?: { cls?: string; text?: string }): MockElement;
  createEl(tag: string, options?: { attr?: Record<string, string>; cls?: string; text?: string }): MockElement;
  createSpan(options?: { cls?: string; text?: string }): MockElement;
  empty(): void;
}

function createElement(options?: { cls?: string; text?: string }): MockElement {
  const element: MockElement = {
    children: [],
    cls: options?.cls,
    textContent: options?.text ?? '',
    value: '',
    events: new Map(),
    addEventListener(event, listener) {
      this.events.set(event, listener);
    },
    createDiv(childOptions) {
      const child = createElement(childOptions);
      this.children.push(child);
      return child;
    },
    createEl(_tag, childOptions) {
      const child = createElement(childOptions);
      this.children.push(child);
      return child;
    },
    createSpan(childOptions) {
      const child = createElement(childOptions);
      this.children.push(child);
      return child;
    },
    empty() {
      this.children.length = 0;
    },
  };
  return element;
}

jest.mock('obsidian', () => ({
  Notice: jest.fn(),
  setIcon: jest.fn(),
}));

function paper(overrides: Partial<PaperLibraryEntry> = {}): PaperLibraryEntry {
  return {
    citekey: 'paper-2026',
    title: 'Paper 2026',
    year: 2026,
    domain: null,
    subfield: null,
    status: null,
    cardPath: null,
    pdfPath: '论文/PDF/paper-2026.pdf',
    pages: 9,
    cache: 'ready',
    parsedAt: '2026-09-14T00:00:00.000Z',
    ...overrides,
  };
}

function flatten(element: MockElement): string {
  return [element.textContent, ...element.children.map(flatten)].join(' ');
}

function findByClass(element: MockElement, className: string): MockElement | undefined {
  if (element.cls?.split(/\s+/).includes(className)) return element;
  for (const child of element.children) {
    const match = findByClass(child, className);
    if (match) return match;
  }
  return undefined;
}

describe('PaperCacheSettings', () => {
  it('lists cache states and rebuilds one selected paper', async () => {
    const host: jest.Mocked<PaperCacheSettingsHost> = {
      listPapers: jest.fn().mockResolvedValue([
        paper(),
        paper({ citekey: 'stale-2026', title: 'Stale Paper', cache: 'stale' }),
        paper({ citekey: 'missing-2026', title: 'Missing Paper', cache: 'missing' }),
      ]),
      rebuildPaperCache: jest.fn().mockResolvedValue(undefined),
    };
    const root = createElement();
    const settings = new PaperCacheSettings(root as unknown as HTMLElement, host, {} as never);

    await settings.refresh();

    expect(flatten(root)).toContain('3 papers');
    expect(flatten(root)).toContain('1 ready');
    expect(flatten(root)).toContain('Stale Paper');
    expect(flatten(root)).toContain('Missing Paper');

    const rebuild = findByClass(root, 'claudian-paper-cache-rebuild-button');
    expect(rebuild).toBeDefined();
    rebuild!.events.get('click')!();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(host.rebuildPaperCache).toHaveBeenCalledWith('论文/PDF/paper-2026.pdf');
  });
});
