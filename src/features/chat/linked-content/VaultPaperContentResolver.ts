import type { App, TFile } from 'obsidian';
import { TFile as ObsidianFile } from 'obsidian';

import { PaperContentResolver } from './PaperContentResolver';

export function createVaultPaperContentResolver(app: App): PaperContentResolver {
  const getVaultFile = (path: string): TFile => {
    const file = app.vault.getAbstractFileByPath(path);
    if (!(file instanceof ObsidianFile)) {
      throw new Error(`Vault file is unavailable: ${path}`);
    }
    return file;
  };

  return new PaperContentResolver({
    getFile: path => {
      const file = app.vault.getAbstractFileByPath(path);
      return file instanceof ObsidianFile ? file : null;
    },
    getFiles: () => app.vault.getFiles(),
    read: file => app.vault.read(getVaultFile(file.path)),
    readBinary: file => app.vault.readBinary(getVaultFile(file.path)),
  });
}
