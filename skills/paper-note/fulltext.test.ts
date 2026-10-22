import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { fullText } from './fulltext';
import type { StoredDocument } from '../../src/core/types';

test('full text keeps headings, abstract, captions and references with their markers and no page numbers', () => {
  const document: StoredDocument = {
    schemaVersion: 2, sha256: 'x'.repeat(64), normalizerVersion: 1, pageCount: 2, warnings: [], assets: {},
    blocks: [
      { id: 'b1', kind: 'heading', level: 1, text: 'Introduction', sources: [{ page: 1 }], translatable: true },
      { id: 'b2', kind: 'paragraph', text: 'We show ZrO<sub>2</sub> works.', role: 'abstract', sources: [{ page: 1 }], translatable: true },
      { id: 'b3', kind: 'figure', text: '', captions: ['Figure 1. Setup.'], sources: [{ page: 2 }], translatable: true },
      { id: 'b4', kind: 'references', text: '[1] A. B. 2020.', sources: [{ page: 2 }], translatable: false },
      { id: 'b5', kind: 'metadata', text: 'Received 2020', hiddenByDefault: true, sources: [{ page: 1 }], translatable: false },
    ],
  };
  const text = fullText(document);
  assert.match(text, /^## Introduction/m);
  assert.match(text, /^\[摘要\] We show ZrO_2 works\./m);
  assert.match(text, /^\[图\] Figure 1\. Setup\./m);
  assert.match(text, /^\[参考文献\] \[1\]/m);
  assert.doesNotMatch(text, /Received|page|p\.\d/i);
});

test('scientific inequalities and equation annotations survive the full-text export', () => {
  const document: StoredDocument = { schemaVersion: 2, sha256: 'a'.repeat(64), normalizerVersion: 1, pageCount: 1, warnings: [], assets: {}, blocks: [
    { id: 'p', kind: 'paragraph', text: 'For $x<y$ and $z>0$ and $a<b>0$, use CO<sub>2</sub>.', sources: [{ page: 1 }], translatable: true },
    { id: 'e', kind: 'equation', text: 'x<b>0', captions: ['Equation caption'], footnotes: ['Equation note'], sources: [{ page: 1 }], translatable: true },
  ] };
  const text = fullText(document);
  assert.ok(text.includes('$x<y$ and $z>0$'));
  assert.ok(text.includes('CO_2'));
  assert.ok(text.includes('$a<b>0$'));
  assert.ok(text.includes('$$x<b>0$$'));
  assert.ok(text.includes('Equation caption') && text.includes('Equation note'));
});
