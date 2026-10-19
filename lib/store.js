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

  let corrupt = false;

  async function ensureDir() {
    await mkdir(dir, { recursive: true });
  }

  async function acquireLock() {
    await ensureDir();
    const token = `${process.pid}-${randomBytes(4).toString('hex')}`;
    const started = Date.now();
    for (;;) {
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
        if (info && Date.now() - info.mtimeMs > (options.staleLockMs ?? 10_000)) {
          await rm(lockFile, { force: true }).catch(() => {});
          continue;
        }
        if (Date.now() - started > (options.lockWaitMs ?? 3_000)) {
          throw new StoreError('主题存储正被其他进程占用,请稍后重试', 'store-locked', 409);
        }
        await sleep(25 + Math.floor(Math.random() * 35));
      }
    }
  }

  async function releaseLock() {
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

  async function readState() {
    let text;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return { state: fresh(), corrupt: false };
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
        return { state: fresh(), corrupt: true, reason: `主题存储文件无法解析(${error?.message || error}),已切换为只读` };
      }
    }
  }

  async function writeState(state) {
    const tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
    const payload = `${JSON.stringify(state, null, 2)}\n`;
    const handle = await open(tmp, 'w', 0o600);
    try {
      await handle.writeFile(payload, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (await stat(file).then(() => true, () => false)) {
      await copyFile(file, bakFile).catch(() => {});
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
   */
  async function mutate(expectedRevision, transform) {
    if (corrupt && options.allowWritesWhenCorrupt !== true) {
      throw new StoreError('主题存储处于只读模式(文件损坏),请修复或替换文件', 'store-read-only', 503);
    }
    await ensureDir();
    const token = await acquireLock();
    try {
      const { state, corrupt: wasCorrupt, reason } = await readState();
      if (wasCorrupt) corrupt = true;
      for (const bucket of Object.values(state.workspaces)) ensureDefaultTopic(bucket);
      if (typeof expectedRevision === 'number' && expectedRevision !== state.revision) {
        throw Object.assign(new StoreError('主题数据已被其他会话修改,请刷新后重试', 'revision-conflict', 409), { currentRevision: state.revision });
      }
      const result = await transform(state);
      state.revision += 1;
      state.updatedAt = now();
      await writeState(state);
      return { revision: state.revision, result, warning: wasCorrupt ? reason : null };
    } finally {
      await releaseLock(token);
    }
  }

  async function createTopic(input) {
    const workspaceId = validateWorkspaceId(input?.workspaceId);
    const name = normalizeTopicName(input?.name);
    const sessionIds = input?.sessionIds ? validateSessionIds(input.sessionIds, { allowEmpty: true }) : [];
    return mutate(input?.expectedRevision, (state) => {
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
    return mutate(input?.expectedRevision, (state) => {
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
    return mutate(input?.expectedRevision, (state) => {
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
    return mutate(input?.expectedRevision, (state) => {
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
    return mutate(input?.expectedRevision, (state) => {
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
    const { state, corrupt: isCorrupt, reason } = await readState();
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
      readOnly: isCorrupt || corrupt,
      warning: isCorrupt ? reason : null,
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
