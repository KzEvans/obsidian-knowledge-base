import type { StoredBlock, StoredDocument, TranslationFile } from '../../core/types';

const SKIPPED = new Set<StoredBlock['kind']>(['header', 'footer']);

/**
 * The normalized paper as plain Markdown for the agent: headings, paragraphs, figure, table and
 * equation captions (they carry the "Figure 3" / "Table 1" numbers), no page numbers.
 */
export function documentToMarkdown(document: StoredDocument): string {
  const parts: string[] = [];
  for (const block of document.blocks) {
    if (SKIPPED.has(block.kind)) continue;
    const text = block.text.trim();
    switch (block.kind) {
      case 'heading':
        if (text) parts.push(`${'#'.repeat(Math.min(Math.max(block.level ?? 2, 1), 6))} ${text}`);
        break;
      case 'figure':
      case 'table':
      case 'equation': {
        const lines: string[] = [];
        for (const caption of block.captions ?? []) if (caption.trim()) lines.push(caption.trim());
        if (block.kind === 'equation' && text) lines.push(text.startsWith('$$') ? text : `$$${text}$$`);
        else if (block.kind === 'table' && text) lines.push(text);
        for (const footnote of block.footnotes ?? []) if (footnote.trim()) lines.push(footnote.trim());
        if (lines.length) parts.push(`[${KIND_LABEL[block.kind]}]\n${lines.join('\n')}`);
        break;
      }
      default:
        if (text) parts.push(text);
    }
  }
  return parts.join('\n\n') + '\n';
}

const KIND_LABEL = { figure: '图', table: '表', equation: '公式' } as const;

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
