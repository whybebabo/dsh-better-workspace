import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSessionAction, retryFailed, mergeOutcomes, BATCH_LIMIT } from '../client/batch.js';

const host = ({ archive, unarchive }) => ({ archiveSession: archive, unarchiveSession: unarchive });

test('archives every id sequentially and never aborts on one rejection', async () => {
  const seen = [];
  const actions = host({
    archive: async (id) => {
      seen.push(id);
      if (id === 'ses_bad') throw new Error('disk on fire');
    },
  });
  const progress = [];
  const outcome = await runSessionAction({ action: 'archive', ids: ['ses_a', 'ses_bad', 'ses_c'], actions, onProgress: (p) => progress.push(p.done) });
  assert.deepEqual(seen, ['ses_a', 'ses_bad', 'ses_c']);
  assert.deepEqual(outcome.ok, ['ses_a', 'ses_c']);
  assert.equal(outcome.failed.length, 1);
  assert.equal(outcome.failed[0].id, 'ses_bad');
  assert.match(outcome.failed[0].error, /disk on fire/);
  assert.equal(outcome.needsStop.length, 0);
  assert.deepEqual(progress, [0, 1, 1, 2, 2, 3]);
  assert.match(outcome.summary, /成功 2/);
});

test('a running-session rejection is routed to stop-and-archive instead of failure', async () => {
  const calls = [];
  const actions = host({
    archive: async (id, options) => {
      calls.push([id, options]);
      if (options?.stopActivity !== true) throw Object.assign(new Error('会话正在运行'), { code: 'workspace-active-session' });
    },
  });
  const outcome = await runSessionAction({ action: 'archive', ids: ['ses_live'], actions });
  assert.equal(outcome.ok.length, 0);
  assert.equal(outcome.failed.length, 0, 'not a failure yet — the UI offers to stop it');
  assert.deepEqual(outcome.needsStop, ['ses_live']);

  const retried = await retryFailed({ outcome, ids: ['ses_live'], actions });
  assert.deepEqual(retried.ok, ['ses_live']);
  assert.deepEqual(calls[1], ['ses_live', { stopActivity: true }]);
});

test('an already-stopped retry keeps earlier successes', () => {
  const first = { action: 'archive', ok: ['ses_a'], failed: [{ id: 'ses_b', error: 'x', code: 'failed' }], needsStop: ['ses_c'], total: 3 };
  const second = { action: 'archive', ok: ['ses_b', 'ses_c'], failed: [], needsStop: [], total: 2 };
  const merged = mergeOutcomes(first, second);
  assert.deepEqual(merged.ok.sort(), ['ses_a', 'ses_b', 'ses_c']);
  assert.deepEqual(merged.failed, []);
  assert.deepEqual(merged.needsStop, []);
});

test('merging keeps a still-failing id in exactly one bucket', () => {
  const first = { action: 'archive', ok: [], failed: [{ id: 'ses_b', error: 'first', code: 'failed' }], needsStop: [], total: 1 };
  const second = { action: 'archive', ok: [], failed: [{ id: 'ses_b', error: 'again', code: 'failed' }], needsStop: [], total: 1 };
  const merged = mergeOutcomes(first, second);
  assert.equal(merged.failed.length, 1);
  assert.equal(merged.failed[0].error, 'again');
});

test('unarchive is dispatched through the official command and dedupes input', async () => {
  const seen = [];
  const actions = host({ unarchive: async (id) => seen.push(id) });
  const outcome = await runSessionAction({ action: 'unarchive', ids: ['ses_a', 'ses_a', 'ses_b'], actions });
  assert.deepEqual(seen, ['ses_a', 'ses_b']);
  assert.deepEqual(outcome.ok, ['ses_a', 'ses_b']);
  assert.equal(outcome.summary.includes('归档'), true);
});

test('oversized batches are truncated rather than silently dropped', async () => {
  const ids = Array.from({ length: BATCH_LIMIT + 30 }, (_, index) => `ses_${index}`);
  const seen = [];
  const actions = host({ archive: async (id) => seen.push(id) });
  const outcome = await runSessionAction({ action: 'archive', ids, actions });
  assert.equal(seen.length, BATCH_LIMIT);
  assert.equal(outcome.limited, true);
});

test('an aborted signal stops dispatching and reports the remainder', async () => {
  const controller = new AbortController();
  const seen = [];
  const actions = host({ archive: async (id) => { seen.push(id); controller.abort(); } });
  const outcome = await runSessionAction({ action: 'archive', ids: ['ses_a', 'ses_b', 'ses_c'], actions, signal: controller.signal });
  assert.equal(seen.length, 1, 'the first id dispatches, later ones are skipped');
  assert.equal(outcome.failed.length, 2);
});

test('unknown actions and empty input fail loudly', async () => {
  await assert.rejects(() => runSessionAction({ action: 'nuke', ids: ['ses_a'], actions: host({}) }));
  const empty = await runSessionAction({ action: 'archive', ids: [], actions: host({}) });
  assert.equal(empty.total, 0);
});
