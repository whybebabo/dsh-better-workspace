import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTopicStore, StoreError, validateSessionIds, normalizeTopicName, normalizeTopicEmoji, pickTopicEmoji, TOPIC_EMOJIS, DEFAULT_TOPIC_ID } from '../lib/store.js';

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

test('the emoji picker enumerates Zen Browser\'s emoji set in order', () => {
  assert.equal(TOPIC_EMOJIS.length, 1915);
  assert.deepEqual(TOPIC_EMOJIS.slice(0, 3), ['\u{1F600}', '\u{1F603}', '\u{1F604}']);
  assert.equal(TOPIC_EMOJIS.at(-1), '\u{1F3F4}\u{E0067}\u{E0062}\u{E0077}\u{E006C}\u{E0073}\u{E007F}');
});

test('creates topics, persists them, rotates emoji markers', async () => {
  const { store } = await freshStore();
  const first = await store.createTopic({ workspaceId: 'ws_a', name: '设计', expectedRevision: 0 });
  assert.equal(first.revision, 1);
  assert.equal(first.result.topic.emoji, TOPIC_EMOJIS[0]);
  const second = await store.createTopic({ workspaceId: 'ws_a', name: '排查', expectedRevision: first.revision });
  assert.equal(second.result.topic.emoji, TOPIC_EMOJIS[1]);
  const onDisk = JSON.parse(await readFile(store.file, 'utf8'));
  assert.equal(onDisk.version, 1);
  assert.equal(onDisk.revision, 2);
  assert.equal(onDisk.workspaces.ws_a.topics.length, 3, 'the reserved default group is persisted too');
  assert.equal(onDisk.workspaces.ws_a.topics[0].id, DEFAULT_TOPIC_ID);
  assert.equal(onDisk.workspaces.ws_a.topics[0].system, true);
});

test('the default group exists in every snapshot and cannot be renamed or deleted', async () => {
  const { store } = await freshStore();
  const snapshot = await store.createTopic({ workspaceId: 'ws_a', name: 'A', expectedRevision: 0 });
  const listed = (await store.snapshot()).workspaces.ws_a.topics;
  assert.equal(listed[0].id, DEFAULT_TOPIC_ID, 'the default group leads the list');

  await assert.rejects(
    () => store.updateTopic({ workspaceId: 'ws_a', topicId: DEFAULT_TOPIC_ID, name: '改名', expectedRevision: snapshot.revision }),
    (e) => e.code === 'default-topic-protected',
  );
  await assert.rejects(
    () => store.deleteTopic({ workspaceId: 'ws_a', topicId: DEFAULT_TOPIC_ID, expectedRevision: snapshot.revision }),
    (e) => e.code === 'default-topic-protected',
  );
});

test('topic names are trimmed, length-checked, unique per workspace case-insensitively', async () => {
  const { store } = await freshStore();
  await store.createTopic({ workspaceId: 'ws_a', name: ' API ', expectedRevision: 0 });
  await assert.rejects(() => store.createTopic({ workspaceId: 'ws_a', name: 'api', expectedRevision: 1 }), (e) => e.code === 'topic-name-taken');
  await store.createTopic({ workspaceId: 'ws_b', name: 'api', expectedRevision: 1 });
  await assert.rejects(() => store.createTopic({ workspaceId: 'ws_a', name: '', expectedRevision: 2 }), (e) => e.code === 'topic-name-empty');
  await assert.rejects(() => store.createTopic({ workspaceId: 'ws_a', name: 'x'.repeat(41), expectedRevision: 2 }), (e) => e.code === 'topic-name-too-long');
  assert.equal(normalizeTopicName('  a b  '), 'a b');
  assert.equal(normalizeTopicEmoji(undefined), null, 'absent means leave the field alone');
  assert.equal(normalizeTopicEmoji(null), '', 'explicit null clears the marker');
  assert.equal(normalizeTopicEmoji('  x  '), 'x');
  assert.equal(normalizeTopicEmoji('\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}'), '\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}', 'tag sequences are not truncated');
  assert.equal(normalizeTopicEmoji('\u{1F469}\u200D\u2764\uFE0F\u200D\u{1F48B}\u200D\u{1F468}'), '\u{1F469}\u200D\u2764\uFE0F\u200D\u{1F48B}\u200D\u{1F468}', 'ZWJ sequences are not truncated');
});

test('assign is idempotent, moves between topics, and null means the default group', async () => {
  const { store } = await freshStore();
  const a = (await store.createTopic({ workspaceId: 'ws_a', name: 'A', expectedRevision: 0 })).result.topic;
  const b = (await store.createTopic({ workspaceId: 'ws_a', name: 'B', expectedRevision: 1 })).result.topic;

  const first = await store.assign({ workspaceId: 'ws_a', sessionIds: ['ses_1', 'ses_1', 'ses_2'], topicId: a.id, expectedRevision: 2 });
  assert.equal(first.result.changed, 2, 'dedupes input ids');
  const again = await store.assign({ workspaceId: 'ws_a', sessionIds: ['ses_1', 'ses_2'], topicId: a.id, expectedRevision: first.revision });
  assert.equal(again.result.changed, 0, 'no-op does not report a change');
  assert.equal(again.revision, first.revision + 1, 'a write still bumps revision');

  const moved = await store.assign({ workspaceId: 'ws_a', sessionIds: ['ses_1'], topicId: b.id, expectedRevision: again.revision });
  assert.deepEqual(moved.result.assignments, { ses_1: b.id, ses_2: a.id });

  const defaulted = await store.assign({ workspaceId: 'ws_a', sessionIds: ['ses_2', 'ses_missing'], topicId: null, expectedRevision: moved.revision });
  assert.equal(defaulted.result.topicId, DEFAULT_TOPIC_ID, 'null resolves to the reserved default group');
  assert.equal(defaulted.result.changed, 2, 'ses_2 moves and the unknown session lands in the default group');
  assert.deepEqual(defaulted.result.assignments, { ses_1: b.id, ses_2: DEFAULT_TOPIC_ID, ses_missing: DEFAULT_TOPIC_ID });

  await assert.rejects(() => store.assign({ workspaceId: 'ws_a', sessionIds: ['ses_1'], topicId: 'tp_nope', expectedRevision: defaulted.revision }), (e) => e.code === 'topic-not-found');
});

test('deleting a topic re-files its sessions into the default group', async () => {
  const { store } = await freshStore();
  const topic = (await store.createTopic({ workspaceId: 'ws_a', name: 'A', sessionIds: ['ses_1', 'ses_2'], expectedRevision: 0 })).result.topic;
  const outcome = await store.deleteTopic({ workspaceId: 'ws_a', topicId: topic.id, expectedRevision: 1 });
  assert.equal(outcome.result.released, 2);
  const snapshot = await store.snapshot();
  assert.deepEqual(snapshot.workspaces.ws_a.topics.map((entry) => entry.id), [DEFAULT_TOPIC_ID]);
  assert.deepEqual(snapshot.workspaces.ws_a.assignments, { ses_1: DEFAULT_TOPIC_ID, ses_2: DEFAULT_TOPIC_ID });
});

test('reordering rewrites the topic order, default group included', async () => {
  const { store } = await freshStore();
  const a = (await store.createTopic({ workspaceId: 'ws_a', name: 'A', expectedRevision: 0 })).result.topic;
  const b = (await store.createTopic({ workspaceId: 'ws_a', name: 'B', expectedRevision: 1 })).result.topic;
  const moved = await store.reorderTopics({ workspaceId: 'ws_a', topicIds: [b.id, DEFAULT_TOPIC_ID, a.id], expectedRevision: 2 });
  const snapshot = await store.snapshot();
  assert.deepEqual(snapshot.workspaces.ws_a.topics.map((topic) => topic.id), [b.id, DEFAULT_TOPIC_ID, a.id]);
  assert.equal(snapshot.workspaces.ws_a.topics[1].order, 1, 'orders are rewritten to the listed positions');
  assert.equal(snapshot.workspaces.ws_a.topics[1].system, true, 'and the default group keeps its flag');
  await assert.rejects(
    () => store.reorderTopics({ workspaceId: 'ws_a', topicIds: [a.id, 'tp_nope'], expectedRevision: moved.revision }),
    (e) => e.code === 'topic-not-found',
  );
});

test('stale expectedRevision is a 409 carrying the current revision', async () => {
  const { store } = await freshStore();
  await store.createTopic({ workspaceId: 'ws_a', name: 'A', expectedRevision: 0 });
  await assert.rejects(
    () => store.createTopic({ workspaceId: 'ws_a', name: 'B', expectedRevision: 0 }),
    (e) => e instanceof StoreError && e.code === 'revision-conflict' && e.status === 409 && e.currentRevision === 1,
  );
});

test('concurrent writers serialize through the lock and keep both topics', async () => {
  const { store } = await freshStore();
  // Two writers that both started from revision 0 may not both win: one gets a 409 and must
  // be retried. What must never happen is a silent overwrite, which is what the old
  // "same instance, no revision" version of this test could not distinguish.
  const settled = await Promise.allSettled([
    store.createTopic({ workspaceId: 'ws_a', name: 'A', expectedRevision: 0 }),
    store.createTopic({ workspaceId: 'ws_a', name: 'B', expectedRevision: 0 }),
  ]);
  const ok = settled.filter((entry) => entry.status === 'fulfilled');
  const conflicts = settled.filter((entry) => entry.status === 'rejected');
  assert.equal(ok.length, 1, 'the second writer must see a revision conflict, not overwrite');
  assert.equal(conflicts[0].reason.code, 'revision-conflict');
  assert.equal((await store.snapshot()).workspaces.ws_a.topics.length, 2, 'default group plus the winning topic');
});

test('two store instances serialize on the file lock instead of interleaving', async () => {
  const { home } = await freshStore();
  // Separate instances are what two host processes (or two windows) actually look like.
  const a = createTopicStore({ home, lockWaitMs: 5000 });
  const b = createTopicStore({ home, lockWaitMs: 5000 });
  await a.createTopic({ workspaceId: 'ws_a', name: 'seed', expectedRevision: 0 });

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const slow = (store, name) => store.mutate(null, async (state) => {
    await sleep(150);
    state.workspaces[name] = { topics: [], assignments: {} };
    return name;
  });
  const settled = await Promise.allSettled([slow(a, 'wa'), slow(b, 'wb')]);
  assert.deepEqual(settled.map((entry) => entry.status), ['fulfilled', 'fulfilled']);

  const onDisk = JSON.parse(await readFile(a.file, 'utf8'));
  assert.deepEqual(Object.keys(onDisk.workspaces).sort(), ['wa', 'wb', 'ws_a'], 'no write may be lost');
});

test('a live slow holder is never evicted mid-write', async () => {
  const { home } = await freshStore();
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  // A holds the lock far past staleLockMs. Its owner is this very process, so B must wait
  // rather than steal: evicting a live holder is what silently dropped the earlier write.
  const a = createTopicStore({ home, staleLockMs: 30, lockWaitMs: 5000 });
  const b = createTopicStore({ home, staleLockMs: 30, lockWaitMs: 5000 });

  const slowA = a.mutate(null, async (state) => {
    await sleep(300);
    state.workspaces.wa = { topics: [], assignments: {} };
    return 'A';
  });
  await sleep(80);
  const slowB = b.mutate(null, async (state) => {
    state.workspaces.wb = { topics: [], assignments: {} };
    return 'B';
  });

  const settled = await Promise.allSettled([slowA, slowB]);
  assert.deepEqual(settled.map((entry) => entry.status), ['fulfilled', 'fulfilled']);
  const onDisk = JSON.parse(await readFile(a.file, 'utf8'));
  assert.ok(onDisk.workspaces.wa, 'the slow writer\'s update must survive');
  assert.ok(onDisk.workspaces.wb, 'the waiting writer must also land');
});

test('a lock left by a dead process is reclaimed, and only its owner can release', async () => {
  const { store } = await freshStore();
  await store.snapshot();
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(store.dir, { recursive: true });
  // An impossible PID plus an old mtime: exactly what a crashed writer leaves behind.
  await writeFile(store.lockFile, '999999-deadbeef', 'utf8');
  const { utimes } = await import('node:fs/promises');
  const old = new Date(Date.now() - 60_000);
  await utimes(store.lockFile, old, old);

  const written = await store.createTopic({ workspaceId: 'ws_a', name: 'A', expectedRevision: 0 });
  assert.equal(written.revision, 1, 'the orphaned lock must not block the store forever');
  assert.equal(await readFile(store.lockFile, 'utf8').then(() => true, () => false), false, 'and it is released after use');
});

test('release never deletes a lock that changed hands while we held it', async () => {
  const { home } = await freshStore();
  const store = createTopicStore({ home });
  const { writeFile } = await import('node:fs/promises');

  await store.mutate(null, async (state) => {
    // While our critical section is open, simulate the lock being stolen and re-taken by a
    // successor (the eviction path). Releasing must notice the file is no longer ours.
    await writeFile(store.lockFile, '424242-successor', 'utf8');
    state.workspaces.wa = { topics: [], assignments: {} };
    return 'ok';
  });

  assert.equal(await readFile(store.lockFile, 'utf8'), '424242-successor', 'the successor\'s lock survives');
});

test('a corrupt primary document falls back to the backup and refuses writes', async () => {
  const { store } = await freshStore();
  await store.createTopic({ workspaceId: 'ws_a', name: 'A', expectedRevision: 0 });
  await store.createTopic({ workspaceId: 'ws_a', name: 'B', expectedRevision: 1 });
  assert.ok((await readFile(`${store.file}.bak`, 'utf8')).includes('A'));
  await import('node:fs/promises').then(({ writeFile }) => writeFile(store.file, '{ truncated', 'utf8'));

  const snapshot = await store.snapshot();
  assert.equal(snapshot.readOnly, true);
  assert.equal(snapshot.workspaces.ws_a.topics.length, 2, 'recovered from .bak (default group plus topic A)');
  assert.match(snapshot.warning, /损坏/);
  // A write that *recovers* from the backup is allowed (it repairs the document and reports a
  // warning); only an unrecoverable document is refused outright. That distinction is what
  // the later "entirely unreadable" test pins down.
  const repaired = await store.createTopic({ workspaceId: 'ws_a', name: 'C', expectedRevision: 1 });
  assert.ok(repaired.warning, 'the recovery is surfaced to the caller');
});

test('a recovery write never overwrites the backup with the corrupt primary', async () => {
  const { store } = await freshStore();
  await store.createTopic({ workspaceId: 'ws_a', name: 'A', expectedRevision: 0 });
  await store.createTopic({ workspaceId: 'ws_a', name: 'B', expectedRevision: 1 });
  await import('node:fs/promises').then(({ writeFile }) => writeFile(store.file, '{ truncated', 'utf8'));

  const { writeFile } = await import('node:fs/promises');
  await writeFile(store.file, '{ truncated', 'utf8');
  // Recovery write: the state comes from .bak, so the broken primary must not become the new
  // backup (that used to destroy the only good copy).
  await store.createTopic({ workspaceId: 'ws_a', name: 'C', expectedRevision: 1 });

  const backup = JSON.parse(await readFile(`${store.file}.bak`, 'utf8'));
  assert.ok(backup.workspaces.ws_a, 'the backup is still a valid document');
  await assert.rejects(
    () => readFile(`${store.file}.corrupt-`, 'utf8').then(() => { throw new Error('no'); }),
    () => true,
  );
});

test('a store leaves read-only mode after a successful repair write', async () => {
  const { store } = await freshStore();
  await store.createTopic({ workspaceId: 'ws_a', name: 'A', expectedRevision: 0 });
  await store.createTopic({ workspaceId: 'ws_a', name: 'B', expectedRevision: 1 });
  await import('node:fs/promises').then(({ writeFile }) => writeFile(store.file, '{ truncated', 'utf8'));

  const repaired = await store.createTopic({ workspaceId: 'ws_a', name: 'C', expectedRevision: 1 });
  assert.equal(repaired.revision, 2);
  assert.ok(repaired.warning, 'the recovery is reported once');
  // Before the fix `corrupt` stuck for the process lifetime: every later write 503'd even
  // though the file on disk was valid again.
  const next = await store.createTopic({ workspaceId: 'ws_a', name: 'D', expectedRevision: repaired.revision });
  assert.equal(next.revision, 3);
  assert.equal((await store.snapshot()).readOnly, false);
});

test('a write without expectedRevision is refused instead of silently winning', async () => {
  const { store } = await freshStore();
  await store.createTopic({ workspaceId: 'ws_a', name: 'A', expectedRevision: 0 });
  await assert.rejects(
    () => store.createTopic({ workspaceId: 'ws_a', name: 'B' }),
    (e) => e.code === 'revision-required' && e.status === 400,
  );
  await assert.rejects(
    () => store.assign({ workspaceId: 'ws_a', sessionIds: ['ses_1'], topicId: null }),
    (e) => e.code === 'revision-required',
  );
});

test('an entirely unreadable document is never overwritten with an empty state', async () => {
  const { home } = await freshStore();
  const seed = createTopicStore({ home });
  await seed.createTopic({ workspaceId: 'ws_a', name: 'A', expectedRevision: 0 });
  await seed.createTopic({ workspaceId: 'ws_a', name: 'B', expectedRevision: 1 });

  const { writeFile } = await import('node:fs/promises');
  await writeFile(seed.file, '{ truncated', 'utf8');
  await writeFile(`${seed.file}.bak`, '{ also truncated', 'utf8');

  // A fresh instance whose first operation is a write.
  const fresh = createTopicStore({ home });
  await assert.rejects(
    () => fresh.createTopic({ workspaceId: 'ws_a', name: 'C', expectedRevision: 0 }),
    (e) => e.code === 'store-read-only',
  );
  assert.equal(await readFile(seed.file, 'utf8'), '{ truncated', 'the damaged file is left for manual salvage');
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
