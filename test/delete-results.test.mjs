import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeDeleteOutcomes } from '../client/delete-results.js';

const item = (sessionId, status, extra = {}) => ({ sessionId, status, blockers: [], subagentsRemoved: [], ...extra });

test('a delete retry keeps the earlier successes and summarizes the cumulative page', () => {
  const first = {
    summary: { deleted: 1, skipped: 0, failed: 1, partial: 0, subagents: 0 },
    items: [item('ses_a', 'deleted'), item('ses_b', 'failed', { code: 'locked', error: 'busy' })],
  };
  const retry = {
    summary: { deleted: 1, skipped: 0, failed: 0, partial: 0, subagents: 2 },
    items: [item('ses_b', 'deleted', { subagentsRemoved: ['ses_child'] })],
    home: '/tmp/home',
  };
  const merged = mergeDeleteOutcomes(first, retry);
  assert.deepEqual(merged.items.map((entry) => entry.sessionId), ['ses_a', 'ses_b']);
  assert.deepEqual(merged.items.map((entry) => entry.status), ['deleted', 'deleted']);
  assert.deepEqual(merged.summary, { deleted: 2, skipped: 0, failed: 0, partial: 0, subagents: 1 });
  assert.equal(merged.home, '/tmp/home');
});

test('a retry that still fails replaces one entry instead of duplicating it', () => {
  const first = { items: [item('ses_a', 'failed', { code: 'locked' })], summary: { deleted: 0, skipped: 0, failed: 1, partial: 0, subagents: 0 } };
  const retry = { items: [item('ses_a', 'partial', { subagentsFailed: ['ses_child'] })], summary: { deleted: 0, skipped: 0, failed: 0, partial: 1, subagents: 0 } };
  const merged = mergeDeleteOutcomes(first, retry);
  assert.equal(merged.items.length, 1);
  assert.equal(merged.items[0].status, 'partial');
  assert.equal(merged.summary.partial, 1);
  assert.equal(merged.summary.failed, 0);
});

test('a retried surviving subagent is dropped from its partial parent and from the retry button', () => {
  const first = {
    items: [item('ses_parent', 'partial', { subagentsFailed: ['ses_child'] })],
    summary: { deleted: 0, skipped: 0, failed: 0, partial: 1, subagents: 0 },
  };
  const retry = {
    items: [item('ses_child', 'deleted')],
    summary: { deleted: 1, skipped: 0, failed: 0, partial: 0, subagents: 0 },
  };
  const merged = mergeDeleteOutcomes(first, retry);
  const parent = merged.items.find((entry) => entry.sessionId === 'ses_parent');
  assert.equal(parent.status, 'deleted', 'the parent artifact was already gone; its last child is now gone too');
  assert.deepEqual(parent.subagentsFailed, []);
  assert.deepEqual(merged.summary, { deleted: 2, skipped: 0, failed: 0, partial: 0, subagents: 0 });
  assert.equal(
    merged.items.some((entry) => entry.status === 'failed' || entry.status === 'partial'),
    false,
    'no retry entry remains for a child that was deleted',
  );
});

test('a cleanup warning survives a retry that no longer reports it', () => {
  const first = { items: [], assignmentCleanup: { failed: true, error: 'sidecar busy' } };
  const retry = { items: [item('ses_a', 'deleted')], summary: { deleted: 1, skipped: 0, failed: 0, partial: 0, subagents: 0 } };
  assert.deepEqual(mergeDeleteOutcomes(first, retry).assignmentCleanup, { failed: true, error: 'sidecar busy' });
});