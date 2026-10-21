/**
 * Session artifact file layout + path safety.
 *
 * DSH stores each session as `<DSH_HOME>/sessions/<project-key>/<encoded-id>/session.v<N>.jsonl[.zstd]`.
 * There is no official host-side delete, so this module resolves and *verifies* those
 * directories before anything is removed: every path is anchored against the realpath of
 * the sessions root, and the artifact header must confirm `id === sessionId`.
 */
import { open, readdir, lstat, realpath, stat, rm, rename, mkdir } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';

const require = createRequire(import.meta.url);
const zlib = require('node:zlib');

const LOG_FILE_RE = /^session\.v(\d+)\.jsonl(\.zstd)?$/;
const HEADER_READ_BYTES = 64 * 1024;

/** Mirrors dsh-session-persistence-jsonl's segment encoding so ids map to directories. */
export function encodeSegment(raw) {
  let out = '';
  for (const char of String(raw)) {
    if (/[A-Za-z0-9._-]/.test(char)) out += char;
    else out += `~${char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
  }
  if (out === '.') out = '~002E';
  if (out === '..') out = '~002E~002E';
  return out;
}

/** A session id must be a single, traversal-free path segment. */
export function isSafeSessionId(id) {
  return typeof id === 'string'
    && id.length > 0
    && id.length <= 128
    && !id.includes('/')
    && !id.includes('\\')
    && !id.includes('\0')
    && id !== '.'
    && id !== '..'
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id);
}

export function sessionsRoot(home) {
  return join(home, 'sessions');
}

async function isRealDirectory(path) {
  try {
    const info = await lstat(path);
    if (!info.isDirectory()) return false;
    if (info.isSymbolicLink()) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves the sessions root, rejecting it when it is a symlink/junction: an attacker
 * (or a mistaken DSH_HOME) could otherwise point the plugin at an unrelated tree.
 */
export async function resolveSessionsRoot(home) {
  const root = sessionsRoot(home);
  if (!(await isRealDirectory(root))) return null;
  const resolved = await realpath(root).catch(() => null);
  if (resolved === null) return null;
  if (resolved !== root) {
    const direct = await lstat(root).catch(() => null);
    if (direct?.isSymbolicLink()) return null;
  }
  return { root, resolved };
}

/** True when `target` is inside `rootResolved` without traversing a link. */
export function isWithin(target, rootResolved) {
  if (target === rootResolved) return false;
  const prefix = rootResolved.endsWith(sep) ? rootResolved : rootResolved + sep;
  return target.startsWith(prefix);
}

/** Every path component below the root must be a real, non-link directory. */
async function chainIsSafe(rootResolved, target) {
  const relative = target.slice(rootResolved.length + 1).split(sep).filter(Boolean);
  let cursor = rootResolved;
  for (const segment of relative) {
    cursor = join(cursor, segment);
    const info = await lstat(cursor).catch(() => null);
    if (!info) return false;
    if (info.isSymbolicLink()) return false;
  }
  const resolved = await realpath(target).catch(() => null);
  return resolved === target;
}

export async function listLogFiles(dir) {
  const names = await readdir(dir).catch(() => []);
  const logs = [];
  for (const name of names) {
    const match = LOG_FILE_RE.exec(name);
    if (!match) continue;
    const info = await lstat(join(dir, name)).catch(() => null);
    if (!info || !info.isFile() || info.isSymbolicLink()) continue;
    logs.push({ name, version: Number(match[1]), compressed: Boolean(match[2]), size: info.size });
  }
  logs.sort((left, right) => right.version - left.version);
  return logs;
}

/**
 * True when a write lease is currently *held* on the session directory.
 *
 * The DSH persistence backend does not use a lock file as a liveness signal:
 *   - Windows takes a named kernel semaphore (`Local\dsh-session-lock-<sha256>`) with no
 *     filesystem footprint at all;
 *   - POSIX keeps `session.lock` forever once created ("Release never removes the POSIX lock
 *     file"), so its *presence* proves nothing about a live writer.
 *
 * Reading `*.lock` filenames therefore reported "never locked" on Windows and "always locked"
 * on POSIX — both wrong, in opposite directions. Since neither platform lets this process ask
 * the kernel "who holds this lease?" through a plain fs call, the honest portable signal is
 * the artifact's freshness: a session being appended to right now has a very recent mtime.
 * That is conservative in the safe direction — a quiet-but-live session may be missed, but a
 * running one is caught — and it never falsely blocks deletion forever.
 */
export async function hasWriteLease(dir, { now = Date.now(), quietMs = 15_000 } = {}) {
  const logs = await listLogFiles(dir).catch(() => []);
  const newest = logs[0];
  if (!newest) return false;
  const info = await stat(join(dir, newest.name)).catch(() => null);
  if (!info) return false;
  return now - info.mtimeMs < quietMs;
}

function decompressZstd(buffer) {
  const fn = zlib?.zstdDecompressSync ?? zlib?.decompressZstdSync;
  if (typeof fn !== 'function') throw Object.assign(new Error('当前 Node 运行时不支持 zstd 解压'), { code: 'zstd-unsupported' });
  return fn(buffer);
}

/**
 * A subagent child is classified by `origin`. `parentSession` alone is the seed lineage of
 * a user fork, so it must not be treated as a subagent (the host can delete forks safely).
 */
export function isSubagentHeader(header) {
  return header?.origin === 'subagent';
}

/** Reads the first JSONL record — the session header — from a directory's newest artifact. */
export async function readSessionHeader(dir) {
  const logs = await listLogFiles(dir);
  if (logs.length === 0) return null;
  const entry = logs[0];
  const path = join(dir, entry.name);
  const handle = await open(path, 'r');
  try {
    const length = Math.min(entry.size, HEADER_READ_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, 0);
    const text = entry.compressed ? decompressZstd(buffer).toString('utf8') : buffer.toString('utf8');
    const line = text.split('\n', 1)[0];
    const header = JSON.parse(line);
    return { header, log: entry, path };
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * Finds the artifact directory for one session id.
 * Scans `<root>/<project>/<encoded-id>` — the project key is not recomputed because
 * `dsh-home-paths` may change its encoding between versions; the header identity check
 * is what makes a match trustworthy.
 */
export async function locateSessionDir({ rootResolved, sessionId, hintProject }) {
  const segment = encodeSegment(sessionId);
  const candidates = [];
  if (typeof hintProject === 'string' && hintProject !== '') {
    candidates.push({ project: hintProject, dir: join(rootResolved, hintProject, segment) });
  } else {
    const projects = await readdir(rootResolved).catch(() => []);
    for (const project of projects) {
      if (project.startsWith('.')) continue;
      candidates.push({ project, dir: join(rootResolved, project, segment) });
    }
  }
  const found = [];
  for (const { project, dir: candidate } of candidates) {
    const info = await lstat(candidate).catch(() => null);
    if (!info || !info.isDirectory() || info.isSymbolicLink()) continue;
    if (!isWithin(candidate, rootResolved)) continue;
    if (!(await chainIsSafe(rootResolved, candidate))) continue;
    const resolved = await realpath(candidate).catch(() => null);
    if (resolved !== candidate) continue;
    let header = null;
    try {
      header = await readSessionHeader(candidate);
    } catch (error) {
      if (error?.code === 'zstd-unsupported') throw error;
      header = null;
    }
    if (!header) continue;
    if (header.header?.type !== 'session' || header.header?.id !== sessionId) continue;
    found.push({
      dir: candidate,
      project,
      relative: candidate.slice(rootResolved.length + 1),
      header: header.header,
      log: header.log,
      logPath: header.path,
    });
  }
  return found;
}

/**
 * One pass over the sessions tree: `id -> entry` plus `parent -> children`.
 *
 * Resolving many ids one at a time used to re-read every artifact header per id, which made a
 * bulk preview O(ids x sessions) file reads. One scan answers both "where is this id" and "who
 * are its subagents" for the whole batch, so the delete path stays linear in tree size.
 *
 * @param {string[]|null} projects - project keys to scan; `null` scans all of them
 */
export async function scanSessionIndex({ rootResolved, projects = null }) {
  const byId = new Map();
  const childrenOf = new Map();
  const names = projects ?? (await readdir(rootResolved).catch(() => [])).filter((name) => !name.startsWith('.'));
  for (const project of names) {
    const projectDir = join(rootResolved, project);
    if (!(await isRealDirectory(projectDir))) continue;
    const entries = await readdir(projectDir).catch(() => []);
    for (const name of entries) {
      const dir = join(projectDir, name);
      if (!isWithin(dir, rootResolved)) continue;
      const info = await lstat(dir).catch(() => null);
      if (!info || !info.isDirectory() || info.isSymbolicLink()) continue;
      if (!(await chainIsSafe(rootResolved, dir))) continue;
      let header;
      try {
        header = (await readSessionHeader(dir))?.header;
      } catch {
        continue;
      }
      if (!header || header.type !== 'session' || typeof header.id !== 'string' || header.id === '') continue;
      if (byId.has(header.id)) continue;
      byId.set(header.id, { dir, project, relative: dir.slice(rootResolved.length + 1), header });
      // Only subagent children cascade. A user fork also carries parentSession, but it is a
      // top-level session and must survive when its source is deleted.
      if (isSubagentHeader(header) && typeof header.parentSession === 'string' && header.parentSession !== '') {
        const siblings = childrenOf.get(header.parentSession) ?? [];
        siblings.push(header.id);
        childrenOf.set(header.parentSession, siblings);
      }
    }
  }
  return { byId, childrenOf };
}

/** Every session whose header chains up to `sessionId`, at any depth. */
export function descendantsOf(index, sessionId) {
  const found = [];
  const seen = new Set([sessionId]);
  const stack = [...(index.childrenOf.get(sessionId) ?? [])];
  while (stack.length > 0) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    const entry = index.byId.get(id);
    if (!entry) continue;
    found.push({ dir: entry.dir, project: entry.project, id, header: entry.header });
    stack.push(...(index.childrenOf.get(id) ?? []));
  }
  return found;
}

/**
 * Re-checks one known directory immediately before it is removed: still inside the root,
 * still a real directory reached without links, and its header still identifies `sessionId`.
 * This is the cheap re-verification that used to be a full tree scan.
 */
export async function verifySessionDir({ rootResolved, dir, sessionId }) {
  if (!isWithin(dir, rootResolved)) return null;
  const info = await lstat(dir).catch(() => null);
  if (!info || !info.isDirectory() || info.isSymbolicLink()) return null;
  if (!(await chainIsSafe(rootResolved, dir))) return null;
  const resolved = await realpath(dir).catch(() => null);
  if (resolved !== dir) return null;
  const header = await readSessionHeader(dir).catch(() => null);
  if (!header || header.header?.type !== 'session' || header.header?.id !== sessionId) return null;
  return header.header;
}

/** Subagent sessions whose header declares `origin === 'subagent'` and `parentSession === sessionId`. */
export async function findDescendants({ rootResolved, sessionId, sameProjectOnly = true }) {
  let projects = null;
  if (sameProjectOnly) {
    const owner = await locateSessionDir({ rootResolved, sessionId }).catch(() => []);
    if (owner.length === 0) return [];
    projects = [...new Set([...owner.map((match) => match.project), '_no-cwd'])];
  }
  const index = await scanSessionIndex({ rootResolved, projects });
  return descendantsOf(index, sessionId);
}

export async function directorySize(dir) {
  let total = 0;
  const names = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of names) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) total += await directorySize(path);
    else if (entry.isFile()) total += (await stat(path).catch(() => null))?.size ?? 0;
  }
  return total;
}

/**
 * `rm -rf` that refuses to touch anything outside the verified root, then proves it worked.
 *
 * The verification and the removal must not be separable: checking a path and then `rm`-ing it
 * leaves a window in which an intermediate component (`<root>/<project>`) can be swapped for a
 * junction, after which the recursive delete follows the link out of the tree. So the target is
 * first *renamed* into a quarantine directory inside the root — `rename` is atomic, resolves
 * the path once, and fails outright if the name it resolved is no longer a real directory —
 * and only the quarantined copy is removed. Nothing outside the root can be reached.
 */
export async function removeVerifiedDir({ rootResolved, dir }) {
  if (!isWithin(dir, rootResolved)) throw Object.assign(new Error('拒绝删除: 目标不在 sessions 根目录内'), { code: 'unsafe-path' });
  if (!(await chainIsSafe(rootResolved, dir))) throw Object.assign(new Error('拒绝删除: 路径包含链接或已偏离预期'), { code: 'unsafe-path' });
  const info = await lstat(dir).catch(() => null);
  if (!info || !info.isDirectory() || info.isSymbolicLink()) throw Object.assign(new Error('拒绝删除: 目标不是普通目录'), { code: 'unsafe-path' });

  // `ENOENT` below has two opposite meanings: "the target is already gone" (success) and
  // "our own quarantine directory was never created" (the target was never moved). Creating
  // the quarantine is therefore the one step allowed to fail loudly — a swallowed mkdir error
  // used to turn every later rename into ENOENT and report a delete that never happened.
  const quarantine = join(rootResolved, `.trash-${process.pid}-${randomBytes(6).toString('hex')}`);
  try {
    await mkdir(quarantine);
  } catch (error) {
    throw Object.assign(new Error(`无法创建隔离区: ${error?.message || error}`), { code: 'delete-incomplete' });
  }
  const doomed = join(quarantine, 'target');
  try {
    await rename(dir, doomed);
  } catch (error) {
    // Busy/handle-held: leave the data alone rather than failing halfway.
    await rm(quarantine, { recursive: true, force: true }).catch(() => {});
    if (error?.code === 'ENOENT') {
      // Only "already gone" when the source really is absent; otherwise the rename failed for
      // an unrelated reason and claiming success would hide a surviving directory.
      if (await lstat(dir).then(() => false, (probe) => probe?.code === 'ENOENT')) return;
      throw Object.assign(new Error('无法移入隔离区: 目标仍然存在'), { code: 'delete-incomplete' });
    }
    throw Object.assign(new Error(`无法移入隔离区: ${error?.message || error}`), { code: 'delete-incomplete' });
  }

  // The moved entry must still be a real directory (a junction would have moved as a link and
  // must not be recursively followed).
  const moved = await lstat(doomed).catch(() => null);
  if (!moved || moved.isSymbolicLink() || !moved.isDirectory()) {
    await rm(quarantine, { recursive: true, force: true }).catch(() => {});
    throw Object.assign(new Error('拒绝删除: 隔离目标不是普通目录'), { code: 'unsafe-path' });
  }
  await rm(quarantine, { recursive: true, force: true });
  if (await lstat(doomed).then(() => true, () => false)) {
    throw Object.assign(new Error('删除后目录仍存在(可能被占用),已保留数据'), { code: 'delete-incomplete' });
  }
  if (await lstat(dir).then(() => true, () => false)) {
    throw Object.assign(new Error('删除后原目录仍存在,已保留数据'), { code: 'delete-incomplete' });
  }
}
