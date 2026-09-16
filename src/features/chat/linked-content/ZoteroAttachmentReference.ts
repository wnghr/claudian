const ZOTERO_ATTACHMENT_REFERENCE_PREFIX = 'zotero/';
const ZOTERO_ATTACHMENT_KEY = /^[A-Z0-9]{8}$/u;

export function createZoteroAttachmentReference(attachmentKey: string): string | null {
  const normalizedKey = attachmentKey.trim().toLocaleUpperCase();
  return ZOTERO_ATTACHMENT_KEY.test(normalizedKey)
    ? `${ZOTERO_ATTACHMENT_REFERENCE_PREFIX}${normalizedKey}.pdf`
    : null;
}

export function parseZoteroAttachmentReference(path: string): string | null {
  const match = path.match(/^zotero\/([A-Z0-9]{8})\.pdf$/iu);
  return match ? match[1].toLocaleUpperCase() : null;
}

export function isZoteroAttachmentReference(path: string): boolean {
  return parseZoteroAttachmentReference(path) !== null;
}
