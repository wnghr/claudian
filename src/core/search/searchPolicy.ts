import { splitFrontmatter } from './chunking';

export interface SearchDocumentDecision {
  readonly searchable: boolean;
  readonly reason: string | null;
}

function normalizeTag(value: string): string {
  return value.trim().replace(/^#/u, '').toLocaleLowerCase();
}

function scalarBoolean(value: string | readonly string[] | undefined): boolean | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLocaleLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return null;
}

function hasTag(
  frontmatter: Readonly<Record<string, string | readonly string[]>>,
  expected: string,
): boolean {
  const value = frontmatter.tags;
  const tags: readonly string[] = Array.isArray(value)
    ? value
    : typeof value === 'string' ? [value] : [];
  return tags.some(tag => normalizeTag(tag) === expected);
}

/** Decide whether an Obsidian Markdown document belongs in answer-oriented search. */
export function decideSearchDocument(path: string, text: string): SearchDocumentDecision {
  const { frontmatter } = splitFrontmatter(text);
  const explicit = scalarBoolean(frontmatter.searchable);
  if (explicit === false) return { searchable: false, reason: 'searchable:false' };
  if (explicit === true) return { searchable: true, reason: null };

  const normalized = path.replace(/\\/gu, '/').replace(/^\/+|\/+$/gu, '');
  const fileName = normalized.split('/').pop() ?? normalized;
  if (normalized.split('/').slice(0, -1).includes('00-入口')) {
    return { searchable: false, reason: 'entry directory' };
  }
  if (fileName.toLocaleLowerCase() === '_index.md') {
    return { searchable: false, reason: 'index page' };
  }
  if (hasTag(frontmatter, 'type/入口')) {
    return { searchable: false, reason: 'entry tag' };
  }
  if (hasTag(frontmatter, 'type/index')) {
    return { searchable: false, reason: 'index tag' };
  }
  if (fileName === '学习主页.md' && hasTag(frontmatter, 'type/learning-topic')) {
    return { searchable: false, reason: 'learning dashboard' };
  }
  return { searchable: true, reason: null };
}
