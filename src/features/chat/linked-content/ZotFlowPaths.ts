import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { App, DataAdapter } from 'obsidian';

/**
 * ZotFlow keeps two things Claudian needs in its own plugin `data.json`: the
 * reader's view state, which is the only place a "current page" can be read
 * from without loading the reader, and the Zotero storage path, which ZotFlow
 * already maintains. Reading another plugin's data file is a deliberate,
 * read-only coupling - it keeps the storage location configured in one place.
 */
export const ZOTFLOW_PLUGIN_ID = 'zotflow';

interface DesktopDataAdapter extends DataAdapter {
  getBasePath(): string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function resolveZotFlowDataFilePath(app: App): string | null {
  const adapter = app.vault.adapter as Partial<DesktopDataAdapter>;
  if (typeof adapter.getBasePath !== 'function') return null;
  const basePath = adapter.getBasePath().trim();
  if (!basePath) return null;
  return path.resolve(basePath, app.vault.configDir, 'plugins', ZOTFLOW_PLUGIN_ID, 'data.json');
}

/** `settings.zoteroStoragePath` from ZotFlow's `data.json`. */
export function parseZotFlowStoragePath(dataJson: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(dataJson) as unknown;
  } catch {
    return null;
  }
  const value = asRecord(asRecord(parsed)?.settings)?.zoteroStoragePath;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * ZotFlow's configured Zotero storage folder, so the plugin does not have to ask
 * the user for a path the ZotFlow settings already hold.
 */
export async function readZotFlowStoragePath(app: App): Promise<string | null> {
  const file = resolveZotFlowDataFilePath(app);
  if (!file) return null;
  try {
    return parseZotFlowStoragePath(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}
