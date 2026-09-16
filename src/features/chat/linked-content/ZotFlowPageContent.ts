import type { ZotFlowPageContent } from './ZotFlowLocator';

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join(' ');
  const item = record(value);
  if (!item) return '';
  if (typeof item.text === 'string') return item.text;
  if (typeof item.value === 'string') return item.value;
  if (item.content !== undefined) return text(item.content);
  if (item.children !== undefined) return text(item.children);
  return '';
}

interface PdfChar {
  readonly c?: unknown;
  readonly u?: unknown;
  readonly rect?: unknown;
  readonly baseline?: unknown;
  readonly fontSize?: unknown;
  readonly spaceAfter?: unknown;
  readonly lineBreakAfter?: unknown;
  readonly paragraphBreakAfter?: unknown;
}

function asPdfChars(value: unknown): PdfChar[] {
  const item = record(value);
  if (!item || !Array.isArray(item.chars)) return [];
  return item.chars.filter((char): char is PdfChar => (
    char !== null && typeof char === 'object' && !Array.isArray(char)
  ));
}

/**
 * PDFWorker returns positioned glyphs when SDT preparation is unavailable.
 * Reconstruct a readable fallback from those glyphs instead of treating the
 * page as empty. This is intentionally plain text: the SDT path remains the
 * higher-fidelity renderer when the enhancement pack is healthy.
 */
function renderPdfWorkerChars(value: unknown): string {
  const chars = asPdfChars(value).map((char, index) => {
    const rect = Array.isArray(char.rect)
      ? char.rect.filter((part): part is number => typeof part === 'number')
      : [];
    const x = rect[0] ?? index;
    const y = typeof char.baseline === 'number' ? char.baseline : (rect[1] ?? 0);
    const fontSize = typeof char.fontSize === 'number' && char.fontSize > 0
      ? char.fontSize
      : 10;
    const glyph = typeof char.u === 'string' && char.u.length > 0
      ? char.u
      : typeof char.c === 'string' ? char.c : '';
    return {
      glyph,
      fontSize,
      x,
      y,
      spaceAfter: char.spaceAfter === true,
      lineBreakAfter: char.lineBreakAfter === true,
      paragraphBreakAfter: char.paragraphBreakAfter === true,
    };
  }).filter(char => char.glyph.length > 0);
  if (chars.length === 0) return '';

  const lines: Array<{ y: number; fontSize: number; chars: typeof chars }> = [];
  for (const char of chars) {
    const line = lines.find(candidate => (
      Math.abs(candidate.y - char.y) <= Math.max(1.5, Math.min(candidate.fontSize, char.fontSize) * 0.35)
    ));
    if (line) {
      line.chars.push(char);
      line.y = (line.y * (line.chars.length - 1) + char.y) / line.chars.length;
      line.fontSize = Math.max(line.fontSize, char.fontSize);
    } else {
      lines.push({ y: char.y, fontSize: char.fontSize, chars: [char] });
    }
  }

  return lines
    .sort((left, right) => right.y - left.y)
    .map(line => {
      const ordered = line.chars.sort((left, right) => left.x - right.x);
      let result = '';
      let previousRight: number | null = null;
      for (const char of ordered) {
        const gap = previousRight === null ? 0 : char.x - previousRight;
        if (gap > Math.max(2, char.fontSize * 0.25) && !result.endsWith(' ')) result += ' ';
        result += char.glyph;
        if (char.paragraphBreakAfter) result += '\n\n';
        else if (char.lineBreakAfter) result += '\n';
        else if (char.spaceAfter && !result.endsWith(' ')) result += ' ';
        previousRight = char.x + char.fontSize * 0.55;
      }
      return result.trimEnd();
    })
    .filter(Boolean)
    .join('\n');
}

function renderNode(value: unknown, depth = 0): string[] {
  const item = record(value);
  if (!item) {
    const plain = text(value).trim();
    return plain ? [plain] : [];
  }
  const kind = typeof item.type === 'string' ? item.type : '';
  const body = Array.isArray(item.content) ? item.content : item.content;
  const children = Array.isArray(body) ? body.flatMap(child => renderNode(child, depth + 1)) : [];
  const ownText = text(body).trim();
  if (kind === 'heading') {
    const level = Math.max(1, Math.min(6, Number(item.level) || 2));
    return [`${'#'.repeat(level)} ${ownText || children.join(' ')}`.trim()];
  }
  if (kind === 'list-item' || kind === 'item') {
    return [`${'  '.repeat(Math.max(0, depth - 1))}- ${ownText || children.join(' ')}`.trim()];
  }
  if (kind === 'image' || kind === 'figure' || kind === 'caption') {
    const label = ownText || children.join(' ');
    return [label ? `[Figure/image] ${label}` : '[Figure/image on this page]'];
  }
  if (children.length > 0) return children;
  return ownText ? [ownText] : [];
}

/** Convert ZotFlow's page-level SDT blocks into compact, citable Markdown. */
export function renderZotFlowPage(content: ZotFlowPageContent): string {
  const blocks = content.blocks.flatMap(block => renderNode(block));
  const fallback = (text(content.pageData) || renderPdfWorkerChars(content.pageData)).trim();
  const body = (blocks.length > 0 ? blocks : (fallback ? [fallback] : []))
    .join('\n\n')
    .trim();
  return `<!-- p.${content.pageIndex + 1} -->\n${body || '[No extractable text on this page.]'}`;
}
