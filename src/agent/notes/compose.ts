import { fillAbstract } from './fulltext';
import { buildFrontmatter, readList, splitFrontmatter } from './frontmatter';
import type { FieldValue } from './frontmatter';
import type { PaperMetadata } from './metadata';
import { preserveHumanContent } from './protect';

export const TAG_FIELDS = ['concepts', 'materials', 'methods', 'phenomena'] as const;

export interface ComposeInput {
  /** note.md as the agent wrote it. */
  candidate: string;
  /** The published note before generation, if any. */
  original: string | null;
  metadata: PaperMetadata;
  sha: string;
  displayTitle: string;
  generatedDate: string;
  generatedAt: string;
  abstract: string | undefined;
}

/**
 * Program-owned parts of a note: frontmatter (feature-inventory §6), the H1, the abstract
 * translation and the protected human blocks. The agent only contributes the body and the four
 * tag lists.
 */
export function composeNote(input: ComposeInput): string {
  const { frontmatter, body } = splitFrontmatter(input.candidate.replace(/^﻿/, ''));
  const tags = Object.fromEntries(TAG_FIELDS.map(key => [key, frontmatter ? readList(frontmatter, key) : []]));
  const meta = input.metadata;
  const fields: [string, FieldValue][] = [
    ['type', 'paper'],
    ['status', 'draft'],
    ['title', meta.title],
    ['display_title', input.displayTitle],
    ['generated_date', input.generatedDate],
    ['generated_at', input.generatedAt],
    ['zotero_item', meta.zoteroItem],
    ['zotero_attachment', meta.zoteroAttachment],
    ['doi', meta.doi],
    ['source_pdf', `[[${meta.sourcePdf}]]`],
    ['source_sha256', input.sha],
    ['source_id', `paper:${meta.zoteroAttachment || 'local'}:${input.sha.slice(0, 16)}`],
    ['year', meta.year],
    ['journal', meta.journal],
    ['issn', meta.issn],
    ['impact_factor', meta.impactFactor],
    ['impact_factor_year', meta.impactFactorYear],
    ['impact_factor_source', meta.impactFactorSource],
    ['impact_factor_retrieved_at', meta.impactFactorRetrievedAt],
    ['supporting_information', meta.supportingInformation],
    ['reviewed', false],
    ...TAG_FIELDS.map(key => [key, tags[key] ?? []] as [string, FieldValue]),
  ];
  const content = fillAbstract(stripTitle(body).trim(), input.abstract);
  const note = `${buildFrontmatter(fields)}\n\n# ${input.displayTitle}\n\n${content}\n`;
  return preserveHumanContent(input.original ? splitFrontmatter(input.original).body : '', note);
}

/** The agent's own H1, if it wrote one, is replaced by ours. */
function stripTitle(body: string): string {
  return body.replace(/^\s*#[ \t]+[^\n]*\n?/, '');
}
