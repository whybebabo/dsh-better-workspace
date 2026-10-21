/**
 * Cross-process serialization.
 *
 * The store's lock exists for two *host processes* (two DSH windows, the Desktop shell plus a
 * `dsh web` server) writing one `topics.v1.json`. The other serialization tests in this file use
 * two store objects inside one process, which cannot distinguish a file lock from an in-process
 * mutex: replacing `acquireLock` with a `Promise` chain shared through `globalThis` keeps them
 * green while two real processes lose writes. Run the writers in separate OS processes so a
 * regression to process-local mutual exclusion fails here.
 *
 * The child is this same file (`WORKER=1`), forked so each writer has its own module instance
 * and its own PID — the token in the lock file is `<pid>-<rand>`, so the two writers are
 * genuinely distinct owners.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);

/**
 * Worker half. Each write is a read-modify-write of the whole document through
 * `store.mutate`, which is exactly the section the lock protects.
 */
if (process.env.DSH_STORE_WRITER === '1') {
  const { createTopicStore } = await import('../lib/store.js');
  const store = createTopicStore({
    dir: process.env.DSH_STORE_DIR,
    // Short timeouts keep the test fast while still exercising the wait/retry loop.
    staleLockMs: 500,
    lockWaitMs: 60_000,
  });
  const name = process.env.DSH_STORE_WRITER_NAME;
  const rounds = Number(process.env.DSH_STORE_WRITER_ROUNDS ?? 10);
  const failures = [];
  for (let index = 0; index < rounds; index += 1) {
    try {
      await store.mutate(null, (state) => {
        const bucket = state.workspaces.ws_shared ?? (state.workspaces.ws_shared = { topics: [], assignments: {} });
        bucket.topics.push({
          id: `tp_${name}_${index}`,
          name: `${name}-${index}`,
          emoji: '',
          order: bucket.topics.length,
          createdAt: Date.now(),
        });
        return {};
      });
    } catch (error) {
      failures.push(`${name}#${index}: ${error?.code ?? ''} ${error?.message ?? error}`);
    }
  }
  console.log(JSON.stringify({ name, written: rounds - failures.length, failures }));
  process.exit(failures.length === 0 ? 0 : 1);
}

function runWriter(dir, name, rounds) {
  return new Promise((resolve) => {
    const child = fork(SELF, {
      env: { ...process.env, DSH_STORE_WRITER: '1', DSH_STORE_DIR: dir, DSH_STORE_WRITER_NAME: name, DSH_STORE_WRITER_ROUNDS: String(rounds) },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let out = '';
    child.stdout?.on('data', (chunk) => { out += chunk; });
    child.stderr?.on('data', (chunk) => { out += chunk; });
    child.on('exit', (code) => {
      const line = out.trim().split('\n').filter(Boolean).at(-1) ?? '';
      let report = null;
      try { report = JSON.parse(line); } catch { report = { name, written: 0, failures: [line] }; }
      resolve({ code, ...report, raw: out });
    });
  });
}

test('two OS processes never lose each other\'s writes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-topic-store-xproc-'));
  try {
    const rounds = 10;
    // Start both before either can finish, so the two writers genuinely contend.
    const results = await Promise.all([runWriter(dir, 'wa', rounds), runWriter(dir, 'wb', rounds)]);
    for (const result of results) {
      assert.equal(result.code, 0, `${result.name} exited cleanly: ${result.raw.trim().slice(-400)}`);
      assert.deepEqual(result.failures, [], `${result.name} saw no lock failure`);
    }

    const document = JSON.parse(await readFile(join(dir, 'topics.v1.json'), 'utf8'));
    const names = document.workspaces.ws_shared.topics.map((topic) => topic.name);
    const written = results.reduce((total, result) => total + result.written, 0);
    assert.equal(written, rounds * 2, 'both writers completed every round');
    // The default group is persisted alongside the writes; every write must appear exactly once.
    assert.equal(document.workspaces.ws_shared.topics.length, written + 1, `no write was lost (got ${names.join(',')})`);
    assert.equal(new Set(names).size, names.length, 'and none was applied twice');
    // The revision counts committed writes, so a lost update shows up here too.
    assert.equal(document.revision, written, 'revision equals the number of committed writes');
    // A leaked lock outlives the test as a permanent "store busy" for the user.
    const leftovers = (await readdir(dir)).filter((name) => name.includes('.lock') || name.includes('.stale'));
    assert.deepEqual(leftovers, [], 'no lock or stale claim is left behind');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
