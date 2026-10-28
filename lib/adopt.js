/**
 * Workspace membership repair.
 *
 * DSH decides which workspace a session belongs to from its artifact header: a session whose
 * canonical `cwd` equals a registered workspace path should be accounted by that workspace
 * (`workspace.sessionIds`). The host attaches sessions on its own `session.create` path, but a
 * session started through another route — a resumed blank, a fork, a host that crashed between
 * the header write and `attachSession`, or a workspace registration that was deleted and
 * re-created — can end up with the right `cwd` and no accounting slot.
 *
 * The native list treats such a session as "no workspace accounts for it" and shows it under
 * 未分组. That is not data loss, but it looks like one: closing/reopening, or removing this
 * plugin, leaves the session in the trailing bucket instead of the workspace it was started
 * in.
 *
 * This module re-attaches exactly those sessions — and only those — through the host's own
 * `workspace.attachSession(id)`, which re-validates `cwd` against the workspace path, refuses
 * a mismatch, and prepends the id (so the session lands at the top of its workspace, where the
 * native ordering puts a new session). It never moves a session out of a workspace, never
 * touches subagent children, archived sessions, or sessions whose cwd matches nothing.
 */
import { realpath } from 'node:fs/promises';
import { foldPath } from './session-files.js';

/** Host services are optional: a headless or differently-composed boot simply skips repair. */
function service(ctx, name) {
  try {
    return ctx?.get?.(name) ?? null;
  } catch {
    return null;
  }
}

/**
 * @param {object} input
 * @param {object} input.ctx - host context (services resolved lazily)
 * @returns {Promise<{available: boolean, scanned: number, accounted: number, adopted: string[],
 *   moved: string[], skipped: number, failed: Array<{sessionId: string, error: string}>}>}
 *   `adopted` lists every id the repair now accounts for (including ones a concurrent tab had
 *   already attached); `moved` narrows that to the ids *this* call changed, which is what the
 *   panel reports so two windows cannot both claim the same write.
 */
export async function adoptOrphanSessions({ ctx }) {
  const registry = service(ctx, 'workspaceRegistry');
  const persistence = service(ctx, 'sessionPersistence');
  const unavailable = { available: false, scanned: 0, accounted: 0, adopted: [], moved: [], skipped: 0, failed: [] };
  if (!registry || typeof registry.list !== 'function') return unavailable;
  if (!persistence || typeof persistence.list !== 'function') return unavailable;

  const workspaces = (() => {
    try {
      return registry.list();
    } catch {
      // A registry that is registered but not started throws from `list()`; the repair is
      // best-effort, so a boot-order race reports "unavailable" instead of a 500.
      return null;
    }
  })();
  if (!Array.isArray(workspaces)) return unavailable;
  if (workspaces.length === 0) return { ...unavailable, available: true };

  // Membership is path-keyed in the native domain (`candidateMatches` compares canonical
  // paths), so the workspace lookup uses the record's canonical path, not its display title.
  // The exact map answers first; the folded map only absorbs the `C:\Users` vs `c:\users`
  // kind of difference two `realpath` callers can legitimately produce on Windows. The lookup
  // is a *pre-filter*: `attachSession` below re-validates the path itself and refuses a
  // mismatch, so a wrong candidate can never move a session.
  const byPath = new Map();
  const byFoldedPath = new Map();
  for (const workspace of workspaces) {
    if (typeof workspace?.path !== 'string' || workspace.path === '') continue;
    // The host normally stores a canonical path, but a workspace registered through a symlinked
    // spelling keeps that spelling. `header.cwd` below is canonicalized, so register both forms;
    // without this a macOS `/var` vs `/private/var` (or any symlinked project) never matches and
    // the repair silently does nothing.
    const canonical = await realpath(workspace.path).catch(() => null);
    const keys = canonical && canonical !== workspace.path ? [workspace.path, canonical] : [workspace.path];
    for (const key of keys) {
      if (!byPath.has(key)) byPath.set(key, workspace);
      const folded = foldPath(key);
      if (folded !== '' && !byFoldedPath.has(folded)) byFoldedPath.set(folded, workspace);
    }
  }
  /**
   * Which ids any workspace *record* already lists — read raw, not through the entity's
   * `sessionIds` getter.
   *
   * That getter filters out ids whose canonical cwd no longer equals the record's path, so a
   * session sitting in `record.sessionIds` with a stale path looks "unaccounted" through it.
   * Attaching such an id to another workspace would leave it in two records at once, and the
   * native `validateStoredState` refuses to boot a registry where one session is accounted
   * twice. Those sessions are exactly the ones the native domain deliberately hides, so they
   * are out of scope here and must be skipped, not repaired.
   */
  const accountedBy = new Map();
  const table = registry?.table;
  const recordIds = (record) => (Array.isArray(record?.sessionIds) ? record.sessionIds : []);
  if (table && typeof table.keys === 'function' && typeof table.get === 'function') {
    for (const key of [...table.keys()]) {
      for (const id of recordIds(table.get(key))) accountedBy.set(id, key);
    }
  } else {
    // Without the raw table the entity getter is the only source, and it hides ids whose cwd no
    // longer matches the record. Treating those as unaccounted would attach one session to two
    // records at once, and the native registry refuses to boot such a state — so skip the whole
    // repair rather than guess.
    return { ...unavailable, available: false };
  }
  const archived = new Set(Array.isArray(registry.archivedSessionIds) ? registry.archivedSessionIds : []);

  const snapshots = await persistence.list().catch(() => []);
  const headers = (Array.isArray(snapshots) ? snapshots : [])
    .map((snapshot) => snapshot?.header)
    .filter((header) => header && typeof header.id === 'string' && header.id !== '');

  const adopted = [];
  const moved = [];
  const failed = [];
  let skipped = 0;
  for (const header of headers) {
    if (header.origin === 'subagent') {
      skipped += 1;
      continue;
    }
    if (accountedBy.has(header.id) || archived.has(header.id)) {
      skipped += 1;
      continue;
    }
    if (typeof header.cwd !== 'string' || header.cwd === '') {
      skipped += 1;
      continue;
    }
    const canonical = await realpath(header.cwd).catch(() => null);
    const workspace = canonical === null
      ? null
      : byPath.get(canonical) ?? byFoldedPath.get(foldPath(canonical)) ?? null;
    if (!workspace) {
      skipped += 1;
      continue;
    }
    try {
      const before = Array.isArray(workspace.sessionIds) ? workspace.sessionIds : [];
      await workspace.attachSession(header.id);
      adopted.push(header.id);
      // Guard against attaching one id twice if the persistence snapshot lists it twice.
      accountedBy.set(header.id, workspace.id);
      // `attachSession` is idempotent, so a concurrent tab (or a retry) can return cleanly
      // without this run having changed anything. Only count a real transition, or two tabs
      // both toast "moved N sessions" for one write.
      if (!before.includes(header.id)) moved.push(header.id);
    } catch (error) {
      // A refused attach (cwd moved, workspace deleted mid-run) is reported, never forced.
      failed.push({ sessionId: header.id, error: String(error?.message ?? error) });
    }
  }

  return { available: true, scanned: headers.length, accounted: accountedBy.size, adopted, moved, skipped, failed };
}
