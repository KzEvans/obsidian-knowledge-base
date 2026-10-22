import type { StoredBlock, StoredDocument } from '../../src/core/types';

/**
 * The normalized full text handed to the CLI (docs/contracts.md §9): Markdown without
 * page numbers; line markers [摘要], [图], [表], [参考文献] are part of the skill's contract.
 */
const plain = (html: string) => html
  .replace(/<sup>(.*?)<\/sup>/g, '^$1').replace(/<sub>(.*?)<\/sub>/g, '_$1')
  .replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/[ \t]+/g, ' ').trim();

function tableText(html: string): string {
  return html.split(/<\/tr>/i).map(row => row.split(/<\/t[dh]>/i).map(plain).filter(Boolean).join(' | ')).filter(Boolean).join('\n');
}

function renderBlock(block: StoredBlock): string | undefined {
  const text = plain(block.text);
  switch (block.kind) {
    case 'heading': return `${'#'.repeat(Math.min(6, (block.level ?? 1) + 1))} ${text}`;
    case 'paragraph': case 'list': case 'footnote': return block.role === 'abstract' ? `[摘要] ${text}` : text;
    case 'equation': return text ? `$$${text}$$` : undefined;
    case 'figure': case 'table': {
      const parts = [...(block.captions ?? []).map(plain)];
      if (block.kind === 'table' && block.html) parts.push(tableText(block.html));
      else if (text) parts.push(text);
      parts.push(...(block.footnotes ?? []).map(plain));
      const body = parts.filter(Boolean).join('\n');
      return body ? `[${block.kind === 'table' ? '表' : '图'}] ${body}` : undefined;
    }
    case 'references': return text ? `[参考文献] ${text}` : undefined;
    default: return undefined;
  }
}

/** The normalized full text handed to the CLI: Markdown, figure/table captions kept, no page numbers. */
export function fullText(document: StoredDocument): string {
  return document.blocks.map(renderBlock).filter((part): part is string => !!part).join('\n\n') + '\n';
}
