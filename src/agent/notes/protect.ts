/**
 * Human content that regeneration keeps verbatim (docs/contracts.md §7). A port of
 * protected_spans / preserve_human_content in legacy run_pipeline.py.
 */

const PROTECTED_HEADINGS = new Set(['人工复核', 'Human Review', '提问']);
const REVIEW_PREFIXES = ['## 人工复核', '## Human Review'];
const CHECKBOX = /^\s*[-*+] \[[ xX]\] (.+)$/gm;

export function protectedSpans(text: string): [number, number][] {
  const spans: [number, number][] = [];
  const headings = [...text.matchAll(/^(#{1,6})\s+(.+?)\s*$/gm)];
  headings.forEach((match, index) => {
    if (!PROTECTED_HEADINGS.has(match[2]!)) return;
    const level = match[1]!.length;
    const next = headings.slice(index + 1).find(following => following[1]!.length <= level);
    spans.push([match.index, next ? next.index : text.length]);
  });
  for (const pattern of [/<!-- user-notes:start -->[\s\S]*?<!-- user-notes:end -->/g, /<!-- intensive-reading:([^:]+):start -->[\s\S]*?<!-- intensive-reading:\1:end -->/g]) {
    for (const match of text.matchAll(pattern)) spans.push([match.index, match.index + match[0].length]);
  }
  const merged: [number, number][] = [];
  for (const [start, end] of spans.sort((left, right) => left[0] - right[0] || left[1] - right[1])) {
    const last = merged.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(end, last[1]);
    else merged.push([start, end]);
  }
  return merged;
}

/** Drop the candidate's own copies of protected blocks and append the original ones. Idempotent. */
export function preserveHumanContent(original: string, candidate: string): string {
  if (!original) return candidate;
  const originalSpans = protectedSpans(original);
  if (!originalSpans.length) return candidate;
  const hasReview = /^## (?:人工复核|Human Review)\s*$/m.test(original);
  const oldItems = new Set([...original.matchAll(CHECKBOX)].map(match => match[1]!));
  const newItems: string[] = [];
  const isReview = (block: string) => REVIEW_PREFIXES.some(prefix => block.startsWith(prefix));
  for (const [start, end] of protectedSpans(candidate)) {
    const block = candidate.slice(start, end);
    if (hasReview && isReview(block)) {
      for (const match of block.matchAll(CHECKBOX)) if (!oldItems.has(match[1]!)) newItems.push(match[1]!);
    }
  }
  for (const [start, end] of protectedSpans(candidate).reverse()) {
    if (isReview(candidate.slice(start, end)) && !hasReview) continue;
    candidate = candidate.slice(0, start) + candidate.slice(end);
  }
  const blocks = originalSpans.map(([start, end]) => original.slice(start, end).trimEnd());
  let addendum = newItems.length
    ? '\n\n### 本次生成新增待复核\n\n' + [...new Set(newItems)].map(item => `- [ ] ${item}`).join('\n')
    : '';
  const reviewIndex = blocks.findIndex(isReview);
  if (reviewIndex >= 0) { blocks[reviewIndex] += addendum; addendum = ''; }
  if (addendum) blocks.unshift('## 人工复核' + addendum);
  let result = candidate.trimEnd() + '\n\n' + blocks.join('\n\n') + '\n';
  if (!result.includes('<!-- user-notes:start -->')) result += '\n<!-- user-notes:start -->\n<!-- user-notes:end -->\n';
  return result;
}
