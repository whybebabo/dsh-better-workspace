import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, utimes, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTopicStore, StoreError, validateSessionIds, normalizeTopicName, normalizeTopicEmoji, pickTopicEmoji, TOPIC_EMOJIS, DEFAULT_TOPIC_ID } from '../lib/store.js';

async function freshStore(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-topic-store-'));
  const home = join(dir, 'home');
  return { dir, home, store: createTopicStore({ home, ...options }) };
}

const sampleIds = (n) => Array.from({ length: n }, (_, index) => `ses_test${index}`);

test('a missing file reads as an empty writable state', async () => {
  const { store } = await freshStore();
  const snapshot = await store.snapshot();
  assert.equal(snapshot.revision, 0);
  assert.equal(snapshot.readOnly, false);
  assert.deepEqual(Object.keys(snapshot.workspaces), []);
});

test('a missing primary recovers the readable backup instead of starting empty', async () => {
  const { store } = await freshStore();
  await store.createTopic({ workspaceId: 'ws_a', name: 'Alpha', expectedRevision: 0 });
  await store.createTopic({ workspaceId: 'ws_a', name: 'Beta', expectedRevision: 1 });
  const backupBefore = await readFile(store.bakFile, 'utf8');
  await rm(store.file);

  const snapshot = await store.snapshot();
  assert.equal(snapshot.readOnly, false, 'a readable backup keeps the store writable');
  assert.equal(snapshot.warningCode, 'recovered-backup');
  assert.match(snapshot.warning, /主文件缺失/);
  assert.ok(snapshot.workspaces.ws_a.topics.some((topic) => topic.name === 'Alpha'), 'the backup data is surfaced');

  // The recovery write must not replace the only good copy with the new (empty) document.
  const first = await store.createTopic({ workspaceId: 'ws_a', name: 'Gamma', expectedRevision: snapshot.revision });
  assert.equal(await readFile(store.bakFile, 'utf8'), backupBefore, 'the recovery write leaves the good backup alone');

  // A later write may rotate the backup again, but by then it holds the repaired document.
  await store.createTopic({ workspaceId: 'ws_a', name: 'Delta', expectedRevision: first.revision });
  const backupAfter = JSON.parse(await readFile(store.bakFile, 'utf8'));
  assert.ok(backupAfter.workspaces.ws_a.topics.some((topic) => topic.name === 'Alpha'), 'the old topics survive in the rotated backup');
  assert.ok(backupAfter.workspaces.ws_a.topics.some((topic) => topic.name === 'Gamma'));
});

test('a missing primary with a newer backup is read-only, not a fresh document', async () => {
  const { store } = await freshStore();
  await store.createTopic({ workspaceId: 'ws_a', name: 'A', expectedRevision: 0 });
  await store.createTopic({ workspaceId: 'ws_a', name: 'B', expectedRevision: 1 });
  await rm(store.file);
  const backup = JSON.parse(await readFile(store.bakFile, 'utf8'));
  backup.version = 2;
  await writeFile(store.bakFile, JSON.stringify(backup), 'utf8');

  const snapshot = await store.snapshot();
  assert.equal(snapshot.readOnly, true);
  assert.equal(snapshot.warningCode, 'future-version');
  assert.match(snapshot.warning, /版本 2/);
  await assert.rejects(
    () => store.createTopic({ workspaceId: 'ws_a', name: 'C', expectedRevision: 0 }),
    (error) => error.code === 'store-future-version' && error.status === 503,
  );
  assert.equal(JSON.parse(await readFile(store.bakFile, 'utf8')).version, 2, 'the newer backup is untouched');
});

test('a missing primary with a corrupt backup is read-only, never treated as fresh', async () => {
  const { store } = await freshStore();
  await store.createTopic({ workspaceId: 'ws_a', name: 'A', expectedRevision: 0 });
  await store.createTopic({ workspaceId: 'ws_a', name: 'B', expectedRevision: 1 });
  await rm(store.file);
  await writeFile(store.bakFile, '{ broken', 'utf8');

  const snapshot = await store.snapshot();
  assert.equal(snapshot.readOnly, true);
  assert.equal(snapshot.warningCode, 'unreadable');
  await assert.rejects(
    () => store.createTopic({ workspaceId: 'ws_a', name: 'C', expectedRevision: 0 }),
    (error) => error.code === 'store-read-only' && error.status === 503,
  );
  assert.equal(await readFile(store.bakFile, 'utf8'), '{ broken', 'the unreadable backup is left for manual salvage');
});

test('a corrupt primary with a newer backup reports the version instead of "unreadable"', async () => {
  const { store } = await freshStore();
  await store.createTopic({ workspaceId: 'ws_a', name: 'A', expectedRevision: 0 });
  await store.createTopic({ workspaceId: 'ws_a', name: 'B', expectedRevision: 1 });
  await writeFile(store.file, '{ broken', 'utf8');
  const backup = JSON.parse(await readFile(store.bakFile, 'utf8'));
  backup.version = 2;
  await writeFile(store.bakFile, JSON.stringify(backup), 'utf8');

  const snapshot = await store.snapshot();
  assert.equal(snapshot.readOnly, true);
  assert.equal(snapshot.warningCode, 'future-version');
  await assert.rejects(
    () => store.createTopic({ workspaceId: 'ws_a', name: 'C', expectedRevision: 0 }),
    (error) => error.code === 'store-future-version' && error.status === 503,
  );
});

test('one bad emoji field does not discard the rest of the document', async () => {
  const { store } = await freshStore();
  await store.createTopic({ workspaceId: 'ws_a', name: 'Alpha', expectedRevision: 0 });
  await store.createTopic({ workspaceId: 'ws_a', name: 'Beta', expectedRevision: 1 });
  const doc = JSON.parse(await readFile(store.file, 'utf8'));
  const beta = doc.workspaces.ws_a.topics.find((topic) => topic.name === 'Beta');
  beta.emoji = 123;
  await writeFile(store.file, JSON.stringify(doc), 'utf8');

  const snapshot = await store.snapshot();
  assert.equal(snapshot.readOnly, false);
  assert.equal(snapshot.warningCode, null, 'a single bad field is not document damage');
  assert.ok(snapshot.workspaces.ws_a.topics.some((topic) => topic.name === 'Alpha'));
  assert.equal(snapshot.workspaces.ws_a.topics.find((topic) => topic.name === 'Beta')?.emoji, '', 'the bad marker is normalized');
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
  assert.equal(onDisk.workspaces.ws_a.topics[0].name, '排查', 'the newest topic leads the list');
  assert.equal(onDisk.workspaces.ws_a.topics.at(-1).id, DEFAULT_TOPIC_ID);
  assert.equal(onDisk.workspaces.ws_a.topics.at(-1).system, true);
});

test('new topics are inserted above the existing ones', async () => {
  const { store } = await freshStore();
  const a = (await store.createTopic({ workspaceId: 'ws_a', name: 'A', expectedRevision: 0 })).result.topic;
  const b = (await store.createTopic({ workspaceId: 'ws_a', name: 'B', expectedRevision: 1 })).result.topic;
  const listed = (await store.snapshot()).workspaces.ws_a.topics;
  assert.deepEqual(listed.map((topic) => topic.name), ['B', 'A', '默认分组']);
  assert.ok(listed[0].order < listed[1].order, 'the newcomer takes the lowest order');
  assert.equal(b.order, a.order - 1, 'each new topic slots in above the previous one');
  assert.equal(listed.at(-1).order, -1, 'existing orders stay untouched');
});

test('the default group exists in every snapshot and cannot be renamed or deleted', async () => {
  const { store } = await freshStore();
  const snapshot = await store.createTopic({ workspaceId: 'ws_a', name: 'A', expectedRevision: 0 });
  const listed = (await store.snapshot()).workspaces.ws_a.topics;
  assert.equal(listed[0].name, 'A', 'the new topic leads the list');
  assert.ok(listed.some((topic) => topic.id === DEFAULT_TOPIC_ID), 'the default group is always present');

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
  assert.equal(again.revision, first.revision, 'a no-op keeps the revision other windows hold');
  assert.equal(JSON.parse(await readFile(store.file, 'utf8')).revision, first.revision, 'and is not written to disk');

  const moved = await store.assign({ workspaceId: 'ws_a', sessionIds: ['ses_1'], topicId: b.id, expectedRevision: again.revision });
  assert.deepEqual(moved.result, { topicId: b.id, changed: 1 }, 'the response carries the delta, not the whole assignment map');
  assert.deepEqual(
    JSON.parse(await readFile(store.file, 'utf8')).workspaces.ws_a.assignments,
    { ses_1: b.id, ses_2: a.id },
    'and the document holds the move',
  );

  const defaulted = await store.assign({ workspaceId: 'ws_a', sessionIds: ['ses_2', 'ses_missing'], topicId: null, expectedRevision: moved.revision });
  assert.equal(defaulted.result.topicId, DEFAULT_TOPIC_ID, 'null resolves to the reserved default group');
  assert.equal(defaulted.result.changed, 2, 'ses_2 moves and the unknown session lands in the default group');
  assert.deepEqual(
    JSON.parse(await readFile(store.file, 'utf8')).workspaces.ws_a.assignments,
    { ses_1: b.id, ses_2: DEFAULT_TOPIC_ID, ses_missing: DEFAULT_TOPIC_ID },
  );

  await assert.rejects(() => store.assign({ workspaceId: 'ws_a', sessionIds: ['ses_1'], topicId: 'tp_nope', expectedRevision: defaulted.revision }), (e) => e.code === 'topic-not-found');
});

test('renaming to the same name and re-dropping in place are not writes', async () => {
  const { store } = await freshStore();
  const a = (await store.createTopic({ workspaceId: 'ws_a', name: 'A', expectedRevision: 0 })).result.topic;
  await store.createTopic({ workspaceId: 'ws_a', name: 'B', expectedRevision: 1 });

  const sameName = await store.updateTopic({ workspaceId: 'ws_a', topicId: a.id, name: 'A', emoji: a.emoji, expectedRevision: 2 });
  assert.equal(sameName.revision, 2, 'a same-name update keeps the revision other windows hold');
  assert.equal(JSON.parse(await readFile(store.file, 'utf8')).revision, 2, 'and is not written to disk');

  // The stored orders are not 0..n-1 yet, so this reorder would renumber them without moving
  // anything: the sequence is what decides, not the numbers behind it.
  const order = (await store.snapshot()).workspaces.ws_a.topics.map((topic) => topic.id);
  const sameOrder = await store.reorderTopics({ workspaceId: 'ws_a', topicIds: order, expectedRevision: 2 });
  assert.equal(sameOrder.revision, 2, 'a drop that lands in place is not a write');

  const moved = await store.reorderTopics({ workspaceId: 'ws_a', topicIds: [...order].reverse(), expectedRevision: 2 });
  assert.equal(moved.revision, 3, 'a real reorder still writes');
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

test('stale eviction never unlinks a lock that a successor installed underneath it', async () => {
  const { home } = await freshStore();
  const { mkdir, writeFile, rename, utimes } = await import('node:fs/promises');
  const { createRequire, syncBuiltinESMExports } = await import('node:module');
  // A short wait makes the failed reclaim observable without slowing the suite down.
  const store = createTopicStore({ home, staleLockMs: 30, lockWaitMs: 400 });
  await mkdir(store.dir, { recursive: true });
  await writeFile(store.lockFile, '999999-deadbeef', 'utf8');
  const old = new Date(Date.now() - 60_000);
  await utimes(store.lockFile, old, old);

  const require = createRequire(import.meta.url);
  const fsp = require('node:fs/promises');
  const realLink = fsp.link;
  // The eviction path hard-links the lock it inspected, then decides. Replace the *path*
  // (new inode, like a successor's `open('wx')`) right after that link: the claim now points
  // at the dead lock while the path holds a fresh one, and only an identity check can tell.
  fsp.link = async (from, to) => {
    await realLink(from, to);
    if (String(from) !== store.lockFile) return;
    const successor = `${store.lockFile}.successor`;
    await writeFile(successor, '424242-successor', 'utf8');
    await rename(successor, store.lockFile);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      () => store.createTopic({ workspaceId: 'ws_a', name: 'A', expectedRevision: 0 }),
      (error) => error instanceof StoreError && error.code === 'store-locked',
      'the reclaimer must give up rather than wait on a lock it cannot prove is stale',
    );
  } finally {
    fsp.link = realLink;
    syncBuiltinESMExports();
  }
  assert.equal(await readFile(store.lockFile, 'utf8'), '424242-successor', 'the successor\'s lock is untouched');
});

test('a corrupt primary document falls back to the backup and stays writable', async () => {
  const { store } = await freshStore();
  await store.createTopic({ workspaceId: 'ws_a', name: 'A', expectedRevision: 0 });
  await store.createTopic({ workspaceId: 'ws_a', name: 'B', expectedRevision: 1 });
  assert.ok((await readFile(`${store.file}.bak`, 'utf8')).includes('A'));
  await import('node:fs/promises').then(({ writeFile }) => writeFile(store.file, '{ truncated', 'utf8'));

  const snapshot = await store.snapshot();
  // Readable *and* writable: the next successful write rebuilds the primary. Reporting this as
  // read-only told users their edits could not land when they could, and hid the real reason.
  assert.equal(snapshot.readOnly, false);
  assert.equal(snapshot.warningCode, 'recovered-backup');
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

test('an external repair clears the read-only snapshot without a write', async () => {
  const { store } = await freshStore();
  await store.createTopic({ workspaceId: 'ws_a', name: 'A', expectedRevision: 0 });
  await store.createTopic({ workspaceId: 'ws_a', name: 'B', expectedRevision: 1 });
  const { writeFile } = await import('node:fs/promises');
  await writeFile(store.file, '{ truncated', 'utf8');
  const damaged = await store.snapshot();
  assert.equal(damaged.warningCode, 'recovered-backup', 'the broken primary is reported');
  assert.equal(damaged.readOnly, false, 'but it is writable: the backup is readable');

  // Repair the document outside the store, exactly as a user or a sync tool would.
  const backup = await readFile(`${store.file}.bak`, 'utf8');
  await writeFile(store.file, backup, 'utf8');
  const snapshot = await store.snapshot();
  assert.equal(snapshot.readOnly, false, 'the next readable snapshot is not stuck on the old corruption');
  assert.equal(snapshot.warning, null);
  assert.equal(snapshot.warningCode, null);
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

test('a document written by a newer plugin is read-only, never downgraded', async () => {
  const { store } = await freshStore();
  const doc = (version, revision) => JSON.stringify({ version, revision, updatedAt: 1, workspaces: {} });
  await mkdir(store.dir, { recursive: true });
  // A perfectly good v1 backup exists: it must NOT be used as a "recovery" source, because
  // writing it back would silently discard whatever the newer plugin stored.
  await writeFile(store.bakFile, doc(1, 3), 'utf8');
  await writeFile(store.file, doc(2, 7), 'utf8');

  const snapshot = await store.snapshot();
  assert.equal(snapshot.readOnly, true, 'an unknown version is not writable');
  assert.equal(snapshot.warningCode, 'future-version');
  assert.match(snapshot.warning, /版本 2/);

  await assert.rejects(
    () => store.assign({ workspaceId: 'ws_a', sessionIds: ['ses_1'], topicId: null, expectedRevision: 0 }),
    (error) => error.code === 'store-future-version' && error.status === 503,
  );
  assert.equal(JSON.parse(await readFile(store.file, 'utf8')).version, 2, 'the newer document is untouched');
  assert.equal(JSON.parse(await readFile(store.file, 'utf8')).revision, 7);
  assert.equal(JSON.parse(await readFile(store.bakFile, 'utf8')).version, 1, 'and the backup is not overwritten either');
});

test('a parseable document without a valid version is damage, not a future version', async () => {
  const cases = [
    ['missing', JSON.stringify({ revision: 3, updatedAt: 1, workspaces: {} })],
    ['zero', JSON.stringify({ version: 0, revision: 3, updatedAt: 1, workspaces: {} })],
    ['string', JSON.stringify({ version: '1', revision: 3, updatedAt: 1, workspaces: {} })],
  ];
  for (const [label, doc] of cases) {
    const { store } = await freshStore();
    await store.createTopic({ workspaceId: 'ws_a', name: 'A', expectedRevision: 0 });
    await store.createTopic({ workspaceId: 'ws_a', name: 'B', expectedRevision: 1 });
    await writeFile(store.file, doc, 'utf8');

    const snapshot = await store.snapshot();
    assert.equal(snapshot.readOnly, false, `${label}: a readable backup keeps the store writable`);
    assert.equal(snapshot.warningCode, 'recovered-backup', `${label}: this is damage, not "future data"`);
    assert.ok(snapshot.workspaces.ws_a.topics.some((topic) => topic.name === 'A'), `${label}: the backup data is surfaced`);

    const repaired = await store.createTopic({ workspaceId: 'ws_a', name: `C-${label}`, expectedRevision: snapshot.revision });
    assert.ok(repaired.revision > snapshot.revision);
    assert.equal(JSON.parse(await readFile(store.file, 'utf8')).version, 1, `${label}: the next write rebuilds a v1 primary`);
  }
});

test('a malformed version without a backup is read-only, never misreported as a newer plugin', async () => {
  const { store } = await freshStore();
  await mkdir(store.dir, { recursive: true });
  await writeFile(store.file, JSON.stringify({ revision: 1, updatedAt: 1, workspaces: {} }), 'utf8');

  const snapshot = await store.snapshot();
  assert.equal(snapshot.readOnly, true);
  assert.equal(snapshot.warningCode, 'unreadable', 'no backup: unreadable, not future-version');
  await assert.rejects(
    () => store.createTopic({ workspaceId: 'ws_a', name: 'A', expectedRevision: 0 }),
    (error) => error.code === 'store-read-only' && error.status === 503,
  );
});

test('a primary recovered from the backup stays writable and reports the recovery', async () => {
  const { store } = await freshStore();
  await store.createTopic({ workspaceId: 'ws_a', name: 'A', expectedRevision: 0 });
  await store.createTopic({ workspaceId: 'ws_a', name: 'B', expectedRevision: 1 });
  await writeFile(store.file, '{ truncated', 'utf8');

  const snapshot = await store.snapshot();
  assert.equal(snapshot.readOnly, false, 'the backup is readable, and the next write rebuilds the primary');
  assert.equal(snapshot.warningCode, 'recovered-backup');
  assert.match(snapshot.warning, /已回退到备份/);

  const written = await store.createTopic({ workspaceId: 'ws_a', name: 'C', expectedRevision: snapshot.revision });
  assert.ok(written.revision > snapshot.revision);
  const rebuilt = JSON.parse(await readFile(store.file, 'utf8'));
  assert.equal(rebuilt.version, 1, 'the primary is valid again');
  assert.ok(rebuilt.workspaces.ws_a.topics.some((topic) => topic.name === 'C'));
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

test('reordering refuses duplicate topic ids instead of applying the last slot', async () => {
  const { store } = await freshStore();
  await assert.rejects(
    () => store.reorderTopics({ workspaceId: 'ws_a', topicIds: [DEFAULT_TOPIC_ID, DEFAULT_TOPIC_ID], expectedRevision: 0 }),
    (error) => error.code === 'bad-topic-ids',
  );
});

test('a lock held by a live process is waited out, never stolen', async () => {
  const { store } = await freshStore({ staleLockMs: 100, lockWaitMs: 400 });
  await store.snapshot();
  await mkdir(store.dir, { recursive: true });
  // A *different* live PID. A token carrying this process's own PID no longer proves a live
  // holder by itself: the store grants that only to a token it currently holds itself (see
  // the leaked-release case below), so the synthetic same-PID lock would be reclaimable.
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
  try {
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    await writeFile(store.lockFile, `${child.pid}-deadbeef`, 'utf8');
    const old = new Date(Date.now() - 60_000);
    await utimes(store.lockFile, old, old);

    const started = Date.now();
    await assert.rejects(
      () => store.createTopic({ workspaceId: 'ws_a', name: 'A', expectedRevision: 0 }),
      (error) => error.code === 'store-locked' && error.status === 409,
    );
    assert.ok(Date.now() - started >= 300, 'it waits for the holder instead of evicting it mid-write');
    assert.equal(await readFile(store.lockFile, 'utf8'), `${child.pid}-deadbeef`, 'and the live lock survives');
  } finally {
    child.kill();
  }
});

test('a zero-byte lock left by a crash is reclaimed, not waited on forever', async () => {
  const { store } = await freshStore({ staleLockMs: 30, lockWaitMs: 1_000 });
  await store.snapshot();
  await mkdir(store.dir, { recursive: true });
  // What a crash between open('wx') and writeFile(token) leaves behind. Its token cannot name
  // a live owner, so the stale branch must reclaim it; before the fix every write waited out
  // the full lock deadline and returned 409.
  await writeFile(store.lockFile, '', 'utf8');
  const old = new Date(Date.now() - 60_000);
  await utimes(store.lockFile, old, old);

  const written = await store.createTopic({ workspaceId: 'ws_a', name: 'A', expectedRevision: 0 });
  assert.equal(written.revision, 1);
  assert.equal(await readFile(store.lockFile, 'utf8').then(() => true, () => false), false, 'and the lock is released after use');
});

test('a stale lock this process failed to unlink is reclaimed instead of blocking forever', async () => {
  const { store } = await freshStore({ staleLockMs: 30, lockWaitMs: 1_000 });
  await store.snapshot();
  await mkdir(store.dir, { recursive: true });
  // A release that could not unlink leaves a token with *this* PID. It is not "a live holder":
  // no acquisition holds it, so the next writer must be able to reclaim it after the window.
  await writeFile(store.lockFile, `${process.pid}-deadbeef`, 'utf8');
  const old = new Date(Date.now() - 60_000);
  await utimes(store.lockFile, old, old);

  const written = await store.createTopic({ workspaceId: 'ws_a', name: 'A', expectedRevision: 0 });
  assert.equal(written.revision, 1);
});
