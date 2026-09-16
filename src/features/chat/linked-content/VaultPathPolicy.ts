import type { App } from 'obsidian';

/** Shared vault path policy for paper readers and note writers. */
export function buildSkipDirectoryParts(app: App): ReadonlySet<string> {
  const parts = new Set<string>([
    '.git', '.trash', '.claudian', '.agents', '.claude',
    '.workbuddy', 'node_modules', '__pycache__', 'Templates', 'Images',
  ]);
  const configDirectory = (app.vault as { configDir?: unknown }).configDir;
  if (typeof configDirectory === 'string' && configDirectory.length > 0) {
    const name = configDirectory.split('/').filter(Boolean).pop();
    if (name) parts.add(name);
  }
  return parts;
}

export const SKIP_NAME_PREFIXES: readonly string[] = ['~$', '.'];
