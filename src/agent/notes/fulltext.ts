import { markdownHeadings } from './headings';
import type { StoredDocument, TranslationFile } from '../../core/types';

export const ABSTRACT_MARKER = '<!-- abstract-translation -->';

/** Qwen-MT translations of the abstract blocks, in order; undefined when there are none. */
export function abstractTranslation(document: StoredDocument, translations: TranslationFile | undefined): string | undefined {
  const abstracts = document.blocks.filter(block => block.role === 'abstract');
  const paragraphs: string[] = [];
  for (const block of abstracts) {
    const segments = block.segments?.filter(segment => segment.field === 'text') ?? [];
    if (!segments.length) return undefined;
    const texts = segments.map(segment => translations?.entries[segment.sourceHash]?.text.trim());
    if (texts.some(text => !text)) return undefined;
    paragraphs.push(texts.join(' '));
  }
  return paragraphs.length ? paragraphs.join('\n\n') : undefined;
}

/** The program owns the whole abstract section; model prose and marker placement are ignored. */
export function fillAbstract(note: string, translation: string | undefined): string {
  const content = translation ?? ABSTRACT_MARKER;
  note = note.replaceAll(ABSTRACT_MARKER, '');
  const headings = markdownHeadings(note);
  const abstract = headings.find(heading => heading.level === 2 && heading.text === '摘要翻译');
  if (!abstract) return `## 摘要翻译\n\n${content}\n\n${note}`;
  const next = headings.find(heading => heading.index > abstract.index && heading.level <= 2);
  return note.slice(0, abstract.index) + `## 摘要翻译\n\n${content}\n` + (next ? '\n' + note.slice(next.index) : '');
}
