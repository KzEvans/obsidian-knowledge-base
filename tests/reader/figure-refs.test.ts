import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { buildFigureIndex, figureGroups, findFigureRefs, mayReference } from '../../src/reader/figure-refs';
import type { StoredBlock } from '../../src/core/types';

let id = 0;
function block(kind: StoredBlock['kind'], page: number, extra: Partial<StoredBlock> = {}): StoredBlock {
  return { id: `b${id++}`, kind, sources: [{ page }], text: '', translatable: false, ...extra };
}
const figure = (page: number, asset: string, caption?: string) => block('figure', page, { asset, ...(caption ? { captions: [caption] } : {}) });

const refs = (text: string, caption = false) => findFigureRefs(text, caption).map(ref => [ref.number, text.slice(ref.start, ref.end)]);

test('labeled figures map to their images; SI figures are left out', () => {
  const index = buildFigureIndex({ blocks: [
    figure(1, 'a.jpg', 'Figure 1. Overview'),
    figure(2, 'b.jpg', 'Fig. 2 | Mechanism'),
    figure(3, 'c.jpg', '图 3 示意图'),
    figure(4, 's.jpg', 'Figure S1. Extra'),
  ] });
  assert.deepEqual([...index], [['1', ['a.jpg']], ['2', ['b.jpg']], ['3', ['c.jpg']]]);
});

test('unlabeled image blocks right before a labeled figure are its panels', () => {
  const index = buildFigureIndex({ blocks: [
    figure(9, 'p1.jpg'), figure(9, 'p2.jpg'), block('footer', 9), figure(9, 'main.jpg', 'Fig. 4 | Soft actuators'),
  ] });
  assert.deepEqual(index.get('4'), ['p1.jpg', 'p2.jpg', 'main.jpg']);
});

test('a figure whose caption lost its label takes the next unused number on a later page', () => {
  const index = buildFigureIndex({ blocks: [
    figure(1, 'toc.jpg'),
    block('paragraph', 2), figure(2, 'one.jpg', 'Figure 1. A'),
    block('paragraph', 3), figure(3, 'two.jpg', 'Figure 2. B'),
    block('paragraph', 4), figure(4, 'three.png', 'Raman microscopy'),
    block('paragraph', 5), figure(5, 'four.png', 'Monomer loading'),
    block('paragraph', 6), figure(6, 'five.png', 'Figure 5. Last'),
  ] });
  assert.equal(index.has('0'), false, 'graphical abstract before Figure 1 has no number');
  assert.deepEqual(index.get('3'), ['three.png']);
  assert.deepEqual(index.get('4'), ['four.png']);
  assert.deepEqual(index.get('5'), ['five.png']);
});

test('body references: English, abbreviations, panels, lists, Chinese', () => {
  assert.deepEqual(refs('shown in Figure 4a can be described'), [['4', 'Figure 4a']]);
  assert.deepEqual(refs('see Figs. 2 and 3B,C here'), [['2', 'Figs. 2'], ['3', '3B']]);
  assert.deepEqual(refs('(Figure 2C, left, and Figure S3)'), [['2', 'Figure 2C']]);
  assert.deepEqual(refs('如图 3 所示，与图4b一致'), [['3', '图 3'], ['4', '图4b']]);
  assert.deepEqual(refs('FIG. 7 shows'), [['7', 'FIG. 7']]);
});

test('supplementary figures and S-numbered figures are not references', () => {
  assert.deepEqual(refs('(Supplementary Figure 3) and Extended Data Fig. 2 and SI Figure 1'), []);
  assert.deepEqual(refs('see Figures S6 and S8A,B'), []);
  assert.deepEqual(refs('见补充图 2'), []);
});

test('caption labels are not references, body text starting with a figure is', () => {
  assert.deepEqual(refs('Figure 5. Normalized stress relaxation, compare Figure 4'), [['4', 'Figure 4']]);
  assert.deepEqual(refs('Fig. 1 | Working principles'), []);
  assert.deepEqual(refs('**Figure 2**: overview'), []);
  assert.deepEqual(refs('图 5 归一化应力松弛', true), []);
  assert.deepEqual(refs('Figure 4a shows the fit.'), [['4', 'Figure 4a']]);
});

test('Wiley layout: spaced labels, label in a later caption, caption paragraphs, continuing panels', () => {
  const panel = (page: number, asset: string, ...captions: string[]) => block('figure', page, { asset, captions });
  const index = buildFigureIndex({ blocks: [
    panel(7, '1a', '(a)'), panel(7, '1b', '(b)'), panel(7, '1c', 'F I G U R E 1 Characterization results'),
    panel(7, '2a', '(a)'), panel(7, '2b', '(b)'), block('footer', 7), block('equation', 7, { text: '$$PS_{300}$$' }), block('paragraph', 7, { text: 'F I G U R E 2 (a) The evolution of average volume' }),
    block('paragraph', 8, { text: 'Body text.' }),
    panel(9, '3a', '(a)'), panel(9, '3c', '(c)', 'F I G U R E 3 Characterization results'),
    panel(10, '5a', '(a)'), panel(10, '5b', '(b)', 'F I GU RE 5 The AFM images'), panel(10, '5c', '(c)'), panel(10, '5d', '(d)'),
    panel(10, '6', 'F I G U RE 6 The MDSC curves'),
    block('paragraph', 10, { text: 'Figure 5 shows the AFM images' }),
  ] });
  assert.deepEqual([...index], [
    ['1', ['1a', '1b', '1c']], ['2', ['2a', '2b']], ['3', ['3a', '3c']], ['5', ['5a', '5b', '5c', '5d']], ['6', ['6']],
  ]);
});

test('text drawn inside a figure belongs to it; a body equation after an unlabeled image does not', () => {
  const heading = block('heading', 10, { text: 'a Mechanical instabilities', sources: [{ page: 10, bbox: [0.23, 0.41, 0.39, 0.42] }] });
  const formula = block('equation', 7, { text: '$$PS_{300}$$' });
  const body = block('equation', 3, { text: '$$E = mc^2$$' });
  const groups = figureGroups([
    heading, block('figure', 10, { asset: 'f5', captions: ['Fig. 5 | Encoding'], sources: [{ page: 10, bbox: [0.23, 0.41, 0.93, 0.84] }] }),
    block('figure', 7, { asset: '2a' }), formula, block('paragraph', 7, { text: 'F I G U R E 2 (a) The evolution' }),
    block('paragraph', 7, { text: 'Body.' }), block('figure', 3, { asset: 'toc' }), body,
  ]);
  assert.deepEqual(groups.map(group => group.inside), [[heading], [formula], []]);
});

test('schemes are numbered apart from figures; a caption paragraph above its image labels it', () => {
  const caption = block('paragraph', 5, { text: 'S CH E M E 1 (a) Conceptual scheme for the synthesis' });
  const groups = figureGroups([
    block('paragraph', 4, { text: 'described in Scheme 1.' }),
    caption, block('figure', 5, { asset: 'scheme.jpg' }),
    block('paragraph', 5, { text: 'Body.' }),
    block('figure', 7, { asset: 'one.jpg', captions: ['Figure 1. Results'] }),
    block('paragraph', 8, { text: 'Figure 2 shows the next step.' }), block('figure', 8, { asset: 'loose.jpg' }),
  ]);
  assert.deepEqual(groups.map(group => [group.number, group.images.map(image => image.asset), group.caption === caption]), [
    ['scheme 1', ['scheme.jpg'], true], ['1', ['one.jpg'], false], ['2', ['loose.jpg'], false],
  ]);
  assert.deepEqual(refs('described in Scheme 1 and Schemes 2, 3; 方案 4'), [['scheme 1', 'Scheme 1'], ['scheme 2', 'Schemes 2'], ['scheme 3', '3'], ['scheme 4', '方案 4']]);
  assert.deepEqual(refs('S CH E M E 1 (a) Conceptual', true), []);
});

test('tables are indexed by caption with their crop, apart from figures and SI tables', () => {
  const index = buildFigureIndex({ blocks: [
    block('table', 6, { asset: 't1.png', captions: ['T A B L E 1 Polymerization conditions'] }),
    block('table', 9, { asset: 't3.png', captions: ['T AB L E 3 Mechanical properties'] }),
    block('table', 9, { asset: 's1.png', captions: ['Table S1. Extra'] }),
    figure(10, 'f1.png', 'Figure 1. A'),
    block('paragraph', 11, { text: 'Table 2. Caption-like paragraph' }), figure(11, 'f2.png'),
  ] });
  assert.deepEqual([...index].sort(), [['1', ['f1.png']], ['2', ['f2.png']], ['table 1', ['t1.png']], ['table 3', ['t3.png']]]);
  assert.deepEqual(refs('listed in Table 1 and Tables 2, 3; 如表 4 所示，代表 5 种'), [['table 1', 'Table 1'], ['table 2', 'Tables 2'], ['table 3', '3'], ['table 4', '表 4']]);
});

test('the pre-check lets through text that mentions only a scheme or a table', () => {
  for (const text of ['described in Scheme 1.', 'listed in Table 2', '如表 3 所示', '见方案 1', 'Figure 4', '图 5']) assert.ok(mayReference(text), text);
  assert.equal(mayReference('Plain body text.'), false);
});
