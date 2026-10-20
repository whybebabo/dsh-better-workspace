/**
 * Topic sidecar store.
 *
 * Owns `<DSH_HOME>/dsh-better-workspace/topics.v1.json`: a cross-process safe,
 * revision-checked JSON document holding per-workspace topic folders and the
 * session -> topic assignments. Deliberately kept off the official storage
 * domain so the data is a single, backup-able file that survives plugin removal.
 */
import { open, rename, copyFile, mkdir, rm, stat, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { ZEN_EMOJIS } from './emojis.js';

export const STORE_VERSION = 1;
export const STORE_DIR = 'dsh-better-workspace';
/** Reserved per-workspace group the host creates automatically; it cannot be renamed or deleted. */
export const DEFAULT_TOPIC_ID = 'tp_default';
export const DEFAULT_TOPIC_NAME = '默认分组';
/** Picker glyphs mirror Zen Browser's emoji picker; a topic may still carry any other glyph. */
export const TOPIC_EMOJIS = ZEN_EMOJIS;

const WORKSPACE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TOPIC_NAME_MAX = 40;
const BATCH_MAX = 200;

export class StoreError extends Error {
  constructor(message, code, status = 400) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
    this.status = status;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function resolveDshHome(configured) {
  const fromConfig = typeof configured === 'string' && configured.trim() !== '' ? configured.trim() : '';
  const fromEnv = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== '' ? process.env.DSH_HOME.trim() : '';
  return fromConfig || fromEnv || join(homedir(), '.dsh');
}

export function normalizeTopicName(raw) {
  const name = typeof raw === 'string' ? raw.replace(/[\u0000-\u001f\u007f]/g, '').trim() : '';
  if (name.length === 0) throw new StoreError('主题名称不能为空', 'topic-name-empty');
  if (name.length > TOPIC_NAME_MAX) throw new StoreError(`主题名称最多 ${TOPIC_NAME_MAX} 个字符`, 'topic-name-too-long');
  return name;
}

/**
 * Topic markers are emoji. The check is a length/shape guard, not a whitelist: users should
 * be able to pick any glyph, including ones outside our picker. ZWJ and tag sequences such as
 * 👩‍❤️‍💋‍👨 or 🏴󠁧󠁢󠁥󠁮󠁧󠁿 span up to 8 code points, so the cap allows 16. `null` means "not
 * supplied", `''` means "deliberately no marker" (the row then shows a plain dash).
 */
export function normalizeTopicEmoji(raw) {
  if (raw === null) return '';
  if (raw === undefined) return null;
  if (typeof raw !== 'string') throw new StoreError('主题图标不合法', 'bad-emoji');
  return Array.from(raw.replace(/[\u0000-\u001f\u007f]/g, '').trim()).slice(0, 16).join('');
}

/** Next unused picker glyph, so freshly created topics do not all look the same. */
export function pickTopicEmoji(taken = []) {
  const used = new Set(taken);
  return TOPIC_EMOJIS.find((glyph) => !used.has(glyph)) ?? '';
}

export function validateWorkspaceId(raw) {
  if (typeof raw !== 'string' || !WORKSPACE_ID_RE.test(raw)) throw new StoreError('工作区标识不合法', 'bad-workspace');
  return raw;
}

export function validateSessionIds(raw, { allowEmpty = false, max = BATCH_MAX } = {}) {
  if (!Array.isArray(raw)) throw new StoreError('sessionIds 必须是数组', 'bad-session-ids');
  if (raw.length === 0 && !allowEmpty) throw new StoreError('sessionIds 不能为空', 'bad-session-ids');
  if (raw.length > max) throw new StoreError(`一次最多处理 ${max} 个会话`, 'batch-too-large');
  const seen = new Set();
  for (const id of raw) {
    if (typeof id !== 'string' || !SESSION_ID_RE.test(id)) throw new StoreError(`会话标识不合法: ${String(id).slice(0, 32)}`, 'bad-session-id');
    seen.add(id);
  }
  return [...seen];
}

function emptyBucket() {
  return { topics: [], assignments: Object.create(null) };
}

function defaultTopic() {
  return { id: DEFAULT_TOPIC_ID, name: DEFAULT_TOPIC_NAME, emoji: '', order: -1, createdAt: 0, system: true };
}

/** Every workspace owns the reserved default group; missing ones are restored on sight. */
function ensureDefaultTopic(bucket) {
  if (bucket.topics.some((topic) => topic.id === DEFAULT_TOPIC_ID)) {
    const topic = bucket.topics.find((entry) => entry.id === DEFAULT_TOPIC_ID);
    topic.system = true;
    return;
  }
  bucket.topics.unshift(defaultTopic());
}

function nextTopicId(now) {
  return `tp_${now(1).toString(36)}_${randomBytes(4).toString('hex')}`;
}

export function createTopicStore(options = {}) {
  const now = options.now ?? (() => Date.now());
  const home = typeof options.home === 'function' ? options.home() : (options.home ?? resolveDshHome(options.configuredHome));
  const dir = options.dir ?? join(home, STORE_DIR);
  const file = options.file ?? join(dir, 'topics.v1.json');
  const lockFile = options.lockFile ?? join(dir, 'topics.v1.lock');
  const bakFile = options.bakFile ?? `${file}.bak`;

  /** True while the document on disk is known to be unreadable (writes must be refused). */
  let corrupt = false;

  async function ensureDir() {
    await mkdir(dir, { recursive: true });
  }

  /**
   * A lock file we hold carries `<pid>-<rand>`; a stolen one carries someone else's.
   * `releaseLock` compares before unlinking, so a holder that was judged stale can never
   * delete the lock its successor just took (that bug silently dropped writes).
   */
  async function readLockToken() {
    return readFile(lockFile, 'utf8').catch(() => null);
  }

  /**
   * Whether the process named in a lock token is still running. A lock whose owner is dead is
   * safe to reclaim; one whose owner is alive must be waited out, however old its mtime is —
   * a slow `transform` would otherwise be evicted mid-write and lose its update.
   */
  function tokenOwnerIsAlive(token) {
    if (typeof token !== 'string' || token === '') return null; // unreadable: unknown
    const pid = Number.parseInt(token.split('-')[0], 10);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    if (pid === process.pid) return true;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      // EPERM means the process exists but belongs to another user.
      if (error?.code === 'EPERM') return true;
      return false; // ESRCH: no such process
    }
  }

  /**
   * Reclaims a stale lock by *renaming* it away, not by unlinking it. `rename` is atomic and
   * only one contender can win the move, so two processes that both judged the lock stale
   * cannot both end up believing they evicted the same holder.
   */
  async function evictStaleLock(token) {
    const claim = `${lockFile}.stale.${process.pid}.${randomBytes(4).toString('hex')}`;
    try {
      await rename(lockFile, claim);
    } catch {
      return false; // someone else won the eviction (or the holder released it)
    }
    // Guard against evicting a live holder that refreshed between our stat and the rename.
    const moved = await readFile(claim, 'utf8').catch(() => null);
    if (moved !== null && token !== null && moved !== token) {
      // The lock changed hands in the meantime: put the *new* holder's file back if the
      // path is still free, then report failure so we keep waiting.
      try {
        await rename(claim, lockFile);
      } catch {
        await rm(claim, { force: true }).catch(() => {});
      }
      return false;
    }
    await rm(claim, { force: true }).catch(() => {});
    return true;
  }

  async function acquireLock() {
    await ensureDir();
    const token = `${process.pid}-${randomBytes(8).toString('hex')}`;
    const started = Date.now();
    const staleAfter = options.staleLockMs ?? 10_000;
    const deadline = () => Date.now() - started > (options.lockWaitMs ?? 3_000);
    for (;;) {
      // Check the deadline first: the stale-reclaim branch must not be able to spin forever
      // (a lock file that is a directory, or one busy scanners keep open, made rm fail).
      if (deadline()) throw new StoreError('主题存储正被其他进程占用,请稍后重试', 'store-locked', 409);
      try {
        const handle = await open(lockFile, 'wx', 0o600);
        try {
          await handle.writeFile(token, 'utf8');
          await handle.sync();
        } finally {
          await handle.close();
        }
        return token;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw new StoreError(`无法访问主题存储: ${error?.message || error}`, 'store-unavailable', 500);
        const info = await stat(lockFile).catch(() => null);
        if (info && !info.isFile()) {
          throw new StoreError('主题存储锁路径不是普通文件,请手动检查', 'store-locked', 409);
        }
        // Reclaim only when the owner is *provably* gone. mtime alone is not proof: a slow
        // transform can legitimately hold the lock longer than `staleLockMs`.
        const mtimeStale = info && Date.now() - info.mtimeMs > staleAfter;
        if (mtimeStale) {
          const observed = await readLockToken();
          const ownerAlive = tokenOwnerIsAlive(observed);
          if (ownerAlive === false) {
            await evictStaleLock(observed);
            // Whether or not we won the eviction, loop; the next open() decides the winner.
            continue;
          }
          // Owner alive (or unknown, e.g. another machine): keep waiting for it to release.
        }
        await sleep(25 + Math.floor(Math.random() * 35));
      }
    }
  }

  async function releaseLock(token) {
    // Only the owner may release: a stolen lock must survive its previous holder's exit.
    const held = await readLockToken();
    if (held === null || held !== token) return;
    await rm(lockFile, { force: true }).catch(() => {});
  }

  function fresh() {
    return { version: STORE_VERSION, revision: 0, updatedAt: 0, workspaces: Object.create(null) };
  }

  function sanitize(parsed) {
    const state = fresh();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    if (parsed.version !== STORE_VERSION) throw new Error(`unsupported version ${parsed.version}`);
    state.revision = Number.isInteger(parsed.revision) && parsed.revision >= 0 ? parsed.revision : 0;
    state.updatedAt = Number.isFinite(parsed.updatedAt) ? parsed.updatedAt : 0;
    const workspaces = parsed.workspaces;
    if (!workspaces || typeof workspaces !== 'object' || Array.isArray(workspaces)) throw new Error('workspaces missing');
    for (const [workspaceId, raw] of Object.entries(workspaces)) {
      if (!WORKSPACE_ID_RE.test(workspaceId)) continue;
      const bucket = emptyBucket();
      const topics = Array.isArray(raw?.topics) ? raw.topics : [];
      const seenIds = new Set();
      for (const entry of topics) {
        const id = typeof entry?.id === 'string' && entry.id !== '' ? entry.id : null;
        const name = typeof entry?.name === 'string' ? entry.name : '';
        if (!id || seenIds.has(id) || name.length === 0) continue;
        seenIds.add(id);
        bucket.topics.push({
          id,
          name,
          emoji: normalizeTopicEmoji(entry?.emoji ?? '') ?? '',
          order: Number.isFinite(entry?.order) ? entry.order : bucket.topics.length,
          createdAt: Number.isFinite(entry?.createdAt) ? entry.createdAt : now(),
        });
      }
      ensureDefaultTopic(bucket);
      seenIds.add(DEFAULT_TOPIC_ID);
      bucket.topics.sort((left, right) => left.order - right.order);
      const assignments = raw?.assignments && typeof raw.assignments === 'object' ? raw.assignments : {};
      for (const [sessionId, topicId] of Object.entries(assignments)) {
        if (!SESSION_ID_RE.test(sessionId)) continue;
        if (typeof topicId !== 'string' || !seenIds.has(topicId)) continue;
        bucket.assignments[sessionId] = topicId;
      }
      state.workspaces[workspaceId] = bucket;
    }
    return state;
  }

  /**
   * Reads the document, falling back to `.bak` when the primary is unparsable.
   *
   * `state === null` is a sentinel meaning "a file exists but nothing readable could be
   * recovered". Callers must refuse to write in that case: silently starting from an empty
   * document would replace the user's whole topic tree with `{revision: 1}`.
   */
  async function readState() {
    let text;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return { state: fresh(), corrupt: false, fresh: true };
      throw new StoreError(`无法读取主题存储: ${error?.message || error}`, 'store-unreadable', 500);
    }
    try {
      return { state: sanitize(JSON.parse(text)), corrupt: false };
    } catch (error) {
      // Primary document is unusable; fall back to the last good write.
      try {
        const backup = await readFile(bakFile, 'utf8');
        const state = sanitize(JSON.parse(backup));
        corrupt = true;
        return { state, corrupt: true, reason: `主文件已损坏(${error?.message || error}),已回退到备份` };
      } catch {
        corrupt = true;
        return {
          state: null,
          corrupt: true,
          reason: `主题存储文件无法解析(${error?.message || error}),已切换为只读`,
        };
      }
    }
  }

  /**
   * Keeps a copy of an unreadable document next to the store so the user (or support) can
   * salvage it by hand. Best-effort: a failure here must not block the recovery write.
   */
  async function quarantineCorruptFile() {
    const copy = `${file}.corrupt-${now()}`;
    await copyFile(file, copy).catch(() => {});
    return copy;
  }

  /**
   * @param {object} state document to persist
   * @param {object} [opts]
   * @param {boolean} [opts.skipBackup] set when `state` was recovered from `.bak`: the primary
   *   on disk is then known-bad, and copying it over the backup would destroy the only good
   *   copy (`mutate` then has nothing left to fall back on).
   */
  async function writeState(state, { skipBackup = false } = {}) {
    const tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
    const payload = `${JSON.stringify(state, null, 2)}\n`;
    const handle = await open(tmp, 'w', 0o600);
    try {
      await handle.writeFile(payload, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (!skipBackup && await stat(file).then(() => true, () => false)) {
      // Move rather than copy: a half-written copy on power loss would be as unusable as the
      // file it is meant to replace.
      const bakTmp = `${bakFile}.${process.pid}.tmp`;
      try {
        await copyFile(file, bakTmp);
        await rename(bakTmp, bakFile);
      } catch {
        await rm(bakTmp, { force: true }).catch(() => {});
      }
    }
    // Windows can hold a rename target briefly after a reader closes it.
    let lastError = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await rename(tmp, file);
        return;
      } catch (error) {
        lastError = error;
        if (!['EBUSY', 'EPERM', 'EACCES'].includes(error?.code)) break;
        await sleep(40 * (attempt + 1));
      }
    }
    await rm(tmp, { force: true }).catch(() => {});
    throw new StoreError(`主题存储写入失败: ${lastError?.message || lastError}`, 'store-write-failed', 500);
  }

  function topicById(bucket, topicId) {
    return bucket.topics.find((topic) => topic.id === topicId) ?? null;
  }

  function requireTopic(bucket, topicId) {
    const topic = topicById(bucket, topicId);
    if (!topic) throw new StoreError('主题不存在', 'topic-not-found', 404);
    return topic;
  }

  function bucketFor(state, workspaceId, create) {
    let bucket = state.workspaces[workspaceId];
    if (!bucket) {
      if (!create) throw new StoreError('工作区尚无主题数据', 'workspace-not-found', 404);
      bucket = emptyBucket();
      ensureDefaultTopic(bucket);
      state.workspaces[workspaceId] = bucket;
    }
    return bucket;
  }

  /**
   * @param {number|null|undefined} expectedRevision client's last known revision; mismatch is a 409
   * @param {(state: any) => any} transform mutates the loaded document and returns a result payload
   * @param {object} [opts]
   * @param {boolean} [opts.requireRevision] refuse a call that carries no revision (write routes)
   */
  async function mutate(expectedRevision, transform, opts = {}) {
    if (opts.requireRevision === true && typeof expectedRevision !== 'number') {
      throw new StoreError('缺少 expectedRevision:写请求必须携带当前版本号', 'revision-required', 400);
    }
    await ensureDir();
    const token = await acquireLock();
    try {
      // Corruption is decided per call from what is actually on disk. A process-lifetime flag
      // kept the store read-only even after a successful repair write.
      const { state, corrupt: wasCorrupt, reason } = await readState();
      if (state === null) {
        // Nothing readable anywhere. Refuse to write: starting from `fresh()` here would
        // erase whatever the user still has on disk (and in the quarantined copy).
        corrupt = true;
        throw new StoreError(
          `主题存储不可读,已拒绝写入以免覆盖数据${reason ? `(${reason})` : ''}`,
          'store-read-only',
          503,
        );
      }
      if (wasCorrupt) {
        corrupt = true;
        await quarantineCorruptFile();
      }
      for (const bucket of Object.values(state.workspaces)) ensureDefaultTopic(bucket);
      if (typeof expectedRevision === 'number' && expectedRevision !== state.revision) {
        throw Object.assign(new StoreError('主题数据已被其他会话修改,请刷新后重试', 'revision-conflict', 409), { currentRevision: state.revision });
      }
      const result = await transform(state);
      state.revision += 1;
      state.updatedAt = now();
      // A recovered write must not copy the broken primary over the good backup.
      await writeState(state, { skipBackup: wasCorrupt });
      // The document on disk is valid again, so the read-only mode ends here instead of
      // sticking until the host restarts.
      corrupt = false;
      return { revision: state.revision, result, warning: wasCorrupt ? reason : null };
    } finally {
      await releaseLock(token);
    }
  }

  /**
   * Client-facing write path: the revision is mandatory. A client that omits it would
   * otherwise make every write last-write-wins — exactly the multi-window case the
   * revision check exists for.
   */
  async function mutateWrite(expectedRevision, transform) {
    return mutate(expectedRevision, transform, { requireRevision: true });
  }

  async function createTopic(input) {
    const workspaceId = validateWorkspaceId(input?.workspaceId);
    const name = normalizeTopicName(input?.name);
    const sessionIds = input?.sessionIds ? validateSessionIds(input.sessionIds, { allowEmpty: true }) : [];
    return mutateWrite(input?.expectedRevision, (state) => {
      const bucket = bucketFor(state, workspaceId, true);
      if (bucket.topics.some((topic) => topic.name.toLowerCase() === name.toLowerCase())) {
        throw new StoreError(`该工作区已存在同名主题「${name}」`, 'topic-name-taken');
      }
      const topic = {
        id: nextTopicId(now),
        name,
        emoji: normalizeTopicEmoji(input?.emoji) ?? pickTopicEmoji(bucket.topics.map((entry) => entry.emoji)),
        order: bucket.topics.length,
        createdAt: now(),
      };
      bucket.topics.push(topic);
      let assigned = 0;
      for (const sessionId of sessionIds) {
        if (bucket.assignments[sessionId] !== topic.id) {
          bucket.assignments[sessionId] = topic.id;
          assigned += 1;
        }
      }
      return { topic, assigned };
    });
  }

  async function updateTopic(input) {
    const workspaceId = validateWorkspaceId(input?.workspaceId);
    const topicId = typeof input?.topicId === 'string' && input.topicId !== '' ? input.topicId : null;
    if (!topicId) throw new StoreError('缺少主题标识', 'bad-topic-id');
    const name = input?.name === undefined ? null : normalizeTopicName(input.name);
    const emoji = normalizeTopicEmoji(input?.emoji);
    if (name === null && emoji === null && input?.order === undefined) throw new StoreError('没有需要更新的内容', 'nothing-to-update');
    if (topicId === DEFAULT_TOPIC_ID) throw new StoreError('默认分组是系统分组,不能重命名', 'default-topic-protected', 400);
    return mutateWrite(input?.expectedRevision, (state) => {
      const bucket = bucketFor(state, workspaceId, false);
      const topic = requireTopic(bucket, topicId);
      if (name !== null && bucket.topics.some((other) => other.id !== topic.id && other.name.toLowerCase() === name.toLowerCase())) {
        throw new StoreError(`该工作区已存在同名主题「${name}」`, 'topic-name-taken');
      }
      if (name !== null) topic.name = name;
      if (emoji !== null) topic.emoji = emoji;
      if (Number.isFinite(input.order)) topic.order = input.order;
      bucket.topics.sort((left, right) => left.order - right.order);
      return { topic: { ...topic } };
    });
  }

  async function deleteTopic(input) {
    const workspaceId = validateWorkspaceId(input?.workspaceId);
    const topicId = typeof input?.topicId === 'string' && input.topicId !== '' ? input.topicId : null;
    if (!topicId) throw new StoreError('缺少主题标识', 'bad-topic-id');
    if (topicId === DEFAULT_TOPIC_ID) throw new StoreError('默认分组是系统分组,不能删除', 'default-topic-protected', 400);
    return mutateWrite(input?.expectedRevision, (state) => {
      const bucket = bucketFor(state, workspaceId, false);
      const topic = requireTopic(bucket, topicId);
      bucket.topics = bucket.topics.filter((entry) => entry.id !== topicId);
      let released = 0;
      for (const [sessionId, assigned] of Object.entries(bucket.assignments)) {
        if (assigned === topicId) {
          bucket.assignments[sessionId] = DEFAULT_TOPIC_ID;
          released += 1;
        }
      }
      bucket.topics.forEach((entry, index) => { entry.order = index; });
      return { deletedTopicId: topicId, deletedTopicName: topic.name, released };
    });
  }

  async function assign(input) {
    const workspaceId = validateWorkspaceId(input?.workspaceId);
    const sessionIds = validateSessionIds(input?.sessionIds);
    // `null` means "the default group": the reserved topic every workspace owns.
    const topicId = input?.topicId === null || input?.topicId === undefined || input?.topicId === '' ? DEFAULT_TOPIC_ID : String(input.topicId);
    return mutateWrite(input?.expectedRevision, (state) => {
      const bucket = bucketFor(state, workspaceId, true);
      requireTopic(bucket, topicId);
      let changed = 0;
      for (const sessionId of sessionIds) {
        const before = bucket.assignments[sessionId];
        if (before === topicId) continue;
        bucket.assignments[sessionId] = topicId;
        changed += 1;
      }
      return { topicId, changed, assignments: { ...bucket.assignments } };
    });
  }

  /** Drops assignments for sessions that no longer exist (after a permanent delete). */
  async function forgetSessions(sessionIds) {
    const ids = validateSessionIds(sessionIds, { allowEmpty: true });
    if (ids.length === 0) return { revision: null, removed: 0 };
    const idSet = new Set(ids);
    return mutate(null, (state) => {
      let removed = 0;
      for (const bucket of Object.values(state.workspaces)) {
        for (const sessionId of Object.keys(bucket.assignments)) {
          if (idSet.has(sessionId)) {
            delete bucket.assignments[sessionId];
            removed += 1;
          }
        }
      }
      return { removed };
    });
  }

  /**
   * Reorders the groups of a workspace to match `topicIds`. The reserved default group takes
   * part like any other — being first is only its initial position, not a rule.
   */
  async function reorderTopics(input) {
    const workspaceId = validateWorkspaceId(input?.workspaceId);
    const ids = Array.isArray(input?.topicIds) ? input.topicIds.map((entry) => String(entry)) : null;
    if (!ids) throw new StoreError('topicIds 必须是数组', 'bad-topic-ids');
    return mutateWrite(input?.expectedRevision, (state) => {
      const bucket = bucketFor(state, workspaceId, false);
      const listed = [];
      for (const id of ids) {
        const topic = topicById(bucket, id);
        if (!topic) throw new StoreError('主题不存在', 'topic-not-found', 404);
        listed.push(topic);
      }
      // Anything the caller did not list keeps its relative place behind the listed ones.
      const rest = bucket.topics
        .filter((topic) => !ids.includes(topic.id))
        .sort((left, right) => left.order - right.order);
      [...listed, ...rest].forEach((topic, index) => { topic.order = index; });
      bucket.topics.sort((left, right) => left.order - right.order);
      return { topics: bucket.topics.map((topic) => ({ ...topic })) };
    });
  }

  async function snapshot() {
    const read = await readState();
    // `null` means "a document exists but nothing readable could be recovered". Report it as
    // read-only with an empty view; the panel shows the warning banner and blocks writes.
    if (read.state === null) {
      corrupt = true;
      return {
        revision: 0,
        updatedAt: 0,
        workspaces: Object.create(null),
        readOnly: true,
        warning: read.reason ?? '主题存储不可读',
      };
    }
    const state = read.state;
    for (const bucket of Object.values(state.workspaces)) ensureDefaultTopic(bucket);
    const workspaces = Object.create(null);
    for (const [workspaceId, bucket] of Object.entries(state.workspaces)) {
      workspaces[workspaceId] = {
        topics: bucket.topics.map((topic) => ({ ...topic })),
        assignments: { ...bucket.assignments },
      };
    }
    return {
      revision: state.revision,
      updatedAt: state.updatedAt,
      workspaces,
      readOnly: Boolean(read.corrupt) || corrupt,
      warning: read.corrupt ? read.reason : null,
    };
  }

  return {
    dir,
    file,
    lockFile,
    bakFile,
    snapshot,
    mutate,
    createTopic,
    updateTopic,
    deleteTopic,
    reorderTopics,
    assign,
    forgetSessions,
    isCorrupt: () => corrupt,
  };
}
