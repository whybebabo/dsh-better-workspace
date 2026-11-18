import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isComposing } from '../client/keyboard.js';

test('IME composition suppresses Enter/Escape submission', () => {
  assert.equal(isComposing({ key: 'Enter', isComposing: true }), true);
  assert.equal(isComposing({ key: 'Escape', nativeEvent: { isComposing: true } }), true);
  assert.equal(isComposing({ key: 'Enter', keyCode: 229 }), true);
  assert.equal(isComposing({ key: 'Enter', nativeEvent: { keyCode: 229 } }), true);
});

test('ordinary keydowns are not compositions', () => {
  assert.equal(isComposing({ key: 'Enter', isComposing: false, keyCode: 13 }), false);
  assert.equal(isComposing(null), false);
  assert.equal(isComposing(undefined), false);
});