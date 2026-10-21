import { test } from 'node:test';
import assert from 'node:assert/strict';
import { marqueePlan, MIN_REVEAL_PX, MARQUEE_PX_PER_MS } from '../client/marquee.js';

test('a title that fits is not revealed', () => {
  assert.equal(marqueePlan({ scrollWidth: 120, clientWidth: 120 }), null);
  assert.equal(marqueePlan({ scrollWidth: 118, clientWidth: 120 }), null, 'a wider box never scrolls');
});

test('a title clipped by less than the dead zone stays put', () => {
  assert.equal(MIN_REVEAL_PX, 8, 'the threshold matches the native list');
  assert.equal(marqueePlan({ scrollWidth: 128, clientWidth: 120 }), null, 'exactly the threshold is still jitter');
  assert.equal(marqueePlan({ scrollWidth: 129, clientWidth: 120 })?.range, 9);
});

test('the plan carries the native reading speed and the full overflow', () => {
  const plan = marqueePlan({ scrollWidth: 240, clientWidth: 120 });
  assert.deepEqual(plan, { range: 120, pxPerMs: MARQUEE_PX_PER_MS });
  assert.equal(MARQUEE_PX_PER_MS, 0.03, '0.03 px/ms is what the stock marquee uses');
});

test('a missing element (before first layout) is not a plan', () => {
  assert.equal(marqueePlan(null), null);
  assert.equal(marqueePlan(undefined), null);
});
