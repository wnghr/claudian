/**
 * Note-writing semantics ported from the retired `kb.py` `append` command.
 *
 * The invariants that made the old command trustworthy survive the move:
 *
 * 1. **Never overwrite silently.** Content is appended under a section
 *    heading; frontmatter is round-tripped byte-for-byte, not re-serialized.
 * 2. **Never write the same thing twice.** A normalized-prefix probe against
 *    the note's current text skips an exact re-append unless the caller
 *    explicitly allows duplicates.
 * 3. **Every write is attributable.** A `kb:` timestamp comment marks each
 *    appended block, and the caller is expected to back up the original
 *    before persisting.
 *
 * This module is pure: it maps (current text, incoming content) to (next
 * text, what happened). File access, backup, and target resolution live in
 * the feature layer.
 */

import { splitFrontmatter } from '../text/frontmatter';
import { normalizeForMatch } from '../text/normalize';

/** Section a free-form note lands in when the caller does not pick one. */
export const DEFAULT_APPEND_SECTION = '讨论与理解';

/**
 * Canonical card sections and the shortened headings users actually type.
 * Matching an alias finds the same section the canonical name would.
 */
export const SECTION_ALIASES: Readonly<Record<string, readonly string[]>> = {
  '想弄懂的问题': ['想弄懂的问题', '问题', '阅读目标'],
  '阅读与批注': ['阅读与批注', '批注', '阅读记录'],
  '讨论与理解': ['讨论与理解', '讨论', '理解'],
  '我的想法与未解决问题': ['我的想法与未解决问题', '我的想法', '未解决问题', '想法与问题'],
  '下次从这里继续': ['下次从这里继续', '下次继续', 'next'],
};

export interface PaperNoteWriteRequest {
  /** Vault path, note name, citekey, or wiki-link of the target note. */
  readonly target: string;
  /** Text to append; written verbatim (trimmed) below the section heading. */
  readonly content: string;
  /** Section heading to append under. Defaults to {@link DEFAULT_APPEND_SECTION}. */
  readonly section?: string;
  /** Write even when the content already appears in the note. */
  readonly allowDuplicate?: boolean;
}

export interface PaperNoteWriteResult {
  readonly action: 'appended' | 'duplicate_skipped';
  /** Vault-relative path of the note, with extension. */
  readonly path: string;
  /** Obsidian link to the note, without the `.md` suffix. */
  readonly link: string;
  /** Human-readable statement of where the block landed. */
  readonly location: string;
  /** Other files that also matched the target, when resolution was ambiguous. */
  readonly alternates?: readonly string[];
  /** Absolute path of the pre-write backup, when one could be taken. */
  readonly backupPath?: string;
}

/**
 * The write capability. Implementations resolve the target, back up the
 * original, and persist — this port carries only intent and outcome.
 */
export interface PaperNoteWritePort {
  appendToNote(request: PaperNoteWriteRequest): Promise<PaperNoteWriteResult>;
}

/** Heading form compared across the note: punctuation-free, case-folded. */
export function normalizeHeading(name: string): string {
  return name.replace(/[\s:：、,，.。\-\u2013\u2014_#]+/gu, '').toLowerCase();
}

export interface FoundSection {
  /** Zero-based index of the heading line within the body. */
  readonly startIndex: number;
  /** Zero-based index where an appended block should be inserted. */
  readonly insertIndex: number;
  /** Heading level (`#` count). */
  readonly level: number;
  /** The heading text as written in the note. */
  readonly heading: string;
}

const HEADING_PATTERN = /^(#{1,6})\s+(.*)$/u;

/**
 * Finds the section to append into, mirroring `kb.py`'s three-pass match:
 * exact normalized heading, then a canonical alias, then a substring hit.
 * `insertIndex` backs up over the blank lines before the section's end so the
 * block stays inside the section and the following heading stays separated.
 */
export function findSection(body: string, name: string): FoundSection | null {
  const lines = body.split('\n');
  const wanted = normalizeHeading(name);
  if (!wanted) return null;

  const headings = lines
    .map((line, index) => {
      const match = HEADING_PATTERN.exec(line);
      return match ? { index, level: match[1].length, text: match[2] } : null;
    })
    .filter((entry): entry is { index: number; level: number; text: string } => entry !== null);

  const pick = (candidates: readonly { index: number; level: number; text: string }[]) => {
    if (candidates.length === 0) return null;
    const start = candidates[0];
    let end = lines.length;
    for (const heading of headings) {
      if (heading.index <= start.index) continue;
      if (heading.level <= start.level) {
        end = heading.index;
        break;
      }
    }
    let insertIndex = end;
    while (insertIndex > start.index + 1 && !lines[insertIndex - 1].trim()) insertIndex -= 1;
    return { startIndex: start.index, insertIndex, level: start.level, heading: start.text };
  };

  const exact = pick(headings.filter(entry => normalizeHeading(entry.text) === wanted));
  if (exact) return exact;

  for (const aliases of Object.values(SECTION_ALIASES)) {
    if (!aliases.some(alias => normalizeHeading(alias) === wanted)) continue;
    const aliasHit = pick(
      headings.filter(entry => aliases.some(alias => normalizeHeading(alias) === normalizeHeading(entry.text))),
    );
    if (aliasHit) return aliasHit;
  }

  const partial = pick(headings.filter(entry => normalizeHeading(entry.text).includes(wanted)));
  return partial;
}

/**
 * Duplicate probe: the first 400 normalized characters of the incoming text
 * must not already appear in the note. Short content never self-matches an
 * empty probe, so an empty note does not block the first write.
 */
export function isDuplicateText(original: string, incoming: string): boolean {
  const probe = normalizeForMatch(incoming).slice(0, 400);
  return probe.length > 0 && normalizeForMatch(original).includes(probe);
}

function formatStamp(now: Date): string {
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
  return `<!-- kb:${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())} -->`;
}

export interface AppendOutcome {
  /** The full note text after the operation (unchanged when skipped). */
  readonly text: string;
  readonly action: 'appended' | 'duplicate_skipped';
  readonly location: string;
}

/**
 * Appends a stamped block under `section` in `text`, or reports a duplicate.
 * Frontmatter is carried over untouched; line endings are preserved as-is
 * except that the inserted block uses the document's own dominant style is
 * not detected — the block always uses `\n`, matching every tool that reads
 * these notes.
 */
export function appendToNoteText(
  text: string,
  content: string,
  options: { section: string; now: Date; allowDuplicate?: boolean },
): AppendOutcome {
  const trimmed = content.trim();
  if (!trimmed) throw new Error('没有要写入的内容。');

  if (!options.allowDuplicate && isDuplicateText(text, trimmed)) {
    return { text, action: 'duplicate_skipped', location: '内容已存在，未重复写入' };
  }

  const { rawFrontmatter, body } = splitFrontmatter(text);
  const block = `${formatStamp(options.now)}\n${trimmed}`;
  const sectionHeading = findSection(body, options.section);

  let newBody: string;
  let location: string;
  if (sectionHeading) {
    const lines = body.split('\n');
    const stamped = [...lines.slice(0, sectionHeading.insertIndex), '', block,
      ...lines.slice(sectionHeading.insertIndex)];
    newBody = stamped.join('\n');
    location = `§ ${sectionHeading.heading}（L${sectionHeading.startIndex + 1} 起）`;
  } else {
    const heading = `## ${options.section}`;
    newBody = `${body.replace(/\n+$/u, '')}\n\n${heading}\n\n${block}\n`;
    location = `新建小节 ${heading}`;
  }

  return { text: (rawFrontmatter ?? '') + newBody, action: 'appended', location };
}
