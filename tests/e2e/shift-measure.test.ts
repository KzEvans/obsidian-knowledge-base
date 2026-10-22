import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { dom, rectangle } from '../reader/harness';
import { offsetOf, sampleDelta, scrollFractions, summarize, topOffset } from './shift-measure';

test('scroll positions are evenly spaced and cover top and bottom', () => {
  const fractions = scrollFractions(24);
  assert.equal(fractions.length, 24);
  assert.equal(fractions[0], 0);
  assert.equal(fractions.at(-1), 1);
});

test('the top block is the first one reaching below the viewport top', () => {
  const { document } = dom();
  const root = document.body.createDiv();
  root.getBoundingClientRect = () => rectangle(100, 500);
  const tops = [0, 60, 150, 300];
  tops.forEach((top, index) => {
    const block = root.createDiv({ cls: 'b', attr: { 'data-id': `b${index}` } });
    block.getBoundingClientRect = () => rectangle(top, 90);
  });
  const id = (element: HTMLElement) => element.dataset.id ?? '';
  // b0 ends at 90 (above 100); b1 spans 60–150 and is cut by the top edge.
  assert.deepEqual(topOffset(root, '.b', id), { id: 'b1', offset: -40 });
  assert.equal(offsetOf(root, '.b', id, 'b3'), 200);
  assert.equal(offsetOf(root, '.b', id, 'missing'), undefined);
});

test('a sample fails when anything moves more than the tolerance, vanishes or the scroll changes', () => {
  assert.equal(sampleDelta([10, 20], [10.4, 20], [10, 19.5]), 0.5);
  assert.equal(sampleDelta([10], [NaN], [10]), Infinity);
  const sample = (delta: number, scrollChanged = false) => ({ fraction: 0, scrollTop: 0, en: [], zh: [], back: [], scrollChanged, delta });
  const ok = summarize([{ paper: 'a', width: 420, samples: [sample(0), sample(1)] }]);
  assert.equal(ok.pass, true);
  assert.equal(ok.maxDeltaPx, 1);
  const bad = summarize([
    { paper: 'a', width: 420, samples: [sample(1.5)] },
    { paper: 'b', width: 600, samples: [sample(0, true)] },
    { paper: 'c', width: 900, samples: [], error: '没有译文' },
  ]);
  assert.equal(bad.pass, false);
  assert.equal(bad.failures.length, 2);
  assert.deepEqual(bad.errors, [{ paper: 'c', width: 900, error: '没有译文' }]);
  assert.equal(summarize([]).pass, false);
});
