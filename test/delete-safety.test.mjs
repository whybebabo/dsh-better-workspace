import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, lstat, symlink, rm, utimes, rename } from 'node:fs/promises';
import { utimesSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import * as zlib from 'node:zlib';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { previewDelete, executeDelete } from '../lib/delete.js';
import { isSafeSessionId, encodeSegment, foldPath, removeVerifiedDir, resolveSessionsRoot, readSessionHeader, sweepTrash } from '../lib/session-files.js';

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-topic-delete-'));
  const home = join(dir, 'home');
  const root = join(home, 'sessions');
  const project = '--C-Work-demo--';
  return { dir, home, root, project, sessionDir: (id) => join(root, project, encodeSegment(id)) };
}

/**
 * A settled session. The lease check treats a *recently appended* artifact as "being written",
 * so fixtures are aged past the quiet window unless a test is explicitly about a live writer.
 */
async function makeSession(fx, id, extraHeader = {}, { lease = false, ageMs = 60_000 } = {}) {
  const target = fx.sessionDir(id);
  await mkdir(target, { recursive: true });
  const header = { type: 'session', version: 3, id, createdAt: 1_700_000_000_000, cwd: 'C:/Work/demo', isSeeded: false, delegationDepth: 0, ...extraHeader };
  const body = `${JSON.stringify(header)}\n${JSON.stringify({ type: 'event', seq: 1 })}\n`;
  const logPath = join(target, 'session.v3.jsonl');
  await writeFile(logPath, body, 'utf8');
  const stamp = new Date(Date.now() - ageMs);
  await utimes(logPath, stamp, stamp);
  if (lease) await writeFile(join(target, 'session.v3.jsonl.lock'), 'holder', 'utf8');
  return target;
}

/**
 * A pre-migration generation-0 artifact: the host's naming rule has no `.v0` segment.
 * See `sessionFormatLogFilename(0) === 'session.jsonl'`.
 */
async function makeV0Session(fx, id, { ageMs = 60_000 } = {}) {
  const target = fx.sessionDir(id);
  await mkdir(target, { recursive: true });
  const header = { type: 'session', version: 0, id, createdAt: 1_700_000_000_000, cwd: 'C:/Work/demo' };
  const logPath = join(target, 'session.jsonl');
  await writeFile(logPath, `${JSON.stringify(header)}\n${JSON.stringify({ type: 'event', seq: 1 })}\n`, 'utf8');
  const stamp = new Date(Date.now() - ageMs);
  await utimes(logPath, stamp, stamp);
  return target;
}

/**
 * A zstd artifact larger than `HEADER_READ_BYTES`. The random body is deliberately
 * incompressible, so the compressed file itself crosses the old 64KB window.
 */
async function makeCompressedSession(fx, id, bodyBytes = 120_000) {
  const target = fx.sessionDir(id);
  await mkdir(target, { recursive: true });
  const header = { type: 'session', version: 3, id, createdAt: 1_700_000_000_000, cwd: 'C:/Work/demo' };
  const raw = Buffer.concat([Buffer.from(`${JSON.stringify(header)}\n`), randomBytes(bodyBytes)]);
  const logPath = join(target, 'session.v3.jsonl.zstd');
  await writeFile(logPath, zlib.zstdCompressSync(raw));
  const stamp = new Date(Date.now() - 60_000);
  await utimes(logPath, stamp, stamp);
  return target;
}

function ctxWith(agents = {}) {
  return {
    get(name) {
      if (name !== 'agents') throw new Error(`service not declared: ${name}`);
      return { get: (id) => agents[id] };
    },
  };
}

function ctxServices(services) {
  return { get: (name) => services[name] ?? null };
}

test('id validation blocks traversal before any filesystem work', async () => {
  const fx = await fixture();
  for (const bad of ['../../etc', 'a/b', 'a\\b', '.', '..', '', 'x'.repeat(200), 'ses x']) {
    assert.equal(isSafeSessionId(bad), false, `rejects ${JSON.stringify(bad)}`);
  }
  const preview = await previewDelete({ home: fx.home, ctx: ctxWith(), sessionIds: ['../../etc'] });
  const [item] = preview.items;
  assert.equal(item.blockers[0].code, 'bad-id');
  assert.equal(item.blockers[0].severity, 'hard');
});

test('a missing sessions root blocks every item', async () => {
  const fx = await fixture();
  const preview = await previewDelete({ home: fx.home, ctx: ctxWith(), sessionIds: ['ses_gone'] });
  assert.equal(preview.rootAvailable, false);
  assert.equal(preview.items[0].blockers[0].code, 'root-unavailable');
});

test('preview verifies identity through the artifact header', async () => {
  const fx = await fixture();
  const real = await makeSession(fx, 'ses_real');
  // Directory name matches the requested id but the header belongs to another session.
  const spoof = fx.sessionDir('ses_spoof');
  await mkdir(spoof, { recursive: true });
  await writeFile(join(spoof, 'session.v3.jsonl'), `${JSON.stringify({ type: 'session', version: 3, id: 'someone_else' })}\n`, 'utf8');
  await makeSession(fx, 'ses_noartifact_only');
  await rm(join(fx.root, fx.project, encodeSegment('ses_noartifact_only'), 'session.v3.jsonl'));

  const preview = await previewDelete({ home: fx.home, ctx: ctxWith(), sessionIds: ['ses_real', 'ses_spoof', 'ses_noartifact_only', 'ses_missing'] });
  const byId = Object.fromEntries(preview.items.map((item) => [item.sessionId, item]));

  assert.equal(byId.ses_real.exists, true);
  assert.equal(byId.ses_real.cwd, 'C:/Work/demo');
  assert.ok(byId.ses_real.bytes > 0);
  assert.deepEqual(byId.ses_real.blockers, []);
  assert.equal(byId.ses_spoof.exists, false, 'header mismatch must not count as found');
  assert.equal(byId.ses_spoof.blockers[0].code, 'not-found');
  assert.equal(byId.ses_noartifact_only.blockers[0].code, 'not-found');
  assert.equal(byId.ses_missing.blockers[0].code, 'not-found');
  assert.equal(preview.hardBlocked, true);
  assert.ok(real.endsWith(encodeSegment('ses_real')));
});

test('subagents, write leases and unknown ids are hard blockers; running is soft', async () => {
  const fx = await fixture();
  await makeSession(fx, 'ses_child', { origin: 'subagent', parentSession: 'ses_parent' });
  // A live writer is recognised by a *recent* append, not by the presence of `session.lock`
  // (DSH keeps that file forever on POSIX and never creates one on Windows).
  await makeSession(fx, 'ses_locked', {}, { ageMs: 0 });
  await makeSession(fx, 'ses_settled', {}, { ageMs: 120_000 });
  await makeSession(fx, 'ses_parent');
  const preview = await previewDelete({
    home: fx.home,
    ctx: ctxWith({ ses_parent: { status: 'running', cancel: async () => {} } }),
    sessionIds: ['ses_child', 'ses_locked', 'ses_settled', 'ses_parent'],
  });
  const byId = Object.fromEntries(preview.items.map((item) => [item.sessionId, item]));
  assert.equal(byId.ses_child.subagent, true);
  assert.equal(byId.ses_child.blockers.find((b) => b.code === 'subagent').severity, 'hard');
  assert.equal(byId.ses_locked.blockers.find((b) => b.code === 'locked').severity, 'hard');
  assert.deepEqual(byId.ses_settled.blockers, [], 'a quiet session is deletable even on POSIX');
  assert.equal(byId.ses_parent.running, true);
  assert.equal(byId.ses_parent.blockers.find((b) => b.code === 'running').severity, 'soft');
  assert.equal(preview.running, 1);
});

test('an orphaned subagent (parent artifact gone) can be deleted on its own', async () => {
  const fx = await fixture();
  // What a `partial` delete leaves behind: the parent is already gone, the child stayed.
  await makeSession(fx, 'ses_orphan', { origin: 'subagent', parentSession: 'ses_parent_gone' });
  const ctx = ctxWith();

  const preview = await previewDelete({ home: fx.home, ctx, sessionIds: ['ses_orphan'] });
  const [item] = preview.items;
  assert.equal(item.subagent, true);
  assert.equal(item.blockers.some((blocker) => blocker.code === 'subagent' && blocker.severity === 'hard'), false, 'no "delete its parent" dead end');
  assert.equal(preview.hardBlocked, false);

  const outcome = await executeDelete({ home: fx.home, ctx, sessionIds: ['ses_orphan'], confirm: true });
  assert.equal(outcome.items[0].status, 'deleted');
  await assert.rejects(() => lstat(fx.sessionDir('ses_orphan')), 'the orphaned artifact is gone');
});

test('a subagent whose parent still exists is refused with the cascade instruction', async () => {
  const fx = await fixture();
  await makeSession(fx, 'ses_parent');
  await makeSession(fx, 'ses_child', { origin: 'subagent', parentSession: 'ses_parent' });
  const preview = await previewDelete({ home: fx.home, ctx: ctxWith(), sessionIds: ['ses_child'] });
  assert.equal(preview.items[0].blockers[0].code, 'subagent');
  assert.equal(preview.items[0].blockers[0].severity, 'hard');
  assert.equal(preview.hardBlocked, true);
});

test('deletion requires explicit confirmation', async () => {
  const fx = await fixture();
  await makeSession(fx, 'ses_one');
  await assert.rejects(
    () => executeDelete({ home: fx.home, ctx: ctxWith(), sessionIds: ['ses_one'] }),
    (error) => error.code === 'confirm-required',
  );
  assert.equal((await readFile(join(fx.sessionDir('ses_one'), 'session.v3.jsonl'), 'utf8')).includes('ses_one'), true, 'nothing was removed');
});

test('execute removes only verified sessions, cascades subagents and reports per item', async () => {
  const fx = await fixture();
  await makeSession(fx, 'ses_main');
  await makeSession(fx, 'ses_sub1', { origin: 'subagent', delegationDepth: 1, parentSession: 'ses_main' });
  await makeSession(fx, 'ses_sub2', { origin: 'subagent', delegationDepth: 2, parentSession: 'ses_sub1' });
  await makeSession(fx, 'ses_other');
  await makeSession(fx, 'ses_locked', {}, { ageMs: 0 });

  const outcome = await executeDelete({
    home: fx.home,
    ctx: ctxWith(),
    sessionIds: ['ses_main', 'ses_locked', 'ses_ghost'],
    confirm: true,
  });
  assert.equal(outcome.summary.deleted, 1);
  assert.equal(outcome.summary.skipped, 2, 'lease and unverified ids are skipped, not failed');
  assert.deepEqual(outcome.items[0].subagentsRemoved.sort(), ['ses_sub1', 'ses_sub2']);
  assert.equal(await exists(fx.sessionDir('ses_main')), false);
  assert.equal(await exists(fx.sessionDir('ses_sub1')), false);
  assert.equal(await exists(fx.sessionDir('ses_sub2')), false);
  assert.equal(await exists(fx.sessionDir('ses_other')), true, 'unrelated sessions untouched');
  assert.equal(await exists(fx.sessionDir('ses_locked')), true);
});

test('user forks carry parentSession but are neither subagents nor cascaded', async () => {
  const fx = await fixture();
  await makeSession(fx, 'ses_source');
  await makeSession(fx, 'ses_fork', { parentSession: 'ses_source', isSeeded: true });

  const forkPreview = await previewDelete({ home: fx.home, ctx: ctxWith(), sessionIds: ['ses_fork'] });
  assert.equal(forkPreview.items[0].subagent, false, 'parentSession alone is not a subagent');
  assert.deepEqual(forkPreview.items[0].blockers, [], 'the user fork is deletable');
  assert.equal(forkPreview.items[0].subagentCount, 0, 'the fork has no cascaded children');

  const source = await executeDelete({ home: fx.home, ctx: ctxWith(), sessionIds: ['ses_source'], confirm: true });
  assert.equal(source.items[0].status, 'deleted');
  assert.equal(await exists(fx.sessionDir('ses_fork')), true, 'deleting the source leaves the fork intact');

  const fork = await executeDelete({ home: fx.home, ctx: ctxWith(), sessionIds: ['ses_fork'], confirm: true });
  assert.equal(fork.items[0].status, 'deleted');
  assert.equal(await exists(fx.sessionDir('ses_fork')), false);
});

test('execute flushes the live store and clears host workspace, archive/pin and projection records', async () => {
  const fx = await fixture();
  await makeSession(fx, 'ses_one');
  const calls = { flush: 0, detach: 0, workspace: 0, unarchive: 0, unpin: 0, projection: 0, globalSet: 0 };
  const entry = { session: {}, detach() { calls.detach += 1; } };
  let globalState = {
    initialized: true,
    workspaceIds: ['ws_a'],
    archivedSessionIds: ['ses_one'],
    pinnedSessionIds: ['ses_one'],
  };
  const record = { title: 'Alpha', path: 'C:/Work/demo', sessionIds: ['ses_one'] };
  const table = {
    keys: () => ['ws_a'][Symbol.iterator](),
    get: (key) => (key === 'ws_a' ? record : undefined),
    update: async () => { throw new Error('the registry entity should handle the row'); },
  };
  const registry = {
    table,
    get: (key) => (key === 'ws_a' ? { detachSession: async (id) => { assert.equal(id, 'ses_one'); calls.workspace += 1; } } : undefined),
    unarchiveSession: async (id) => {
      calls.unarchive += 1;
      globalState = { ...globalState, archivedSessionIds: globalState.archivedSessionIds.filter((entry) => entry !== id) };
    },
    unpinSession: async (id) => {
      calls.unpin += 1;
      globalState = { ...globalState, pinnedSessionIds: globalState.pinnedSessionIds.filter((entry) => entry !== id) };
    },
  };
  const projection = { delete: async (id) => { assert.equal(id, 'ses_one'); calls.projection += 1; return true; } };
  const storage = {
    get: (name) => {
      if (name === 'workspace') return { table: () => table };
      if (name === 'session_projcache') return { table: () => projection };
      return null;
    },
  };
  const ctx = ctxServices({
    sessions: {
      store: { get: (id) => (id === 'ses_one' ? entry : undefined) },
      flush: async () => { calls.flush += 1; return true; },
    },
    workspaceRegistry: registry,
    storageDomain: storage,
  });

  const outcome = await executeDelete({ home: fx.home, ctx, sessionIds: ['ses_one'], confirm: true });
  assert.equal(outcome.items[0].status, 'deleted');
  assert.deepEqual(calls, { flush: 1, detach: 1, workspace: 1, unarchive: 1, unpin: 1, projection: 1, globalSet: 0 },
    'the official per-id commands clean archive/pin; no global read-modify-write is made');
  assert.equal(globalState.archivedSessionIds.includes('ses_one'), false);
  assert.equal(globalState.pinnedSessionIds.includes('ses_one'), false);
});

test('a cleanup service that throws does not turn a completed delete into a failure', async () => {
  const fx = await fixture();
  await makeSession(fx, 'ses_cleanup_error');
  const ctx = ctxServices({
    sessions: { store: { get: () => null }, flush: async () => {} },
    storageDomain: {
      get() {
        throw new Error('storage boom');
      },
    },
  });

  const outcome = await executeDelete({ home: fx.home, ctx, sessionIds: ['ses_cleanup_error'], confirm: true });
  const item = outcome.items[0];
  assert.equal(item.status, 'deleted', 'the artifact is gone, so the deletion itself succeeded');
  assert.equal(item.cleanup?.failed, true, 'the host-record failure is reported separately');
  assert.match(item.cleanup?.error ?? '', /storage boom/);
  assert.equal(await exists(fx.sessionDir('ses_cleanup_error')), false);
});

test('a session-store detach failure keeps the artifact and reports a failure', async () => {
  const fx = await fixture();
  await makeSession(fx, 'ses_detach_error');
  const ctx = ctxServices({
    sessions: {
      store: {
        get: () => ({
          session: {},
          detach() {
            throw new Error('detach boom');
          },
        }),
      },
      flush: async () => {},
    },
  });

  const outcome = await executeDelete({ home: fx.home, ctx, sessionIds: ['ses_detach_error'], confirm: true });
  const item = outcome.items[0];
  assert.equal(item.status, 'failed');
  assert.equal(item.code, 'detach-failed');
  assert.match(item.notes.join('; '), /detach boom/);
  assert.equal(await exists(fx.sessionDir('ses_detach_error')), true, 'the live store entry still owns this path');
});

test('a child detach failure leaves that child and marks the parent partial', async () => {
  const fx = await fixture();
  await makeSession(fx, 'ses_parent_detach');
  await makeSession(fx, 'ses_child_detach', { origin: 'subagent', parentSession: 'ses_parent_detach' });
  const ctx = ctxServices({
    sessions: {
      store: {
        get: (id) => ({
          session: {},
          detach() {
            if (id === 'ses_child_detach') throw new Error('child detach boom');
          },
        }),
      },
      flush: async () => {},
    },
  });

  const outcome = await executeDelete({ home: fx.home, ctx, sessionIds: ['ses_parent_detach'], confirm: true });
  const item = outcome.items[0];
  assert.equal(item.status, 'partial');
  assert.equal(item.code, 'subagents-failed');
  assert.deepEqual(item.subagentsFailed, ['ses_child_detach']);
  assert.deepEqual(item.subagentsRemoved, []);
  assert.equal(await exists(fx.sessionDir('ses_parent_detach')), false);
  assert.equal(await exists(fx.sessionDir('ses_child_detach')), true, 'the child whose store entry survived is preserved');
});

test('a running session is cancelled first, and never deleted while it stays running', async () => {
  const fx = await fixture();
  await makeSession(fx, 'ses_running');
  const stuck = { status: 'running', async cancel() { /* stays running */ } };
  const refused = await executeDelete({ home: fx.home, ctx: ctxWith({ ses_running: stuck }), sessionIds: ['ses_running'], confirm: true, stopActivity: true });
  assert.equal(refused.items[0].status, 'failed');
  assert.equal(refused.items[0].code, 'stop-failed');
  assert.equal(await exists(fx.sessionDir('ses_running')), true, 'data kept when the agent would not stop');

  const idle = await executeDelete({ home: fx.home, ctx: ctxWith({ ses_running: { status: 'running', async cancel() { this.status = 'idle'; } } }), sessionIds: ['ses_running'], confirm: true });
  assert.equal(idle.items[0].status, 'deleted');
  assert.equal(await exists(fx.sessionDir('ses_running')), false);

  const skipped = await makeSession(fx, 'ses_nostop');
  const refused2 = await executeDelete({
    home: fx.home,
    ctx: ctxWith({ ses_nostop: { status: 'running', cancel() { throw new Error('cancel failed'); } } }),
    sessionIds: ['ses_nostop'],
    confirm: true,
    stopActivity: false,
  });
  assert.equal(refused2.items[0].status, 'skipped');
  assert.equal(refused2.items[0].code, 'running');
  assert.equal(await exists(skipped), true);
});

test('a session that starts running between analysis and removal is skipped', async () => {
  const fx = await fixture();
  await makeSession(fx, 'ses_starts');
  let probes = 0;
  const ctx = ctxWith({
    ses_starts: {
      get status() {
        probes += 1;
        return probes >= 2 ? 'running' : 'idle';
      },
    },
  });
  const outcome = await executeDelete({ home: fx.home, ctx, sessionIds: ['ses_starts'], confirm: true });
  assert.equal(outcome.items[0].status, 'skipped');
  assert.equal(outcome.items[0].code, 'running');
  assert.equal(await exists(fx.sessionDir('ses_starts')), true, 'the directory is untouched');
});

test('a log written after analysis makes the session a lease blocker', async () => {
  const fx = await fixture();
  const target = await makeSession(fx, 'ses_write');
  const logPath = join(target, 'session.v3.jsonl');
  let probes = 0;
  const ctx = ctxWith({
    ses_write: {
      get status() {
        probes += 1;
        if (probes === 2) utimesSync(logPath, new Date(), new Date());
        return 'idle';
      },
    },
  });
  const outcome = await executeDelete({ home: fx.home, ctx, sessionIds: ['ses_write'], confirm: true });
  assert.equal(outcome.items[0].status, 'skipped');
  assert.equal(outcome.items[0].code, 'locked');
  assert.equal(await exists(target), true);
});

test('compressed artifacts larger than the old header window still verify and delete', async (t) => {
  if (typeof zlib.zstdCompressSync !== 'function' || typeof zlib.createZstdDecompress !== 'function') {
    t.skip('this Node build has no zstd stream API');
    return;
  }
  const fx = await fixture();
  const target = await makeCompressedSession(fx, 'ses_zstd');
  const header = await readSessionHeader(target);
  assert.equal(header.header.id, 'ses_zstd');

  const preview = await previewDelete({ home: fx.home, ctx: ctxWith(), sessionIds: ['ses_zstd'] });
  assert.equal(preview.items[0].exists, true);
  assert.deepEqual(preview.items[0].blockers, []);

  const outcome = await executeDelete({ home: fx.home, ctx: ctxWith(), sessionIds: ['ses_zstd'], confirm: true });
  assert.equal(outcome.items[0].status, 'deleted');
  assert.equal(await exists(target), false);
});

test('a generation-0 session.jsonl artifact is visible and deletable', async () => {
  const fx = await fixture();
  const target = await makeV0Session(fx, 'ses_v0');
  const header = await readSessionHeader(target);
  assert.equal(header.header.id, 'ses_v0');
  assert.equal(header.log.version, 0);

  const preview = await previewDelete({ home: fx.home, ctx: ctxWith(), sessionIds: ['ses_v0'] });
  assert.equal(preview.items[0].exists, true);
  assert.deepEqual(preview.items[0].blockers, []);

  const outcome = await executeDelete({ home: fx.home, ctx: ctxWith(), sessionIds: ['ses_v0'], confirm: true });
  assert.equal(outcome.items[0].status, 'deleted');
  assert.equal(await exists(target), false);
});

test('path safety: links are refused and removal cannot escape the sessions root', async (t) => {
  const fx = await fixture();
  await makeSession(fx, 'ses_ok');
  const resolvedRoot = await resolveSessionsRoot(fx.home);
  assert.ok(resolvedRoot, 'root resolves for a plain tree');

  await assert.rejects(
    () => removeVerifiedDir({ rootResolved: resolvedRoot.resolved, dir: join(fx.root, '..', 'elsewhere') }),
    (error) => error.code === 'unsafe-path',
  );
  await assert.rejects(
    () => removeVerifiedDir({ rootResolved: resolvedRoot.resolved, dir: resolvedRoot.resolved }),
    (error) => error.code === 'unsafe-path',
  );
  assert.equal(await exists(fx.sessionDir('ses_ok')), true);

  // A session directory replaced by a link must be refused, not followed.
  const real = await mkdtemp(join(tmpdir(), 'dsh-topic-outside-'));
  await writeFile(join(real, 'precious.txt'), 'do not delete', 'utf8');
  const victim = fx.sessionDir('ses_link');
  await mkdir(join(fx.root, fx.project), { recursive: true });
  const linkable = await symlink(real, victim, 'junction').then(() => true, () => false);
  if (!linkable) {
    t.skip('this host cannot create a directory junction');
    return;
  }
  const preview = await previewDelete({ home: fx.home, ctx: ctxWith(), sessionIds: ['ses_link'] });
  assert.equal(preview.items[0].exists, false, 'a linked directory never counts as a located session');
  assert.equal(preview.items[0].blockers[0].code, 'not-found');
  const outcome = await executeDelete({ home: fx.home, ctx: ctxWith(), sessionIds: ['ses_link'], confirm: true });
  assert.equal(outcome.summary.deleted, 0);
  assert.equal((await readFile(join(real, 'precious.txt'), 'utf8')), 'do not delete');
});

test('removal cannot be redirected by swapping a parent component for a link', async (t) => {
  // Deterministic version of the check→rename race: when the quarantine rename is about to
  // run, replace the project directory with a junction. The quarantine then receives the
  // linked target, and the post-rename header check must restore it instead of deleting it.
  const fx = await fixture();
  await makeSession(fx, 'ses_victim');
  const resolvedRoot = await resolveSessionsRoot(fx.home);
  assert.ok(resolvedRoot);

  const outside = await mkdtemp(join(tmpdir(), 'dsh-topic-outside-parent-'));
  await mkdir(join(outside, 'ses_victim'), { recursive: true });
  await writeFile(join(outside, 'ses_victim', 'precious.txt'), 'do not delete', 'utf8');

  const projectPath = join(fx.root, fx.project);
  const swapPath = `${projectPath}.swap`;
  const linked = await symlink(outside, swapPath, 'junction').then(() => true, () => false);
  if (!linked) {
    t.skip('this host cannot create a directory junction');
    return;
  }

  const { createRequire, syncBuiltinESMExports } = await import('node:module');
  const require = createRequire(import.meta.url);
  const fsp = require('node:fs/promises');
  const realRename = fsp.rename;
  let swapped = false;
  fsp.rename = async (from, to) => {
    if (!swapped && String(to).includes('.trash-')) {
      swapped = true;
      await rm(projectPath, { recursive: true, force: true });
      await realRename(swapPath, projectPath);
    }
    return realRename(from, to);
  };
  syncBuiltinESMExports();
  try {
    const outcome = await removeVerifiedDir({
      rootResolved: resolvedRoot.resolved,
      dir: join(projectPath, 'ses_victim'),
      expectedSessionId: 'ses_victim',
    }).then(() => 'removed', (error) => error.code ?? 'error');
    assert.equal(swapped, true, 'the swap happened at the quarantine rename');
    assert.notEqual(outcome, 'removed', 'the swapped-in directory must not be deleted');
    assert.equal(await readFile(join(outside, 'ses_victim', 'precious.txt'), 'utf8'), 'do not delete');
  } finally {
    fsp.rename = realRename;
    syncBuiltinESMExports();
  }
});

test('a pre-swapped parent is rejected before any removal', async (t) => {
  // A tripwire for the guard itself: if removeVerifiedDir ever degrades to `rm` after a
  // passing check, deleting through an already-swapped parent must be refused. Written as a
  // separate case so a regression in the quarantine path fails loudly instead of silently.
  const fx = await fixture();
  await mkdir(join(fx.root, fx.project), { recursive: true });
  const resolvedRoot = await resolveSessionsRoot(fx.home);
  assert.ok(resolvedRoot);

  const outside = await mkdtemp(join(tmpdir(), 'dsh-topic-outside-pre-'));
  await mkdir(join(outside, 'ses_victim'), { recursive: true });
  await writeFile(join(outside, 'ses_victim', 'precious.txt'), 'do not delete', 'utf8');

  const projectPath = join(fx.root, fx.project);
  const linked = await symlink(outside, `${projectPath}.swap`, 'junction').then(() => true, () => false);
  if (!linked) {
    t.skip('this host cannot create a directory junction');
    return;
  }
  await rm(projectPath, { recursive: true, force: true });
  await rename(`${projectPath}.swap`, projectPath);

  await assert.rejects(
    () => removeVerifiedDir({ rootResolved: resolvedRoot.resolved, dir: join(projectPath, 'ses_victim') }),
    (error) => error.code === 'unsafe-path',
  );
  assert.equal(await readFile(join(outside, 'ses_victim', 'precious.txt'), 'utf8'), 'do not delete');
});

test('removal stages through a quarantine outside the sessions root', async () => {
  // The quarantine must never live below `sessions`: DSH lists every directory there and
  // rejects an artifact whose path disagrees with its header, so a leftover `.trash-*` would
  // break the host's whole session list. Pin the destination deterministically instead of
  // racing a file watcher against a recursive rm.
  const fx = await fixture();
  await makeSession(fx, 'ses_direct');
  const resolvedRoot = await resolveSessionsRoot(fx.home);
  assert.ok(resolvedRoot);

  const { createRequire, syncBuiltinESMExports } = await import('node:module');
  const require = createRequire(import.meta.url);
  const fsp = require('node:fs/promises');
  const realRename = fsp.rename;
  const destinations = [];
  fsp.rename = async (from, to) => {
    destinations.push(String(to));
    return realRename(from, to);
  };
  syncBuiltinESMExports();
  try {
    await removeVerifiedDir({ rootResolved: resolvedRoot.resolved, dir: fx.sessionDir('ses_direct') });
  } finally {
    fsp.rename = realRename;
    syncBuiltinESMExports();
  }

  const moved = destinations.find((path) => path.includes('.trash-'));
  assert.ok(moved, `removal must rename through a quarantine (saw: ${destinations.join(', ') || 'nothing'})`);
  assert.equal(moved.startsWith(resolvedRoot.resolved + sep), false, 'quarantine is outside the sessions root');
  assert.match(moved, /dsh-better-workspace[\\/]trash[\\/]\.trash-/);
  assert.equal(await exists(fx.sessionDir('ses_direct')), false);
  assert.equal(await exists(join(resolvedRoot.resolved, fx.project, 'ses_direct')), false);
});

test('a settled session is not blocked by a leftover POSIX session.lock', async () => {
  // POSIX keeps `session.lock` forever after the first write; treating the filename as a live
  // writer would make every settled session undeletable. The quiet-window mtime, not the lock
  // file, is the signal.
  const fx = await fixture();
  const target = await makeSession(fx, 'ses_with_lock', {}, { lease: true });
  const settled = await previewDelete({ home: fx.home, ctx: ctxWith(), sessionIds: ['ses_with_lock'] });
  assert.equal(settled.items[0].blockers.some((blocker) => blocker.code === 'locked'), false);
  const outcome = await executeDelete({ home: fx.home, ctx: ctxWith(), sessionIds: ['ses_with_lock'], confirm: true });
  assert.equal(outcome.items[0].status, 'deleted');
  assert.equal(await exists(target), false);

  const fresh = await makeSession(fx, 'ses_fresh_lock', {}, { lease: true, ageMs: 0 });
  const blocked = await previewDelete({ home: fx.home, ctx: ctxWith(), sessionIds: ['ses_fresh_lock'] });
  assert.equal(blocked.items[0].blockers.some((blocker) => blocker.code === 'locked'), true);
  assert.equal(await exists(fresh), true);
});

test('a symlinked sessions root is refused outright', async (t) => {
  const fx = await fixture();
  const outside = join(fx.dir, 'real-sessions');
  await mkdir(outside, { recursive: true });
  await mkdir(join(fx.home), { recursive: true });
  const created = await symlink(outside, join(fx.home, 'sessions'), 'junction').then(() => true, () => false);
  if (!created) {
    t.skip('this host cannot create a directory junction');
    return;
  }
  assert.equal(await resolveSessionsRoot(fx.home), null);
  const preview = await previewDelete({ home: fx.home, ctx: ctxWith(), sessionIds: ['ses_any'] });
  assert.equal(preview.rootAvailable, false);
});

async function exists(path) {
  return lstat(path).then(() => true, () => false);
}

test('a second directory holding the same session id is removed with it', async () => {
  const fx = await fixture();
  const primary = await makeSession(fx, 'ses_twin');
  // A hand-copied artifact under another project key: the scan used to keep only the first copy,
  // delete it, and report `deleted` while this one survived.
  const copyDir = join(fx.root, '--C-Other--', encodeSegment('ses_twin'));
  await mkdir(copyDir, { recursive: true });
  const header = { type: 'session', version: 3, id: 'ses_twin', createdAt: 1_700_000_000_000, cwd: 'C:/Work/demo' };
  const logPath = join(copyDir, 'session.v3.jsonl');
  await writeFile(logPath, `${JSON.stringify(header)}\n`, 'utf8');
  const stamp = new Date(Date.now() - 60_000);
  await utimes(logPath, stamp, stamp);

  const outcome = await executeDelete({ home: fx.home, ctx: ctxWith(), sessionIds: ['ses_twin'], confirm: true });
  assert.equal(outcome.summary.deleted, 1);
  assert.equal(await lstat(primary).then(() => true, () => false), false, 'the primary is gone');
  assert.equal(await lstat(copyDir).then(() => true, () => false), false, 'and the duplicate is gone too');
  assert.ok(outcome.items[0].notes.some((note) => note.includes('重复副本')), 'the copy is reported in the notes');
});

test('week-old quarantine leftovers are collected, a fresh one is kept', async () => {
  const fx = await fixture();
  const trash = join(fx.home, 'dsh-better-workspace', 'trash');
  const old = join(trash, '.trash-1-aaaaaaaaaaaa');
  const fresh = join(trash, '.trash-2-bbbbbbbbbbbb');
  await mkdir(join(old, 'target'), { recursive: true });
  await writeFile(join(old, 'target', 'session.v3.jsonl'), 'orphan', 'utf8');
  await mkdir(join(fresh, 'target'), { recursive: true });
  const past = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  await utimes(old, past, past);
  await makeSession(fx, 'ses_ok');

  await executeDelete({ home: fx.home, ctx: ctxWith(), sessionIds: ['ses_ok'], confirm: true });
  assert.equal(await lstat(old).then(() => true, () => false), false, 'the crashed quarantine is gone');
  assert.equal(await lstat(fresh).then(() => true, () => false), true, "a running delete's own quarantine is untouched");
});

test('path folding respects the platform: POSIX keeps case and separators', () => {
  assert.equal(foldPath('/work/Alpha', 'linux'), '/work/Alpha');
  assert.notEqual(foldPath('/work/Alpha', 'linux'), foldPath('/work/alpha', 'linux'));
  assert.equal(foldPath('/work/alpha/', 'linux'), '/work/alpha', 'only a trailing separator is insignificant');
  assert.equal(foldPath('C:\\Work\\Demo\\', 'win32'), 'c:\\work\\demo');
  assert.equal(foldPath('/work/alpha/', 'win32'), '\\work\\alpha');
});

test('the trash sweep never follows a symlinked directory', async () => {
  const fx = await fixture();
  const trash = join(fx.home, 'dsh-better-workspace', 'trash');
  await mkdir(trash, { recursive: true });
  const outside = await mkdtemp(join(tmpdir(), 'dsh-trash-outside-'));
  await writeFile(join(outside, 'precious.txt'), 'keep', 'utf8');
  const linked = join(trash, '.trash-3-cccccccccccc');
  const linkable = await symlink(outside, linked, 'junction').then(() => true, () => false);
  if (!linkable) {
    await rm(outside, { recursive: true, force: true });
    return;
  }
  const past = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  await utimes(linked, past, past).catch(() => {});
  const removed = await sweepTrash({ home: fx.home });
  assert.equal(removed, 0, 'a symlink is not a quarantine directory');
  assert.equal(await readFile(join(outside, 'precious.txt'), 'utf8'), 'keep');
  await rm(linked, { force: true });
  await rm(outside, { recursive: true, force: true });
});
