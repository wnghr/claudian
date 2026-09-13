/**
 * Frontmatter field-editing semantics ported from the retired `kb.py`
 * `status` and `classify` commands.
 *
 * The invariants that made the old commands trustworthy survive the move:
 *
 * 1. **Whitelist only.** Exactly three fields are writable — `status`,
 *    `domain`, `subfield` — and each carries the old command's validation
 *    (status enum; Chinese noun phrases without `/ # [ ]`).
 * 2. **Never re-serialize the note.** The raw frontmatter block is edited
 *    line-by-line and round-tripped byte-for-byte; only the lines whose value
 *    actually changes are rewritten, and missing keys are appended before the
 *    closing fence.
 * 3. **Honest no-ops.** A write whose values are already in place changes
 *    nothing and says so, instead of touching the file to appear busy.
 *
 * This module is pure: it maps (current text, field updates) to (next text,
 * what changed). Target resolution, backup, and persistence live in the
 * feature layer.
 */

import { splitFrontmatter } from '../text/frontmatter';

/** The reading-status vocabulary `kb.py status` enforced. */
export const PAPER_STATUS_VALUES = ['unread', 'reading', 'read', 'cited'] as const;

export type PaperStatus = (typeof PAPER_STATUS_VALUES)[number];

export interface PaperFieldUpdate {
  readonly key: string;
  readonly value: string;
}

export interface PaperFieldEditRequest {
  /** Vault path, card name, citekey, or wiki-link of the target card. */
  readonly target: string;
  readonly status?: string;
  readonly domain?: string;
  readonly subfield?: string;
}

/** One key whose value this call rewrote; `from` is null when the key was absent. */
export interface PaperFieldChange {
  readonly key: string;
  readonly from: string | null;
  readonly to: string;
}

export interface PaperFieldEditResult {
  readonly action: 'updated' | 'unchanged';
  /** Vault-relative path of the card, with extension. */
  readonly path: string;
  /** Obsidian link to the card, without the `.md` suffix. */
  readonly link: string;
  readonly changed: readonly PaperFieldChange[];
  /** Fields the request asked for that already held the target value. */
  readonly unchanged: readonly string[];
  /** Other files that also matched the target, when resolution was ambiguous. */
  readonly alternates?: readonly string[];
  /** Absolute path of the pre-write backup, when one could be taken. */
  readonly backupPath?: string;
}

/**
 * The field-edit capability. Implementations resolve the target, back up the
 * original, and persist — this port carries only intent and outcome.
 */
export interface PaperFieldEditPort {
  setPaperFields(request: PaperFieldEditRequest): Promise<PaperFieldEditResult>;
}

/**
 * Validates one requested field value against the old commands' rules.
 * Returns the normalized value, or an error message in the old CLI's wording.
 */
export function validatePaperFieldValue(key: string, value: string): { value: string } | { error: string } {
  const trimmed = value.trim();
  if (!trimmed) return { error: `${key} 不能为空` };
  if (/[\r\n]/u.test(trimmed)) return { error: `${key} 必须是单行文本` };
  if (key === 'status') {
    const normalized = trimmed.toLowerCase();
    if (!(PAPER_STATUS_VALUES as readonly string[]).includes(normalized)) {
      return { error: `status 只能是 ${PAPER_STATUS_VALUES.join(', ')}` };
    }
    return { value: normalized };
  }
  if (/[#[\]]/u.test(trimmed) || trimmed.includes('/')) {
    return { error: '分类值使用中文名词短语，不要包含 /、# 或方括号' };
  }
  return { value: trimmed };
}

/** Whitelisted fields, in the order the old `classify` command wrote them. */
const WRITABLE_FIELD_KEYS = ['status', 'domain', 'subfield'] as const;

/**
 * Converts a request into concrete updates, applying the same validation the
 * tool layer already ran. Throws on an invalid value — a defensive second
 * gate so a port can never receive a value the old CLI would have rejected.
 */
export function paperFieldUpdates(request: PaperFieldEditRequest): readonly PaperFieldUpdate[] {
  const updates: PaperFieldUpdate[] = [];
  for (const key of WRITABLE_FIELD_KEYS) {
    const raw = request[key];
    if (raw === undefined) continue;
    const checked = validatePaperFieldValue(key, raw);
    if ('error' in checked) throw new Error(checked.error);
    updates.push({ key, value: checked.value });
  }
  return updates;
}

/** Quotes a value for frontmatter when a bare scalar would be ambiguous YAML. */
function formatFieldValue(value: string): string {
  return /^[A-Za-z0-9\u3400-\u4dbf\u4e00-\u9fff][A-Za-z0-9\u3400-\u4dbf\u4e00-\u9fff_ .-]*$/u.test(value)
    ? value
    : JSON.stringify(value);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

export interface FrontmatterFieldEditOutcome {
  readonly text: string;
  readonly changed: readonly PaperFieldChange[];
  readonly unchanged: readonly string[];
}

const FRONTMATTER_BLOCK_PATTERN = /(^---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n)?)/u;

/**
 * Rewrites `updates` into the note's frontmatter, mirroring `kb.py`'s
 * `set_fm_field`: an existing top-level `key:` line is replaced in place,
 * a missing key is appended before the closing fence, and a note without
 * frontmatter gains a fresh block. Only lines whose parsed value differs are
 * rewritten, so the outcome reports honest changes and honest no-ops.
 */
export function editFrontmatterFields(
  text: string,
  updates: readonly PaperFieldUpdate[],
): FrontmatterFieldEditOutcome {
  if (updates.length === 0) return { text, changed: [], unchanged: [] };

  const { frontmatter, rawFrontmatter } = splitFrontmatter(text);
  const changed: PaperFieldChange[] = [];
  const unchanged: string[] = [];
  const effective: PaperFieldUpdate[] = [];

  for (const update of updates) {
    const current = frontmatter[update.key];
    if (typeof current === 'string' && current === update.value) {
      unchanged.push(update.key);
      continue;
    }
    changed.push({
      key: update.key,
      from: typeof current === 'string' ? current : current === undefined ? null : '（列表值）',
      to: update.value,
    });
    effective.push(update);
  }

  if (effective.length === 0) return { text, changed, unchanged };

  if (rawFrontmatter === null) {
    const block = `---\n${effective.map(update => `${update.key}: ${formatFieldValue(update.value)}`).join('\n')}\n---\n\n`;
    return { text: block + text, changed, unchanged };
  }

  const block = FRONTMATTER_BLOCK_PATTERN.exec(rawFrontmatter);
  if (!block) {
    // Defensive: an unparsable raw block is prepended a fresh one rather than
    // being edited in place — the same fallback the old command chose.
    const prepended = `---\n${effective.map(update => `${update.key}: ${formatFieldValue(update.value)}`).join('\n')}\n---\n\n`;
    return { text: prepended + text, changed, unchanged };
  }

  const [, opening, inner, closing] = block;
  const eol = /\r\n/u.test(rawFrontmatter) ? '\r\n' : '\n';
  const lines = inner.split('\n');
  const appended: string[] = [];

  for (const update of effective) {
    const keyLine = new RegExp(`^${escapeRegExp(update.key)}\\s*:`);
    const index = lines.findIndex(line => keyLine.test(line));
    if (index >= 0) {
      const original = lines[index];
      const hadCarriageReturn = original.endsWith('\r');
      const inlineEmpty = /^\s*$/u.test(original.slice(original.indexOf(':') + 1).replace(/\r$/u, ''));
      let replacement = `${update.key}: ${formatFieldValue(update.value)}`;
      if (hadCarriageReturn) replacement += '\r';
      // Overwriting an empty-valued key that opened a block list must take the
      // list items with it, or they would dangle under the new scalar.
      if (inlineEmpty) {
        let end = index + 1;
        while (end < lines.length && /^\s+-\s/u.test(lines[end])) end += 1;
        lines.splice(index, end - index, replacement);
      } else {
        lines[index] = replacement;
      }
    } else {
      appended.push(`${update.key}: ${formatFieldValue(update.value)}`);
    }
  }

  // The last line of the block never carries its own terminator (the closing
  // fence owns it), so appended keys must re-attach it with the document's
  // own line ending instead of relying on the `\n` join above.
  const edited = lines.join('\n')
    + (appended.length > 0 ? eol + appended.join(eol) : '');

  return { text: opening + edited + closing + text.slice(block[0].length), changed, unchanged };
}
