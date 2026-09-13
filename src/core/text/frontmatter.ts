/**
 * Tolerant frontmatter reading shared by the search index and the note writer.
 *
 * This is deliberately not a YAML parser: both callers need a handful of
 * scalar and list values, and a real parser would reject the loose frontmatter
 * that handwritten notes contain.
 */

export interface SplitMarkdown {
  readonly frontmatter: Readonly<Record<string, string | readonly string[]>>;
  readonly body: string;
  /**
   * Raw text of the frontmatter block including its `---` fences, i.e. the
   * exact prefix of the document before `body`. Null when the document has no
   * frontmatter. Round-tripping a note requires this: re-serializing the
   * parsed record would rewrite fields the writer never touched.
   */
  readonly rawFrontmatter: string | null;
}

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/u;

function stripScalarQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/** Splits frontmatter from the body; an unmarked document is all body. */
export function splitFrontmatter(text: string): SplitMarkdown {
  const match = FRONTMATTER_PATTERN.exec(text);
  if (!match) return { body: text, frontmatter: {}, rawFrontmatter: null };

  const rawFrontmatter = text.slice(0, match[0].length);
  const data: Record<string, string | string[]> = {};
  let currentKey: string | null = null;
  for (const line of match[1].split(/\r?\n/u)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;

    const listItem = /^\s+-\s+(.*)$/u.exec(line);
    if (listItem && currentKey) {
      const existing = data[currentKey];
      const items = Array.isArray(existing)
        ? existing
        : typeof existing === 'string' && existing.length > 0
          ? [existing]
          : [];
      items.push(stripScalarQuotes(listItem[1].trim()));
      data[currentKey] = items;
      continue;
    }

    const entry = /^([A-Za-z0-9_\-.]*)\s*:\s*(.*)$/u.exec(line);
    if (!entry) continue;
    currentKey = entry[1];
    const rawValue = entry[2].trim();
    if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
      const inner = rawValue.slice(1, -1).trim();
      data[currentKey] = inner.length === 0
        ? []
        : inner.split(',').map(item => stripScalarQuotes(item.trim())).filter(Boolean);
    } else {
      data[currentKey] = stripScalarQuotes(rawValue);
    }
  }

  return { body: text.slice(match[0].length), frontmatter: data, rawFrontmatter };
}
