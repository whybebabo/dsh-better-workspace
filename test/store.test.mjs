import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTopicStore, StoreError, validateSessionIds, normalizeTopicName, normalizeTopicEmoji, pickTopicEmoji, TOPIC_EMOJIS } from '../lib/store.js';

async function freshStore() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-topic-store-'));
  const home = join(dir, 'home');
  return { dir, home, store: createTopicStore({ home }) };
}

const sampleIds = (n) => Array.from({ length: n }, (_, index) => `ses_test${index}`);

test('a missing file reads as an empty writable state', async () => {
  const { store } = await freshStore();
  const snapshot = await store.snapshot();
  assert.equal(snapshot.revision, 0);
  assert.equal(snapshot.readOnly, false);
  assert.deepEqual(Object.keys(snapshot.workspaces), []);
});

test('creates topics, persists them, rotates emoji markers', async () => {
  const { store } = await freshStore();
  const first = await store.createTopic({ workspaceId: 'ws_a', name: '设计' });
  assert.equal(first.revision, 1);
  assert.equal(first.result.topic.emoji, TOPIC_EMOJIS[0]);
  const second = await store.createTopic({ workspaceId: 'ws_a', name: '排查', expectedRevision: first.revision });
  assert.equal(second.result.topic.emoji, TOPIC_EMOJIS[1]);
  const onDisk = JSON.parse(await readFile(store.file, 'utf8'));
  assert.equal(onDisk.version, 1);
  assert.equal(onDisk.revision, 2);
  assert.equal(onDisk.workspaces.ws_a.topics.length, 2);
});

test('topic names are trimmed, length-checked, unique per workspace case-insensitively', async () => {
  const { store } = await freshStore();
  await store.createTopic({ workspaceId: 'ws_a', name: ' API ' });
  await assert.rejects(() => store.createTopic({ workspaceId: 'ws_a', name: 'api' }), (e) => e.code === 'topic-name-taken');
  await store.createTopic({ workspaceId: 'ws_b', name: 'api' });
  await assert.rejects(() => store.createTopic({ workspaceId: 'ws_a', name: '' }), (e) => e.code === 'topic-name-empty');
  await assert.rejects(() => store.createTopic({ workspaceId: 'ws_a', name: 'x'.repeat(41) }), (e) => e.code === 'topic-name-too-long');
  assert.equal(normalizeTopicName('  a b  '), 'a b');
  assert.equal(normalizeTopicEmoji(undefined), null, 'absent means leave the field alone');
  assert.equal(normalizeTopicEmoji(null), '', 'explicit null clears the marker');
  assert.equal(normalizeTopicEmoji('  x  '), 'x');
});

test('assign is idempotent, moves between topics, and unassign clears', async () => {
  const { store } = await freshStore();
  const a = (await store.createTopic({ workspaceId: 'ws_a', name: 'A' })).result.topic;
  const b = (await store.createTopic({ workspaceId: 'ws_a', name: 'B', expectedRevision: 1 })).result.topic;

  const first = await store.assign({ workspaceId: 'ws_a', sessionIds: ['ses_1', 'ses_1', 'ses_2'], topicId: a.id, expectedRevision: 2 });
  assert.equal(first.result.changed, 2, 'dedupes input ids');
  const again = await store.assign({ workspaceId: 'ws_a', sessionIds: ['ses_1', 'ses_2'], topicId: a.id, expectedRevision: first.revision });
  assert.equal(again.result.changed, 0, 'no-op does not report a change');
  assert.equal(again.revision, first.revision + 1, 'a write still bumps revision');

  const moved = await store.assign({ workspaceId: 'ws_a', sessionIds: ['ses_1'], topicId: b.id, expectedRevision: again.revision });
  assert.deepEqual(moved.result.assignments, { ses_1: b.id, ses_2: a.id });

  const cleared = await store.assign({ workspaceId: 'ws_a', sessionIds: ['ses_2', 'ses_missing'], topicId: null, expectedRevision: moved.revision });
  assert.equal(cleared.result.changed, 1, 'clearing an absent assignment is not a change');
  assert.deepEqual(cleared.result.assignments, { ses_1: b.id });

  await assert.rejects(() => store.assign({ workspaceId: 'ws_a', sessionIds: ['ses_1'], topicId: 'tp_nope', expectedRevision: cleared.revision }), (e) => e.code === 'topic-not-found');
});

test('deleting a topic releases its sessions but keeps the sessions', async () => {
  const { store } = await freshStore();
  const topic = (await store.createTopic({ workspaceId: 'ws_a', name: 'A', sessionIds: ['ses_1', 'ses_2'] })).result.topic;
  const outcome = await store.deleteTopic({ workspaceId: 'ws_a', topicId: topic.id, expectedRevision: 1 });
  assert.equal(outcome.result.released, 2);
  const snapshot = await store.snapshot();
  assert.deepEqual(snapshot.workspaces.ws_a.topics, []);
  assert.deepEqual(snapshot.workspaces.ws_a.assignments, {});
});

test('stale expectedRevision is a 409 carrying the current revision', async () => {
  const { store } = await freshStore();
  await store.createTopic({ workspaceId: 'ws_a', name: 'A' });
  await assert.rejects(
    () => store.createTopic({ workspaceId: 'ws_a', name: 'B', expectedRevision: 0 }),
    (e) => e instanceof StoreError && e.code === 'revision-conflict' && e.status === 409 && e.currentRevision === 1,
  );
});

test('concurrent writers serialize through the lock and keep both topics', async () => {
  const { store } = await freshStore();
  const results = await Promise.all([
    store.createTopic({ workspaceId: 'ws_a', name: 'A' }),
    store.createTopic({ workspaceId: 'ws_a', name: 'B' }),
  ]);
  assert.deepEqual(results.map((entry) => entry.revision).sort(), [1, 2]);
  const snapshot = await store.snapshot();
  assert.equal(snapshot.workspaces.ws_a.topics.length, 2);
});

test('a corrupt primary document falls back to the backup and goes read-only', async () => {
  const { store } = await freshStore();
  await store.createTopic({ workspaceId: 'ws_a', name: 'A' });
  await store.createTopic({ workspaceId: 'ws_a', name: 'B', expectedRevision: 1 });
  assert.ok((await readFile(`${store.file}.bak`, 'utf8')).includes('A'));
  await import('node:fs/promises').then(({ writeFile }) => writeFile(store.file, '{ truncated', 'utf8'));

  const snapshot = await store.snapshot();
  assert.equal(snapshot.readOnly, true);
  assert.equal(snapshot.workspaces.ws_a.topics.length, 1, 'recovered from .bak');
  assert.match(snapshot.warning, /损坏/);
  await assert.rejects(() => store.createTopic({ workspaceId: 'ws_a', name: 'C' }), (e) => e.code === 'store-read-only');
});

test('input validation rejects bad ids and oversized batches', () => {
  assert.deepEqual(validateSessionIds(['ses_a', 'ses_a']), ['ses_a']);
  assert.deepEqual(validateSessionIds([], { allowEmpty: true }), []);
  for (const bad of ['../etc', 'a/b', 'a\\b', '', 'x'.repeat(129), ' ses_a', null, 42]) {
    assert.throws(() => validateSessionIds([bad]), (e) => e.code === 'bad-session-id', `rejects ${JSON.stringify(bad)}`);
  }
  assert.throws(() => validateSessionIds(sampleIds(201)), (e) => e.code === 'batch-too-large');
  assert.throws(() => validateSessionIds('ses_a'), (e) => e.code === 'bad-session-ids');
  assert.throws(() => validateSessionIds([]), (e) => e.code === 'bad-session-ids');
});

test('workspace ids must be single safe segments', async () => {
  const { store } = await freshStore();
  for (const bad of ['../ws', 'ws/b', '', 'ws\\c', null]) {
    await assert.rejects(() => store.createTopic({ workspaceId: bad, name: 'A' }), (e) => e.code === 'bad-workspace', `rejects ${JSON.stringify(bad)}`);
  }
});
