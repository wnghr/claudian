import type { PaperAuthor, PaperCitation } from './PaperLibrary';

/**
 * Reference formatting lives in core (not in the vault adapter) so the exact
 * output can be unit-tested without an Obsidian host.
 */

function initials(given: string): string {
  return given
    .split(/[\s.-]+/u)
    .filter(part => part.length > 0)
    .map(part => `${part.charAt(0).toLocaleUpperCase()}.`)
    .join(' ');
}

function formatAuthor(author: PaperAuthor): string {
  if (!author.family) return author.given;
  return author.given ? `${author.family}, ${initials(author.given)}` : author.family;
}

export function formatAuthorList(authors: readonly PaperAuthor[]): string {
  const names = authors.map(formatAuthor).filter(name => name.length > 0);
  if (names.length === 0) return '';
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} & ${names[1]}`;
  return `${names[0]} et al.`;
}

export function formatPaperReference(citation: PaperCitation): string {
  const segments: string[] = [];

  const authors = formatAuthorList(citation.authors);
  if (authors) segments.push(authors);
  if (citation.year !== null) segments.push(`(${citation.year}).`);
  if (citation.title) segments.push(`${citation.title}.`);

  const source: string[] = [];
  if (citation.venue) source.push(citation.venue);
  if (citation.volume) {
    source.push(`${citation.volume}${citation.issue ? `(${citation.issue})` : ''}`);
  } else if (citation.issue) {
    source.push(`(${citation.issue})`);
  }
  if (citation.pages) source.push(citation.pages);
  if (source.length > 0) segments.push(`${source.join(', ')}.`);

  if (citation.doi) segments.push(`https://doi.org/${citation.doi}`);
  else if (citation.url) segments.push(citation.url);

  return segments.join(' ').trim();
}
