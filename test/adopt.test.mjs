/**
 * Workspace membership repair (`lib/adopt.js`).
 *
 * The failure this guards: a session whose artifact `cwd` is a registered workspace path but
 * which the host never accounted is shown under 未分组, and stays there after the plugin is
 * removed. The repair must re-attach exactly those sessions and nothing else — never a
 * subagent child, never an archived session, never a session that is already accounted, and
 * never one whose cwd does not resolve to a workspace.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adoptOrphanSessions } from '../lib/adopt.js';

function fakeRegistry(workspaces, { archived = [], tableRecords = null, withTable = true } = {}) {
  const entities = workspaces.map((entry) => {
    const record = { path: entry.path, sessionIds: [...(entry.sessionIds ?? [])] };
    return {
      id: entry.id,
      get path() { return record.path; },
      get sessionIds() { return record.sessionIds; },
      attachSession: entry.attach ?? (async (id) => { record.sessionIds = [id, ...record.sessionIds]; }),
      record,
    };
  });
  // 0.2.1 always exposes the raw record table (`registry.table`). The fake therefore mirrors the
  // entities by default; `tableRecords` overrides it (a stale snapshot) and `withTable: false`
  // models a composition without one, which the repair must refuse to guess on.
  const records = tableRecords ?? new Map(entities.map((entity) => [entity.id, entity.record]));
  const table = withTable ? {
    keys: () => [...records.keys()],
    get: (key) => records.get(key),
  } : undefined;
  return {
    list: () => entities,
    archivedSessionIds: archived,
    entities,
    ...(table ? { table } : {}),
  };
}

function fakePersistence(headers) {
  return { list: async () => headers.map((header) => ({ header })) };
}

async function withDirs(fn) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-adopt-'));
  const alpha = join(root, 'alpha');
  const beta = join(root, 'beta');
  await mkdir(alpha);
  await mkdir(beta);
  try {
    return await fn({ root, alpha, beta });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('a session whose cwd matches a workspace is re-attached to it', async () => {
  await withDirs(async ({ alpha }) => {
    const registry = fakeRegistry([{ id: 'ws_a', path: alpha, sessionIds: ['ses_known'] }]);
    const ctx = { get: (name) => ({ workspaceRegistry: registry, sessionPersistence: fakePersistence([
      { id: 'ses_known', cwd: alpha },
      { id: 'ses_lost', cwd: alpha, origin: undefined },
    ]) })[name] };
    const result = await adoptOrphanSessions({ ctx });
    assert.equal(result.available, true);
    assert.deepEqual(result.adopted, ['ses_lost']);
    assert.deepEqual(registry.entities[0].sessionIds, ['ses_lost', 'ses_known'], 'and prepends it, like a new session');
    assert.deepEqual(result.failed, []);
  });
});

test('it never touches subagents, archived sessions, or sessions already accounted', async () => {
  await withDirs(async ({ alpha }) => {
    const registry = fakeRegistry([{ id: 'ws_a', path: alpha, sessionIds: ['ses_known'] }], { archived: ['ses_arch'] });
    const ctx = { get: (name) => ({ workspaceRegistry: registry, sessionPersistence: fakePersistence([
      { id: 'ses_known', cwd: alpha },
      { id: 'ses_child', cwd: alpha, origin: 'subagent', parentSession: 'ses_known' },
      { id: 'ses_arch', cwd: alpha },
      { id: 'ses_nowhere', cwd: '/definitely/not/a/workspace' },
      { id: 'ses_nocwd' },
    ]) })[name] };
    const result = await adoptOrphanSessions({ ctx });
    assert.deepEqual(result.adopted, []);
    assert.equal(result.skipped, 5);
    assert.deepEqual(registry.entities[0].sessionIds, ['ses_known']);
  });
});

test('a refused attach is reported, not forced', async () => {
  await withDirs(async ({ alpha }) => {
    const registry = fakeRegistry([{
      id: 'ws_a',
      path: alpha,
      sessionIds: [],
      attach: async () => { throw new Error('cwd does not resolve'); },
    }]);
    const ctx = { get: (name) => ({ workspaceRegistry: registry, sessionPersistence: fakePersistence([{ id: 'ses_x', cwd: alpha }]) })[name] };
    const result = await adoptOrphanSessions({ ctx });
    assert.deepEqual(result.adopted, []);
    assert.equal(result.failed.length, 1);
    assert.match(result.failed[0].error, /does not resolve/);
    assert.deepEqual(registry.entities[0].sessionIds, [], 'nothing was written');
  });
});

test('a session whose record slot exists but whose cwd went stale is skipped, not re-attached', async () => {
  // The entity's `sessionIds` getter hides an id whose canonical cwd no longer matches, so it
  // *looks* unaccounted. Attaching it elsewhere would put one session in two records, which the
  // native `validateStoredState` refuses to boot.
  await withDirs(async ({ alpha, beta }) => {
    const registry = fakeRegistry(
      [
        { id: 'ws_a', path: alpha, sessionIds: [] },
        { id: 'ws_b', path: beta, sessionIds: [] },
      ],
      {
        tableRecords: new Map([
          ['ws_a', { path: alpha, sessionIds: ['ses_moved'] }],
          ['ws_b', { path: beta, sessionIds: [] }],
        ]),
      },
    );
    const ctx = { get: (name) => ({ workspaceRegistry: registry, sessionPersistence: fakePersistence([
      { id: 'ses_moved', cwd: beta },
    ]) })[name] };
    const result = await adoptOrphanSessions({ ctx });
    assert.deepEqual(result.adopted, [], 'the hidden-but-accounted id is not claimed by its new path');
    assert.equal(result.skipped, 1);
  });
});

test('running the repair twice is a no-op the second time', async () => {
  await withDirs(async ({ alpha }) => {
    let attaches = 0;
    const registry = fakeRegistry([{
      id: 'ws_a',
      path: alpha,
      sessionIds: [],
      attach: async (id) => {
        attaches += 1;
        registry.entities[0].record.sessionIds = [id, ...registry.entities[0].record.sessionIds];
      },
    }]);
    const ctx = { get: (name) => ({ workspaceRegistry: registry, sessionPersistence: fakePersistence([{ id: 'ses_once', cwd: alpha }]) })[name] };
    const first = await adoptOrphanSessions({ ctx });
    assert.deepEqual(first.adopted, ['ses_once']);
    assert.deepEqual(first.moved, ['ses_once'], 'the first call is the one that moved it');
    const second = await adoptOrphanSessions({ ctx });
    assert.deepEqual(second.adopted, [], 'nothing left to repair');
    assert.deepEqual(second.moved, []);
    assert.equal(attaches, 1, 'the host command ran exactly once');
  });
});

test('a concurrent tab reports no move for a write it did not make', async () => {
  await withDirs(async ({ alpha }) => {
    // Simulates the losing side of two tabs: the record already lists the id by the time this
    // call resolves, so `attachSession` is a no-op the host accepts. The raw table is consulted
    // for accounting, but is made to miss the id (as a stale snapshot would), so the loop does
    // reach `attachSession` — and must then report no move.
    const registry = fakeRegistry(
      [{ id: 'ws_a', path: alpha, sessionIds: ['ses_race'] }],
      { tableRecords: new Map([['ws_a', { path: alpha, sessionIds: [] }]]) },
    );
    const ctx = { get: (name) => ({
      workspaceRegistry: registry,
      sessionPersistence: fakePersistence([{ id: 'ses_race', cwd: alpha }]),
    })[name] };
    const result = await adoptOrphanSessions({ ctx });
    assert.deepEqual(result.adopted, ['ses_race'], 'the id is accounted for now');
    assert.deepEqual(result.moved, [], 'but this run changed nothing, so nothing is announced');
  });
});

test('a registry without a raw table skips the repair instead of guessing', async () => {
  await withDirs(async ({ alpha }) => {
    let attaches = 0;
    const registry = fakeRegistry(
      [{ id: 'ws_a', path: alpha, sessionIds: [], attach: async () => { attaches += 1; } }],
      { withTable: false },
    );
    const ctx = { get: (name) => ({
      workspaceRegistry: registry,
      sessionPersistence: fakePersistence([{ id: 'ses_stale', cwd: alpha }]),
    })[name] };
    const result = await adoptOrphanSessions({ ctx });
    // The entity getter hides ids whose cwd went stale; treating that as "unaccounted" would
    // double-account a session and the native registry refuses to boot such a state.
    assert.equal(result.available, false);
    assert.deepEqual(result.adopted, []);
    assert.equal(attaches, 0, 'nothing was attached');
  });
});

test('a workspace registered through a symlinked spelling still matches its sessions', async () => {
  await withDirs(async ({ root, alpha }) => {
    const alias = join(root, 'alpha-alias');
    const linked = await symlink(alpha, alias, 'dir').then(() => true, () => false);
    if (!linked) return; // Windows without privileges/dev mode
    // The record keeps the user's spelling; the artifact header carries the canonical path.
    const registry = fakeRegistry([{ id: 'ws_a', path: alias, sessionIds: [] }]);
    const ctx = { get: (name) => ({ workspaceRegistry: registry, sessionPersistence: fakePersistence([
      { id: 'ses_alias', cwd: alpha },
    ]) })[name] };
    const result = await adoptOrphanSessions({ ctx });
    assert.deepEqual(result.adopted, ['ses_alias']);
    assert.deepEqual(registry.entities[0].sessionIds, ['ses_alias']);
  });
});

test('a session whose cwd was deleted is left in the ungrouped bucket', async () => {
  await withDirs(async ({ root }) => {
    const registry = fakeRegistry([{ id: 'ws_a', path: join(root, 'alpha'), sessionIds: [] }]);
    const ctx = { get: (name) => ({ workspaceRegistry: registry, sessionPersistence: fakePersistence([
      { id: 'ses_gone', cwd: join(root, 'alpha', 'removed') },
    ]) })[name] };
    const result = await adoptOrphanSessions({ ctx });
    assert.deepEqual(result.adopted, []);
    assert.equal(result.skipped, 1);
  });
});

test('a composition without the host services reports unavailable instead of throwing', async () => {
  for (const services of [{}, { workspaceRegistry: {} }, { sessionPersistence: { list: async () => [] } }]) {
    const ctx = { get: (name) => services[name] };
    const result = await adoptOrphanSessions({ ctx });
    assert.equal(result.available, false);
    assert.deepEqual(result.adopted, []);
  }
  const bare = await adoptOrphanSessions({ ctx: { get() { throw new Error('no inject'); } } });
  assert.equal(bare.available, false, 'a service read that throws is a missing service, not a crash');
});
