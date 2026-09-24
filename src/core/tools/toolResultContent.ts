import { buildImageAttachmentFromBase64, parseImageDataUri } from '../../utils/imageAttachment';
import type { ImageAttachment } from '../types';

export interface ToolResultContentOptions {
  fallbackIndent?: number;
}

/** Extracts inline MCP image blocks without attempting to fetch remote URLs. */
export function extractToolResultImages(content: unknown, idPrefix: string): ImageAttachment[] {
  if (!Array.isArray(content)) return [];

  const images: ImageAttachment[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
    const record = block as Record<string, unknown>;
    if (record.type !== 'image') continue;

    const source = record.source && typeof record.source === 'object' && !Array.isArray(record.source)
      ? record.source as Record<string, unknown>
      : undefined;
    const rawData = typeof source?.data === 'string'
      ? source.data
      : typeof record.data === 'string' ? record.data : '';
    if (!rawData) continue;

    const parsedDataUri = parseImageDataUri(rawData);
    const mediaType = parsedDataUri?.mediaType
      ?? (typeof source?.media_type === 'string' ? source.media_type : undefined)
      ?? (typeof record.mimeType === 'string' ? record.mimeType : undefined)
      ?? (typeof record.media_type === 'string' ? record.media_type : undefined);
    const image = buildImageAttachmentFromBase64({
      data: parsedDataUri?.data ?? rawData,
      id: `${idPrefix}-image-${images.length}`,
      mediaType: mediaType ?? '',
      name: `tool-image-${images.length + 1}`,
      source: 'tool',
    });
    if (image) images.push(image);
  }

  return images;
}

export function extractToolResultContent(
  content: unknown,
  options?: ToolResultContentOptions,
): string {
  if (typeof content === 'string') return content;
  if (content == null) return '';

  if (Array.isArray(content)) {
    const textParts = content.filter(isTextBlock).map((block) => block.text);
    if (textParts.length > 0) return textParts.join('\n');
    if (content.length > 0) return JSON.stringify(content, null, options?.fallbackIndent);
    return '';
  }

  return JSON.stringify(content, null, options?.fallbackIndent);
}

function isTextBlock(block: unknown): block is { type: 'text'; text: string } {
  if (!block || typeof block !== 'object') return false;
  const record = block as Record<string, unknown>;
  return record.type === 'text' && typeof record.text === 'string';
}
