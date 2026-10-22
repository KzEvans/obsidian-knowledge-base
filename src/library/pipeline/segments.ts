import { normalizeSegmentText } from '../../core/hash';
import type { StoredDocument } from '../../core/types';

/** Every distinct translatable source text of a document, keyed by its sourceHash (contracts §3). */
export function documentSegments(document: StoredDocument): Map<string, string> {
  const segments = new Map<string, string>();
  for (const block of document.blocks) {
    for (const segment of block.segments ?? []) {
      const text = segment.field === 'text' ? block.text
        : segment.field === 'caption' ? block.captions?.[segment.index]
          : block.footnotes?.[segment.index];
      if (text && !segments.has(segment.sourceHash)) segments.set(segment.sourceHash, normalizeSegmentText(text));
    }
  }
  return segments;
}
