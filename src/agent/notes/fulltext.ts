import type { StoredDocument, TranslationFile } from '../../core/types';

export const ABSTRACT_MARKER = '<!-- abstract-translation -->';

/** Qwen-MT translations of the abstract blocks, in order; undefined when there are none. */
export function abstractTranslation(document: StoredDocument, translations: TranslationFile | undefined): string | undefined {
  const paragraphs = document.blocks
    .filter(block => block.role === 'abstract')
    .map(block => (block.segments ?? []).filter(segment => segment.field === 'text')
      .map(segment => translations?.entries[segment.sourceHash]?.text.trim() ?? '').filter(Boolean).join(' '))
    .filter(Boolean);
  return paragraphs.length ? paragraphs.join('\n\n') : undefined;
}

/** Replace the marker the model leaves in 摘要翻译; the marker stays when no translation exists. */
export function fillAbstract(note: string, translation: string | undefined): string {
  if (!translation || !note.includes(ABSTRACT_MARKER)) return note;
  return note.replace(ABSTRACT_MARKER, () => translation);
}
