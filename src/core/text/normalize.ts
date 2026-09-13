/**
 * Whitespace-collapsed, case-folded text form shared by the search ranking
 * and the note writer's duplicate detection.
 */

/** Whitespace-collapsed, case-folded form used for literal substring checks. */
export function normalizeForMatch(text: string): string {
  return text.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase();
}
