/**
 * Tokenizer for the hybrid paper search index.
 *
 * Ported from the retired `kb.py` engine so ranking behaviour is unchanged:
 * NFKC normalization, lowercasing, ASCII word tokens (length >= 2, stop words
 * dropped), and for CJK runs both single characters and overlapping bigrams,
 * because CJK text has no word delimiters to rely on.
 */

import { normalizeForMatch } from '../text/normalize';

export { normalizeForMatch };

const TOKEN_PATTERN =
  /[a-z0-9][a-z0-9\-_.]*|[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+/gu;

const ASCII_ONLY = /^[\x20-\x7e]*$/u;

const EN_STOP_WORDS: ReadonlySet<string> = new Set([
  'the', 'a', 'an', 'of', 'and', 'or', 'to', 'in', 'on', 'at', 'for', 'with',
  'by', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'it', 'its',
  'this', 'that', 'these', 'those', 'from', 'we', 'our', 'they', 'their',
  'et', 'al', 'can', 'has', 'have', 'had', 'not', 'but', 'if', 'then', 'than',
  'which', 'what', 'when', 'how', 'all', 'also', 'more', 'most', 'such', 'use',
  'used', 'using', 'into', 'over', 'under', 'between', 'may', 'might', 'will',
]);

const CJK_STOP_CHARS: ReadonlySet<string> = new Set([
  ...'的了是和在与有我不就都而及其这那也为对以到上下中会要可被把让从很更还只',
]);

export const MIN_ASCII_TOKEN_LENGTH = 2;

export function tokenize(text: string): string[] {
  const normalized = text.normalize('NFKC').toLowerCase();
  const tokens: string[] = [];
  const matches = normalized.matchAll(TOKEN_PATTERN);
  for (const match of matches) {
    const token = match[0];
    if (ASCII_ONLY.test(token)) {
      if (token.length >= MIN_ASCII_TOKEN_LENGTH && !EN_STOP_WORDS.has(token)) {
        tokens.push(token);
      }
      continue;
    }
    for (const char of token) {
      if (!CJK_STOP_CHARS.has(char)) tokens.push(char);
    }
    for (let index = 0; index < token.length - 1; index += 1) {
      tokens.push(token.slice(index, index + 2));
    }
  }
  return tokens;
}

