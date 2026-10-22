import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { placePopup } from '../../src/reader/selection/geometry';
import type { RectLike } from '../../src/reader/selection/geometry';

const rect = (left: number, top: number, width: number, height: number): RectLike =>
  ({ left, top, width, height, right: left + width, bottom: top + height });

const pane = rect(0, 0, 1000, 800);
const popup = { width: 300, height: 200 };

test('prefers the right of the selection, vertically centred on it', () => {
  const placement = placePopup(rect(100, 300, 200, 20), pane, popup);
  assert.deepEqual(placement, { side: 'right', left: 312, top: 210 });
});

test('falls back to the left when the right side is too narrow', () => {
  const placement = placePopup(rect(600, 300, 200, 20), pane, popup);
  assert.equal(placement.side, 'left');
  assert.equal(placement.left, 600 - 12 - 300);
});

test('falls back below, then above, when neither side fits', () => {
  const narrow = rect(0, 0, 500, 800);
  const below = placePopup(rect(100, 100, 300, 20), narrow, popup);
  assert.equal(below.side, 'below');
  assert.equal(below.top, 132);
  assert.equal(below.left, 100);

  const above = placePopup(rect(100, 600, 300, 20), narrow, popup);
  assert.equal(above.side, 'above');
  assert.equal(above.top, 600 - 12 - 200);
});

test('uses the roomiest side when nothing fits and clamps inside the pane', () => {
  const tiny = rect(0, 0, 320, 260);
  const placement = placePopup(rect(20, 20, 200, 30), tiny, popup);
  assert.equal(placement.side, 'below');
  assert.equal(placement.left, 10);
  assert.equal(placement.top, 260 - 10 - popup.height);
});

test('stays inside an offset pane (split view or popout) near its edges', () => {
  const offset = rect(500, 100, 400, 500);
  const placement = placePopup(rect(860, 560, 30, 20), offset, popup);
  assert.ok(placement.left >= 510 && placement.left + popup.width <= 890);
  assert.ok(placement.top >= 110 && placement.top + popup.height <= 590);
});
