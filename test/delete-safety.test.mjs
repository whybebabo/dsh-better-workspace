import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, lstat, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { previewDelete, executeDelete } from '../lib/delete.js';
import { isSafeSessionId, encodeSegment, removeVerifiedDir, resolveSessionsRoot } from '../lib/session-files.js';

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-topic-delete-'));
  const home = join(dir, 'home');
  const root = join(home, 'sessions');
  const project = '--C-Work-demo--';
  return { dir, home, root, project, sessionDir: (id) => join(root, project, encodeSegment(id)) };
}

async function makeSession(fx, id, extraHeader = {}, { lease = false } = {}) {
  const target = fx.sessionDir(id);
  await mkdir(target, { recursive: true });
  const header = { type: 'session', version: 3, id, createdAt: 1_700_000_000_000, cwd: 'C:/Work/demo', isSeeded: false, delegationDepth: 0, ...extraHeader };
  const body = `${JSON.stringify(header)}\n${JSON.stringify({ type: 'event', seq: 1 })}\n`;
  await writeFile(join(target, 'session.v3.jsonl'), body, 'utf8');
  if (lease) await writeFile(join(target, 'session.v3.jsonl.lock'), 'holder', 'utf8');
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
  await makeSession(fx, 'ses_locked', {}, { lease: true });
  await makeSession(fx, 'ses_parent');
  const preview = await previewDelete({
    home: fx.home,
    ctx: ctxWith({ ses_parent: { status: 'running', cancel: async () => {} } }),
    sessionIds: ['ses_child', 'ses_locked', 'ses_parent'],
  });
  const byId = Object.fromEntries(preview.items.map((item) => [item.sessionId, item]));
  assert.equal(byId.ses_child.subagent, true);
  assert.equal(byId.ses_child.blockers.find((b) => b.code === 'subagent').severity, 'hard');
  assert.equal(byId.ses_locked.blockers.find((b) => b.code === 'locked').severity, 'hard');
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
  await makeSession(fx, 'ses_sub1', { origin: 'subagent', parentSession: 'ses_main' });
  await makeSession(fx, 'ses_sub2', { parentSession: 'ses_sub1' });
  await makeSession(fx, 'ses_other');
  await makeSession(fx, 'ses_locked', {}, { lease: true });

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
