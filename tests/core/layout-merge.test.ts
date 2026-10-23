import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mergedIntoPrevious } from '../../src/core/layout-merge';

const items = [
  { type: 'text', text: 'Paragraph that continues.', page_idx: 0, bbox: [68, 847, 485, 934] },
  { type: 'text', text: '', page_idx: 0, bbox: [507, 813, 924, 934] },
  { type: 'text', text: '', page_idx: 0, bbox: [70, 100, 300, 120] },
  { type: 'text', text: '', page_idx: 1, bbox: [70, 60, 487, 90] },
];
const layout = {
  pdf_info: [
    { page_idx: 0, page_size: [595, 782], para_blocks: [
      { type: 'text', bbox: [41, 663, 289, 731], merge_prev: false },
      { type: 'text', bbox: [302, 636, 550, 731], lines_deleted: true },
    ] },
    { page_idx: 1, page_size: [595, 782], para_blocks: [{ type: 'text', bbox: [42, 47, 290, 71], lines_deleted: true }] },
  ],
};

test('empty content-list blocks match MinerU lines_deleted blocks by page and scaled box', () => {
  assert.deepEqual([...mergedIntoPrevious(layout, items)].sort(), [1, 3]);
});

test('an empty block without a merge marker, or a missing layout, is not treated as merged', () => {
  assert.equal(mergedIntoPrevious(layout, items).has(2), false);
  assert.equal(mergedIntoPrevious(undefined, items).size, 0);
  assert.equal(mergedIntoPrevious({ pdf_info: 'bad' }, items).size, 0);
  assert.equal(mergedIntoPrevious({ pdf_info: [{ page_idx: 0, page_size: [0, 0], para_blocks: [] }] }, items).size, 0);
});

test('a block with text is never treated as merged even if its box matches', () => {
  const withText = items.map((item, index) => index === 1 ? { ...item, text: 'real text' } : item);
  assert.equal(mergedIntoPrevious(layout, withText).has(1), false);
});
