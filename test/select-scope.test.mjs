/**
 * One definition of "selectable", shared by the tree and the panel's menus.
 *
 * A long bucket mounts only `REVEAL_LIMIT` rows, but the header checkbox, the topic ⋯ menu and
 * the workspace menu each derived their own id set. On a 70-row bucket that produced 60 / 69 / 70
 * for the same group, and a batch permanent delete could target rows the user never saw. The
 * fix is a single derivation (`model.selectableIds`); these tests pin its contract so a future
 * entry point cannot quietly reintroduce the divergence.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { REVEAL_LIMIT, selectableIds } from '../client/model.js';

const rows = (n, blanks = []) => Array.from({ length: n }, (_, index) => ({
  id: `ses_${index}`,
  blank: blanks.includes(index),
}));

test('a short bucket is selectable in full', () => {
  const scope = selectableIds({ rows: rows(5) });
  assert.deepEqual(scope.visible, ['ses_0', 'ses_1', 'ses_2', 'ses_3', 'ses_4']);
  assert.deepEqual(scope.hidden, []);
});

test('a truncated bucket exposes only the rows it mounted', () => {
  const scope = selectableIds({ rows: rows(70) });
  assert.equal(scope.visible.length, REVEAL_LIMIT, 'exactly the mounted prefix');
  assert.equal(scope.hidden.length, 70 - REVEAL_LIMIT, 'the rest is reported, not silently taken');
  assert.equal(scope.visible[0], 'ses_0');
  assert.equal(scope.hidden[0], `ses_${REVEAL_LIMIT}`);
});

test('expanding the bucket makes every mounted row selectable', () => {
  const scope = selectableIds({ rows: rows(70) }, { revealed: true });
  assert.equal(scope.visible.length, 70);
  assert.deepEqual(scope.hidden, []);
});

test('a collapsed bucket keeps its whole membership selectable', () => {
  // Collapsing is a deliberate act with the count still on the header, unlike truncation.
  const scope = selectableIds({ rows: rows(70), collapsed: true });
  assert.equal(scope.visible.length, 70);
  assert.deepEqual(scope.hidden, []);
});

test('the provisional New Session is never selectable', () => {
  const scope = selectableIds({ rows: rows(3, [0]) });
  assert.deepEqual(scope.visible, ['ses_1', 'ses_2']);
  assert.deepEqual(scope.hidden, []);
});

test('an empty or missing section yields an empty scope', () => {
  assert.deepEqual(selectableIds({ rows: [] }), { visible: [], hidden: [] });
  assert.deepEqual(selectableIds(undefined), { visible: [], hidden: [] });
});

/**
 * The regression was three call sites reading `section.rows` directly. Keep them from coming
 * back: a source-level assertion is blunt, but it is the only way to catch a *new* entry point
 * that forgets the shared derivation (a behavioural test can only exercise the ones that exist).
 */
test('no component derives selectable ids from section.rows directly', async () => {
  for (const file of ['../client/overlay.jsx', '../client/topic-tree.jsx']) {
    const source = await readFile(new URL(file, import.meta.url), 'utf8');
    const offenders = source
      .split('\n')
      .map((line, index) => ({ line: line.trim(), number: index + 1 }))
      .filter(({ line }) => /section\.rows/.test(line) && /\.map\(\(row\) => row\.id\)|setSelection\(/.test(line));
    assert.deepEqual(offenders, [], `${file} must use model.selectableIds, not section.rows (found ${JSON.stringify(offenders)})`);
  }
});
