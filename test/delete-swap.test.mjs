/**
 * The delete path must re-verify the *thing it is about to remove*, not the thing it scanned.
 *
 * `executeDelete` scans the tree once (`analyze`), records each session's directory, then acts
 * on those recorded paths. Between the scan and the removal it `await`s (the live-agent probe
 * happens *after* the scan), so anything that can rename a directory in that window redirects
 * the delete: the user asks to remove A, and B is removed at A's recorded path while the result
 * says `deleted`.
 *
 * The swap is made deterministic with a synchronous hook (`renameSync` inside `agents.get`,
 * which `analyze` calls after recording the directory) rather than racing a thread, so this
 * fails whenever the pre-removal `verifySessionDir` re-check is removed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renameSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, utimes, readFile, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { previewDelete, executeDelete } from '../lib/delete.js';
import { encodeSegment } from '../lib/session-files.js';

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-delete-swap-'));
  const home = join(dir, 'home');
  const root = join(home, 'sessions');
  const project = '--C-Work-demo--';
  return { dir, home, root, project, sessionDir: (id) => join(root, project, encodeSegment(id)) };
}

/** A settled artifact, aged past the write-quiet window so the lease check stays out of the way. */
async function makeSession(fx, id) {
  const target = fx.sessionDir(id);
  await mkdir(target, { recursive: true });
  const header = { type: 'session', version: 3, id, createdAt: 1_700_000_000_000, cwd: 'C:/Work/demo' };
  const log = join(target, 'session.v3.jsonl');
  await writeFile(log, `${JSON.stringify(header)}\n${JSON.stringify({ type: 'event', seq: 1 })}\n`, 'utf8');
  const stamp = new Date(Date.now() - 120_000);
  await utimes(log, stamp, stamp);
  return target;
}

const exists = (path) => lstat(path).then(() => true, () => false);

test('a directory swapped in after the scan is never deleted under the scanned id', async () => {
  const fx = await fixture();
  const victimDir = await makeSession(fx, 'ses_victim');
  const importantDir = await makeSession(fx, 'ses_important');

  // A preview with no swapping: the victim is offered as deletable.
  const preview = await previewDelete({ home: fx.home, ctx: { get: () => null }, sessionIds: ['ses_victim'] });
  assert.equal(preview.hardBlocked, false, 'the victim passes the preview');

  // Now the race: `analyze` records `victimDir` and then calls `agents.get` — inside that
  // window the two directories trade places, synchronously, exactly as a second process could.
  let swapped = false;
  const ctx = {
    get(name) {
      if (name !== 'agents') return null;
      return {
        get: () => {
          if (!swapped) {
            swapped = true;
            renameSync(victimDir, `${victimDir}.moved-aside`);
            renameSync(importantDir, victimDir);
          }
          return null; // idle: no running-session soft blocker
        },
      };
    },
  };

  const outcome = await executeDelete({ home: fx.home, ctx, sessionIds: ['ses_victim'], confirm: true });
  assert.equal(swapped, true, 'the swap really happened inside the delete window');

  const item = outcome.items[0];
  assert.notEqual(item.status, 'deleted', `the swapped-in directory must not be reported as deleted (got ${item.status}/${item.code})`);
  assert.equal(await exists(victimDir), true, 'the directory now sitting at the scanned path is untouched');
  const kept = await readFile(join(victimDir, 'session.v3.jsonl'), 'utf8');
  assert.match(kept, /ses_important/, 'and it is still the other session, not a half-deleted husk');
});

test('a quarantine that cannot be created fails loudly instead of reporting a delete', async () => {
  // The `ENOENT` that `mkdir` failure produces used to be read as "the target is already gone",
  // so the removal returned success, the caller counted the child in `subagentsRemoved`, and its
  // topic/archive records were dropped even though the directory was still on disk.
  const { removeVerifiedDir, resolveSessionsRoot } = await import('../lib/session-files.js');
  const { createRequire, syncBuiltinESMExports } = await import('node:module');
  const fx = await fixture();
  const dir = await makeSession(fx, 'ses_kept');
  const info = await resolveSessionsRoot(fx.home);
  assert.ok(info?.resolved, 'the sessions root resolves');

  const require = createRequire(import.meta.url);
  const fsp = require('node:fs/promises');
  const realMkdir = fsp.mkdir;
  fsp.mkdir = async (path, options) => {
    if (String(path).includes('.trash-')) throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    return realMkdir(path, options);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      () => removeVerifiedDir({ rootResolved: info.resolved, dir }),
      (error) => error.code === 'delete-incomplete',
      'a failed quarantine is an incomplete delete, never a silent success',
    );
    assert.equal(await exists(dir), true, 'and the data is still there');
  } finally {
    fsp.mkdir = realMkdir;
    syncBuiltinESMExports();
    await rm(fx.dir, { recursive: true, force: true });
  }
});
