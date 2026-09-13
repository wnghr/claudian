export interface PaperReadRequest {
  readonly sourcePath: string;
  readonly pages?: string;
  readonly section?: string;
  readonly query?: string;
  readonly maxChars?: number;
}

export interface PaperReadResult {
  readonly sourcePath: string;
  readonly cachePath: string;
  readonly content: string;
  readonly selection: string;
  readonly truncated: boolean;
}

export interface PaperReadPort {
  readPaper(request: PaperReadRequest): Promise<PaperReadResult>;
}
