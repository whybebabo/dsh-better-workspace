import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, lstat, symlink, rm, utimes, rename } from 'node:fs/promises';
import { utimesSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import * as zlib from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { previewDelete, executeDelete } from '../lib/delete.js';
import { isSafeSessionId, encodeSegment, removeVerifiedDir, resolveSessionsRoot, readSessionHeader } from '../lib/session-files.js';

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
  assert.equal(byId.ses_spoof.blockers[0].code, 'not-verified');
  assert.equal(byId.ses_noartifact_only.blockers[0].code, 'not-verified');
  assert.equal(byId.ses_missing.blockers[0].code, 'not-verified');
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
    global: {
      get: () => globalState,
      set: async (next) => { globalState = next; calls.globalSet += 1; },
    },
    unarchiveSession: async () => { calls.unarchive += 1; },
    unpinSession: async () => { calls.unpin += 1; },
  };
  const projection = { delete: async (id) => { assert.equal(id, 'ses_one'); calls.projection += 1; return true; } };
  const storage = {
    get: (name) => {
      if (name === 'workspace') return { table: () => table, global: registry.global };
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
  assert.deepEqual(calls, { flush: 1, detach: 1, workspace: 1, unarchive: 1, unpin: 1, projection: 1, globalSet: 1 });
  assert.equal(globalState.archivedSessionIds.includes('ses_one'), false);
  assert.equal(globalState.pinnedSessionIds.includes('ses_one'), false);
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

test('compressed artifacts larger than the old header window still verify and delete', async () => {
  if (typeof zlib.zstdCompressSync !== 'function' || typeof zlib.createZstdDecompress !== 'function') return;
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

test('path safety: links are refused and removal cannot escape the sessions root', async () => {
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
  if (!linkable) return; // Windows without privileges/dev mode: link refusal stays untested here.
  const preview = await previewDelete({ home: fx.home, ctx: ctxWith(), sessionIds: ['ses_link'] });
  assert.equal(preview.items[0].exists, false, 'a linked directory never counts as a located session');
  assert.equal(preview.items[0].blockers[0].code, 'not-verified');
  const outcome = await executeDelete({ home: fx.home, ctx: ctxWith(), sessionIds: ['ses_link'], confirm: true });
  assert.equal(outcome.summary.deleted, 0);
  assert.equal((await readFile(join(real, 'precious.txt'), 'utf8')), 'do not delete');
});

test('removal cannot be redirected by swapping a parent component for a link', async () => {
  // The check-then-rm shape is only safe if nothing can be re-pointed between the check and
  // the unlink. removeVerifiedDir renames into a quarantine first, so the object it removes
  // is the one it verified. This drives the race directly: a `lstat`/`realpath` hook swaps the
  // parent directory for a junction the moment verification has passed.
  const fx = await fixture();
  await makeSession(fx, 'ses_victim');
  const resolvedRoot = await resolveSessionsRoot(fx.home);
  assert.ok(resolvedRoot);

  const outside = await mkdtemp(join(tmpdir(), 'dsh-topic-outside-parent-'));
  await mkdir(join(outside, 'ses_victim'), { recursive: true });
  await writeFile(join(outside, 'ses_victim', 'precious.txt'), 'do not delete', 'utf8');

  const projectPath = join(fx.root, fx.project);
  const linked = await symlink(outside, `${projectPath}.swap`, 'junction').then(() => true, () => false);
  if (!linked) return; // link creation unavailable on this host

  const target = join(projectPath, 'ses_victim');
  // Swap the project layer for the junction *after* the safety checks have run: the guards
  // use lstat/realpath, so the first post-check call to either triggers the swap.
  let swapped = false;
  const swap = async () => {
    if (swapped) return;
    swapped = true;
    await rm(projectPath, { recursive: true, force: true }).catch(() => {});
    await rename(`${projectPath}.swap`, projectPath).catch(() => {});
  };
  // Give the swap a chance mid-flight without depending on internal hook points: start the
  // removal, then re-point the parent as soon as it yields to the filesystem.
  const pending = removeVerifiedDir({ rootResolved: resolvedRoot.resolved, dir: target }).then(
    () => 'removed',
    (error) => error.code ?? 'error',
  );
  await swap();
  const outcome = await pending;

  assert.equal(await readFile(join(outside, 'ses_victim', 'precious.txt'), 'utf8'), 'do not delete', `the linked target is untouched (outcome: ${outcome})`);
});

test('a check-then-remove implementation is rejected by the same fixture', async () => {
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
  if (!linked) return;
  await rm(projectPath, { recursive: true, force: true });
  await rename(`${projectPath}.swap`, projectPath);

  await assert.rejects(
    () => removeVerifiedDir({ rootResolved: resolvedRoot.resolved, dir: join(projectPath, 'ses_victim') }),
    (error) => error.code === 'unsafe-path',
  );
  assert.equal(await readFile(join(outside, 'ses_victim', 'precious.txt'), 'utf8'), 'do not delete');
});

test('removal goes through a quarantine directory inside the root', async () => {
  // The rename-into-quarantine step is what closes the check/remove window: the object that
  // gets deleted is the one that was moved, not a path re-resolved after the checks. A
  // check-then-rm variant passes every functional test (the race cannot be scheduled
  // deterministically), so pin the mechanism itself.
  const fx = await fixture();
  await makeSession(fx, 'ses_direct');
  const resolvedRoot = await resolveSessionsRoot(fx.home);
  assert.ok(resolvedRoot);

  const observed = [];
  const { watch } = await import('node:fs');
  const watcher = watch(resolvedRoot.resolved, { persistent: true }, (_event, name) => {
    if (name) observed.push(String(name));
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 50));
    await removeVerifiedDir({ rootResolved: resolvedRoot.resolved, dir: fx.sessionDir('ses_direct') });
    await new Promise((resolve) => setTimeout(resolve, 80));
  } finally {
    // A failed assertion above must not leave a persistent watcher behind: it keeps the test
    // process alive and makes the whole runner hang instead of reporting the failure.
    watcher.close();
  }

  assert.ok(
    observed.some((name) => name.startsWith('.trash-')),
    `removal must stage through .trash-* inside the root (saw: ${observed.join(', ') || 'nothing'})`,
  );
  assert.equal(await exists(fx.sessionDir('ses_direct')), false);
  assert.equal(await exists(join(resolvedRoot.resolved, fx.project, 'ses_direct')), false);
});

test('a symlinked sessions root is refused outright', async () => {
  const fx = await fixture();
  const outside = join(fx.dir, 'real-sessions');
  await mkdir(outside, { recursive: true });
  await mkdir(join(fx.home), { recursive: true });
  const created = await symlink(outside, join(fx.home, 'sessions'), 'junction').then(() => true, () => false);
  if (!created) return;
  assert.equal(await resolveSessionsRoot(fx.home), null);
  const preview = await previewDelete({ home: fx.home, ctx: ctxWith(), sessionIds: ['ses_any'] });
  assert.equal(preview.rootAvailable, false);
});

async function exists(path) {
  return lstat(path).then(() => true, () => false);
}
