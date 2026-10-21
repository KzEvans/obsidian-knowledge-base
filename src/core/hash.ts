import { createHash } from 'node:crypto';

const CHUNK = 4 * 1024 * 1024;

/** Hash in 4 MB slices, yielding between them, so a large PDF never holds the UI thread for long. */
export async function sha256Bytes(bytes: ArrayBuffer | Uint8Array, yieldToUi: () => Promise<void> = nextTask): Promise<string> {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const hash = createHash('sha256');
  for (let offset = 0; offset < view.byteLength; offset += CHUNK) {
    hash.update(view.subarray(offset, offset + CHUNK));
    if (offset + CHUNK < view.byteLength) await yieldToUi();
  }
  return hash.digest('hex');
}

export function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Source text identity for translations (docs/contracts.md §3). Markup and TeX are kept verbatim. */
export function segmentHash(text: string): string {
  return sha256Text(normalizeSegmentText(text));
}

export function normalizeSegmentText(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

export function nextTask(): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, 0));
}
