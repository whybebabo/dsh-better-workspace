import { test } from 'node:test';
import assert from 'node:assert/strict';
import { candidateLevel, couldReorder, MOTION_LEVELS, movedLevel, ROW_GLIDE_MS } from '../client/motion.js';

const row = (level, key, top = 0) => ({ level, key, top, left: 0 });

test('the glide is armed only when a level kept its rows but changed their order', () => {
  const keys = { workspace: ['ws_a', 'ws_b'], topic: ['ws_a:topic:tp_1'], session: ['ses_1', 'ses_2'] };
  assert.equal(couldReorder(keys, { ...keys }), false, 'an ordinary render measures nothing');
  assert.equal(couldReorder(keys, { ...keys, session: ['ses_1'] }), false, 'a removed row cannot glide');
  assert.equal(couldReorder(keys, { ...keys, session: ['ses_1', 'ses_2', 'ses_3'] }), false, 'a new row cannot glide');
  assert.equal(couldReorder(keys, { ...keys, session: ['ses_2', 'ses_1'] }), true, 'a swapped pair is a reorder');
  assert.equal(couldReorder(null, keys), false, 'the first commit has no baseline');
  assert.equal(
    couldReorder({ ...keys, session: ['ses_1', 'ses_9'] }, { ...keys, session: ['ses_2', 'ses_9'] }),
    false,
    'a replaced row is a membership change even at the same length',
  );
});

test('the candidate level is the outermost level that swapped', () => {
  const base = { workspace: ['ws_a', 'ws_b'], topic: ['ws_a:topic:tp_1', 'ws_a:topic:tp_2'], session: ['ses_1', 'ses_2'] };
  assert.equal(candidateLevel(base, { ...base, workspace: ['ws_b', 'ws_a'] }), 'workspace');
  assert.equal(candidateLevel(base, { ...base, topic: ['ws_a:topic:tp_2', 'ws_a:topic:tp_1'] }), 'topic');
  assert.equal(candidateLevel(base, { ...base, session: ['ses_2', 'ses_1'] }), 'session');
  assert.equal(candidateLevel(base, { ...base, session: ['ses_1', 'ses_9'] }), null, 'membership changes are not a candidate');
  assert.equal(candidateLevel(base, base), null);
});

test('a reorder is attributed to the outermost level that swapped', () => {
  const before = [
    row('workspace', 'ws_a'), row('topic', 'ws_a:tp_1'), row('session', 'ses_1'),
    row('workspace', 'ws_b'), row('topic', 'ws_b:tp_1'), row('session', 'ses_2'),
  ];
  const after = [
    row('workspace', 'ws_b'), row('topic', 'ws_b:tp_1'), row('session', 'ses_2'),
    row('workspace', 'ws_a'), row('topic', 'ws_a:tp_1'), row('session', 'ses_1'),
  ];
  assert.equal(movedLevel(before, after), 'workspace', 'the group is what travels; its rows must not animate twice');
});

test('a topic swap beats the session order change it carries with it', () => {
  const before = [
    row('workspace', 'ws_a'), row('topic', 'ws_a:tp_1'), row('session', 'ses_1'),
    row('topic', 'ws_a:tp_2'), row('session', 'ses_2'),
  ];
  const after = [
    row('workspace', 'ws_a'), row('topic', 'ws_a:tp_2'), row('session', 'ses_2'),
    row('topic', 'ws_a:tp_1'), row('session', 'ses_1'),
  ];
  assert.equal(movedLevel(before, after), 'topic');
});

test('a session swap animates at the session level', () => {
  const topic = 'ws_a:tp_1';
  const before = [row('workspace', 'ws_a'), row('topic', topic), { ...row('session', 'ses_1'), parent: topic }, { ...row('session', 'ses_2'), parent: topic }];
  const after = [row('workspace', 'ws_a'), row('topic', topic), { ...row('session', 'ses_2'), parent: topic }, { ...row('session', 'ses_1'), parent: topic }];
  assert.equal(movedLevel(before, after), 'session');
});

test('a row that changed parents was filed, not reordered', () => {
  const before = [
    row('workspace', 'ws_a'), row('topic', 'ws_a:tp_1'),
    { ...row('session', 'ses_1'), parent: 'ws_a:tp_1' }, { ...row('session', 'ses_2'), parent: 'ws_a:tp_1' },
  ];
  const after = [
    row('workspace', 'ws_a'), row('topic', 'ws_a:tp_1'),
    { ...row('session', 'ses_2'), parent: 'ws_a:tp_1' }, { ...row('session', 'ses_1'), parent: 'ws_a:tp_2' },
  ];
  assert.equal(movedLevel(before, after), null, 'a filed session must not fly across the list');
});

test('membership changes and untouched lists never animate', () => {
  const before = [row('workspace', 'ws_a'), row('session', 'ses_1')];
  assert.equal(movedLevel(before, [row('workspace', 'ws_a'), row('session', 'ses_1'), row('session', 'ses_2')]), null, 'an added row is not a move');
  assert.equal(movedLevel(before, [row('workspace', 'ws_a'), row('session', 'ses_3')]), null, 'a replaced row is not a move');
  assert.equal(movedLevel(before, before), null, 'an unchanged list has nothing to glide');
  assert.equal(movedLevel([row('workspace', 'ws_a')], [row('workspace', 'ws_a')]), null, 'one row cannot reorder');
});

test('the glide timing is the stock sidebar value', () => {
  assert.equal(ROW_GLIDE_MS, 200);
  assert.deepEqual(MOTION_LEVELS, ['workspace', 'topic', 'session']);
});
