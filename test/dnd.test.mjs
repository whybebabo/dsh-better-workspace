import { test } from 'node:test';
import assert from 'node:assert/strict';
import { beginDrag, currentDrag, endDrag, evaluateDrop, readDragPayload, writeDragPayload, DND_MIME } from '../client/dnd.js';

test('the drag context is published for hover decisions and cleared on end', () => {
  assert.equal(currentDrag(), null);
  beginDrag({ ids: ['ses_a', 'ses_a', 'ses_b'], workspaceId: 'ws_1', fromTopicId: 'tp_1' });
  assert.deepEqual(currentDrag().ids, ['ses_a', 'ses_b']);
  assert.equal(currentDrag().workspaceId, 'ws_1');
  endDrag();
  assert.equal(currentDrag(), null);
});

test('drops are accepted within a workspace and refused across workspaces', () => {
  const drag = { ids: ['ses_a'], workspaceId: 'ws_1', fromTopicId: 'tp_1' };
  assert.deepEqual(evaluateDrop(drag, { workspaceId: 'ws_1', topicId: 'tp_2' }), { ok: true, reason: null });
  assert.deepEqual(evaluateDrop(drag, { workspaceId: 'ws_1', topicId: null }), { ok: true, reason: null }, 'clearing via 未分类 is a move');
  assert.equal(evaluateDrop(drag, { workspaceId: 'ws_2', topicId: 'tp_9' }).reason, 'cross-workspace');
  assert.equal(evaluateDrop(drag, { workspaceId: 'ws_1', topicId: 'tp_1' }).reason, 'already-there');
  assert.equal(evaluateDrop(null, { workspaceId: 'ws_1', topicId: 'tp_2' }).ok, false);
  assert.equal(evaluateDrop({ ids: [], workspaceId: 'ws_1' }, { workspaceId: 'ws_1', topicId: null }).reason, 'empty');
  assert.equal(evaluateDrop(drag, null).reason, 'no-target');
});

test('a multi-session drag is not treated as a no-op even if one id already matches', () => {
  const verdict = evaluateDrop({ ids: ['ses_a', 'ses_b'], workspaceId: 'ws_1', fromTopicId: 'tp_1' }, { workspaceId: 'ws_1', topicId: 'tp_1' });
  assert.equal(verdict.ok, true);
});

test('the payload round-trips through dataTransfer', () => {
  const store = new Map();
  const dataTransfer = {
    setData: (type, value) => store.set(type, value),
    getData: (type) => store.get(type) ?? '',
  };
  writeDragPayload(dataTransfer, ['ses_a', 'ses-b.1']);
  assert.equal(dataTransfer.getData(DND_MIME), JSON.stringify(['ses_a', 'ses-b.1']));
  assert.deepEqual(readDragPayload(dataTransfer), ['ses_a', 'ses-b.1']);
});

test('foreign payloads degrade safely instead of throwing', () => {
  assert.deepEqual(readDragPayload({ getData: (type) => (type === DND_MIME ? '{"ids":["ses_a",42,null,""]}' : '') }), ['ses_a'], 'non-strings dropped');
  assert.deepEqual(readDragPayload({ getData: () => '{ broken' }), [], 'unparsable garbage');
  assert.deepEqual(readDragPayload(undefined), []);
  assert.deepEqual(readDragPayload({ getData: () => '' }), []);
});

test('a plain-text or file payload is never read as session ids', () => {
  // Dragging a file from the desktop arrives as its name, and `README.md`, `package.json` and
  // `12345` all look like valid session ids. Only a payload this panel wrote may name
  // sessions, otherwise an external drop files a phantom assignment in the sidecar.
  const foreign = (text) => ({ getData: (type) => (type === DND_MIME ? '' : text) });
  for (const text of ['README.md', 'package.json', 'notes.txt', '12345', 'A', 'ses_a, ses_b']) {
    assert.deepEqual(readDragPayload(foreign(text)), [], `ignores ${JSON.stringify(text)}`);
  }
});

test('setData failures do not break the drag', () => {
  const locked = { setData: () => { throw new Error('locked'); }, getData: () => '' };
  assert.doesNotThrow(() => writeDragPayload(locked, ['ses_a']));
});
