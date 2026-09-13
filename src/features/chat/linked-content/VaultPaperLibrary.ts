import type { App, TFile } from 'obsidian';
import { TFile as ObsidianFile } from 'obsidian';

import type {
  PaperAuthor,
  PaperCacheStatus,
  PaperCitation,
  PaperLibraryEntry,
  PaperLibraryPort,
  PaperLibraryQuery,
} from '../../../core/library/PaperLibrary';

const CARDS_ROOT = '论文/卡片/';
const PARSED_ROOT = '论文/MD/';
const PDF_ROOT = '论文/PDF/';
const BIBLIOGRAPHY_INDEX = '论文/索引/bibliography.json';
const MAX_REPORTED_CITEKEYS = 25;

interface ParsedManifest {
  readonly sourcePdf: string | null;
  readonly pages: number | null;
  readonly parsedAt: string | null;
  readonly status: string | null;
}

interface ScannedCard {
  readonly path: string;
  readonly frontmatter: Readonly<Record<string, unknown>>;
}

function normalizePath(path: string): string {
  return path.replace(/\\/gu, '/').replace(/^\/+|\/+$/gu, '');
}

function asVaultFile(app: App, path: string): TFile | null {
  const file = app.vault.getAbstractFileByPath(path);
  return file instanceof ObsidianFile ? file : null;
}

function readText(record: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = record[key];
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function readYear(record: Readonly<Record<string, unknown>>): number | null {
  const direct = readText(record, 'year');
  if (direct) {
    const parsed = Number.parseInt(direct, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  const issued = record.issued;
  if (!issued || typeof issued !== 'object' || Array.isArray(issued)) return null;
  const dateParts = (issued as Record<string, unknown>)['date-parts'];
  if (!Array.isArray(dateParts) || !Array.isArray(dateParts[0])) return null;
  const year = dateParts[0][0];
  return typeof year === 'number' && Number.isFinite(year) ? year : null;
}

function readAuthors(record: Readonly<Record<string, unknown>>): PaperAuthor[] {
  const value = record.author;
  if (!Array.isArray(value)) return [];
  const authors: PaperAuthor[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') {
      const literal = entry.trim();
      if (literal) authors.push({ family: literal, given: '' });
      continue;
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const author = entry as Record<string, unknown>;
    const family = readText(author, 'family') ?? '';
    const given = readText(author, 'given') ?? '';
    if (family || given) authors.push({ family, given });
  }
  return authors;
}

function readWikilink(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = value.match(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/u);
  return match ? normalizePath(match[1]) : null;
}

function readWikilinkTarget(value: unknown): string | null {
  if (!Array.isArray(value)) return readWikilink(value);
  for (const entry of value) {
    const path = readWikilink(entry);
    if (path) return path;
  }
  return null;
}

function readFrontmatter(app: App, file: TFile): Readonly<Record<string, unknown>> {
  const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter;
  return frontmatter ? { ...frontmatter } : {};
}

async function readJsonRecord(
  app: App,
  file: TFile,
): Promise<Readonly<Record<string, unknown>> | null> {
  try {
    const parsed: unknown = JSON.parse(await app.vault.read(file));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readPageCount(manifest: Readonly<Record<string, unknown>>): number | null {
  const pageMap = manifest.page_map;
  if (!pageMap || typeof pageMap !== 'object' || Array.isArray(pageMap)) return null;
  const pages = (pageMap as Record<string, unknown>).pages;
  return typeof pages === 'number' && Number.isFinite(pages) ? pages : null;
}

function scanCards(app: App): Map<string, ScannedCard> {
  const cards = new Map<string, ScannedCard>();
  for (const file of app.vault.getFiles()) {
    const path = normalizePath(file.path);
    if (!path.startsWith(CARDS_ROOT) || !path.endsWith('.md')) continue;
    const frontmatter = readFrontmatter(app, file);
    const stem = path.slice(CARDS_ROOT.length, path.length - '.md'.length);
    const citekey = readText(frontmatter, 'id')
      ?? pdfStem(readWikilinkTarget(frontmatter.attachment))
      ?? stem;
    cards.set(citekey, { path, frontmatter });
  }
  return cards;
}

function pdfStem(path: string | null): string | null {
  if (!path) return null;
  const name = path.split('/').pop() ?? '';
  return name.toLocaleLowerCase().endsWith('.pdf') ? name.slice(0, -'.pdf'.length) : null;
}

async function scanManifests(app: App): Promise<Map<string, ParsedManifest>> {
  const manifests = new Map<string, ParsedManifest>();
  for (const file of app.vault.getFiles()) {
    const path = normalizePath(file.path);
    if (!path.startsWith(PARSED_ROOT) || !path.endsWith('/manifest.json')) continue;
    const data = await readJsonRecord(app, file);
    if (!data) continue;
    const citekey = readText(data, 'citekey')
      ?? path.slice(PARSED_ROOT.length).split('/')[0];
    manifests.set(citekey, {
      sourcePdf: readText(data, 'source_pdf'),
      pages: readPageCount(data),
      parsedAt: readText(data, 'parsed_at'),
      status: readText(data, 'status'),
    });
  }
  return manifests;
}

/**
 * Cheap freshness check for a listing. The PDF is only hashed when it is
 * actually read, so `browse` stays fast across a large library.
 */
function resolveCacheStatus(
  manifest: ParsedManifest | undefined,
  pdf: TFile | null,
): PaperCacheStatus {
  if (!manifest) return 'missing';
  if ((manifest.status ?? '').toLocaleLowerCase() !== 'success') return 'missing';
  if (!pdf) return 'missing';
  const parsedAt = manifest.parsedAt ? Date.parse(manifest.parsedAt) : Number.NaN;
  if (!Number.isFinite(parsedAt)) return 'ready';
  return pdf.stat.mtime > parsedAt ? 'stale' : 'ready';
}

function matchesQuery(entry: PaperLibraryEntry, query: PaperLibraryQuery): boolean {
  const status = query.status?.toLocaleLowerCase();
  if (status && (entry.status ?? '').toLocaleLowerCase() !== status) return false;

  const needle = query.query?.toLocaleLowerCase();
  if (!needle) return true;
  return [entry.citekey, entry.title, entry.domain, entry.subfield]
    .some(value => value !== null && value.toLocaleLowerCase().includes(needle));
}

async function readBibliographyIndex(app: App): Promise<readonly Record<string, unknown>[]> {
  const file = asVaultFile(app, BIBLIOGRAPHY_INDEX);
  if (!file) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(await app.vault.read(file));
  } catch {
    throw new Error(`${BIBLIOGRAPHY_INDEX} is not valid JSON.`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${BIBLIOGRAPHY_INDEX} must contain a JSON array of citation entries.`);
  }
  return parsed.filter(
    (entry): entry is Record<string, unknown> => (
      typeof entry === 'object' && entry !== null && !Array.isArray(entry)
    ),
  );
}

function readField(entry: Readonly<Record<string, unknown>>, key: string): string | null {
  return readText(entry, key)?.toLocaleLowerCase() ?? null;
}

function toCitation(entry: Readonly<Record<string, unknown>>, fallbackCitekey: string): PaperCitation {
  return {
    citekey: readText(entry, 'id') ?? fallbackCitekey,
    title: readText(entry, 'title') ?? '',
    authors: readAuthors(entry),
    year: readYear(entry),
    venue: readText(entry, 'container-title'),
    volume: readText(entry, 'volume'),
    issue: readText(entry, 'number'),
    pages: readText(entry, 'page'),
    doi: readText(entry, 'DOI'),
    url: readText(entry, 'URL'),
  };
}

export function createVaultPaperLibrary(app: App): PaperLibraryPort {
  return {
    async listPapers(query: PaperLibraryQuery = {}): Promise<readonly PaperLibraryEntry[]> {
      const cards = scanCards(app);
      const manifests = await scanManifests(app);
      const citekeys = [...new Set([...cards.keys(), ...manifests.keys()])].sort();

      const entries = citekeys.map((citekey): PaperLibraryEntry => {
        const card = cards.get(citekey);
        const manifest = manifests.get(citekey);
        const frontmatter = card?.frontmatter ?? {};
        const pdfPath = manifest?.sourcePdf
          ?? readWikilinkTarget(frontmatter.attachment)
          ?? (asVaultFile(app, `${PDF_ROOT}${citekey}.pdf`) ? `${PDF_ROOT}${citekey}.pdf` : null);
        const pdf = pdfPath ? asVaultFile(app, pdfPath) : null;
        return {
          citekey,
          // A parsed paper without a card is still listed; the citekey stands in
          // for the missing title so the entry is never silently dropped.
          title: readText(frontmatter, 'title') ?? pdfStem(pdfPath) ?? citekey,
          year: readYear(frontmatter),
          domain: readText(frontmatter, 'domain'),
          subfield: readText(frontmatter, 'subfield'),
          status: readText(frontmatter, 'status'),
          cardPath: card?.path ?? null,
          pdfPath,
          pages: manifest?.pages ?? null,
          cache: resolveCacheStatus(manifest, pdf),
          parsedAt: manifest?.parsedAt ?? null,
        };
      });

      return entries.filter(entry => matchesQuery(entry, query));
    },

    async citePaper(citekey: string): Promise<PaperCitation> {
      const entries = await readBibliographyIndex(app);
      const wanted = citekey.trim().toLocaleLowerCase();
      const entry = entries.find(candidate => readField(candidate, 'id') === wanted)
        ?? entries.find(candidate => readField(candidate, 'DOI') === wanted);
      if (!entry) {
        const known = entries
          .map(candidate => readText(candidate, 'id'))
          .filter((id): id is string => id !== null);
        const suffix = known.length > MAX_REPORTED_CITEKEYS ? ', …' : '';
        throw new Error(
          `No bibliography entry matches "${citekey}". `
          + (known.length > 0
            ? `Known citekeys: ${known.slice(0, MAX_REPORTED_CITEKEYS).join(', ')}${suffix}.`
            : `The bibliography index (${BIBLIOGRAPHY_INDEX}) has no entries.`),
        );
      }
      return toCitation(entry, citekey);
    },
  };
}
