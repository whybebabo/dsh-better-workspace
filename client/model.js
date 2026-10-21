/**
 * Tree derivation.
 *
 * Pure function over the host snapshots so it can be unit-tested without React: it mirrors
 * the native list's visibility rules (subagents hidden, only the current blank kept) and
 * then splits each workspace's members into topic folders, the unfiled tail, and — when
 * asked — the archived bucket.
 *
 * Pinning is a host-global set, and the native list floats pinned rows above the rest of
 * their group (the provisional New Session stays first). The same projection is applied to
 * every bucket here so clicking 置顶 actually moves the row, instead of only drawing a marker
 * the hover strip immediately covers.
 */
import { t } from './i18n.js';
import { formatRelative } from './time.js';

export const SEARCH_RESULT_LIMIT = 100;
/**
 * How many rows a long bucket mounts before the user asks for the rest. Lives here (not in the
 * component) because selection must agree with rendering: every "select all" entry point has to
 * compute the same id set the tree actually put on screen.
 */
export const REVEAL_LIMIT = 60;
/**
 * The session ids a section is allowed to put into a batch selection, and the ids it is
 * holding back.
 *
 * There is exactly one definition of "selectable" in the panel: rows that were mounted.
 * A header checkbox, the topic menu and the workspace menu each derived their own set, so a
 * bucket over `REVEAL_LIMIT` gave 60 / 69 / 70 for the same group and a batch permanent delete
 * could target rows the user had never seen. Collapsing is different from truncation: it is a
 * deliberate act with the count still on the header, so a collapsed bucket stays selectable
 * whole; truncation is a rendering limit the user did not ask for and is reported as hidden.
 *
 * @param {object} section - a built section (`rows`, `collapsed`)
 * @param {{revealed?: boolean}} [options] - whether the user expanded the bucket
 * @returns {{visible: string[], hidden: string[]}}
 */
export function selectableIds(section, { revealed = false } = {}) {
  // The provisional New Session is a placeholder with no record behind it: never selectable.
  const rows = (section?.rows ?? []).filter((row) => !row.blank);
  const all = rows.map((row) => row.id);
  if (section?.collapsed) return { visible: all, hidden: [] };
  const limit = revealed ? all.length : Math.min(all.length, REVEAL_LIMIT);
  return { visible: all.slice(0, limit), hidden: all.slice(limit) };
}
/** Reserved id of the per-workspace system group; mirrors `lib/store.js`. */
export const DEFAULT_TOPIC_ID = 'tp_default';
/**
 * Reserved id of the trailing virtual workspace. Mirroring the native list, sessions that
 * no workspace accounts for collect here instead of disappearing from the panel. The value
 * cannot collide with a workspace UUID and is never sent to the topic sidecar.
 */
export const UNGROUPED_WORKSPACE_ID = '__ungrouped__';

/** System groups render their localized label instead of the stored name. */
export function topicLabel(topic) {
  return topic?.system ? t('topic.default') : String(topic?.name ?? '');
}

/**
 * Every workspace owns the reserved default group, but the sidecar only materializes it on
 * the first write. The UI injects the virtual copy so a freshly added workspace still shows
 * (and accepts drops into) its default group everywhere, not just in the tree.
 */
export function withDefaultTopic(topics) {
  const list = Array.isArray(topics) ? topics : [];
  if (list.some((topic) => topic.id === DEFAULT_TOPIC_ID)) return list;
  return [{ id: DEFAULT_TOPIC_ID, name: '', emoji: '', order: -1, createdAt: 0, system: true }, ...list];
}

function toSet(value) {
  if (value instanceof Set) return value;
  return new Set(Array.isArray(value) ? value : []);
}

function normalizeWorkspaces(items) {
  return (items ?? []).map((item) => ({
    workspaceId: item.workspaceId,
    path: item.path ?? '',
    title: item.title || basename(item.path || '') || item.workspaceId,
    sessionIds: item.sessionIds ?? [],
    updatedAt: item.updatedAt ?? 0,
    createdAt: item.createdAt ?? 0,
  }));
}

export function basename(path) {
  const parts = String(path).replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || String(path);
}

/**
 * Whether two paths name the same directory.
 *
 * The workspace record carries the canonical path the host registered (`realpath`, a different
 * spelling than a session header written earlier), while the session header carries whatever
 * `cwd` the session was created with. On Windows they differ in casing and separators for the
 * same directory, and a session whose header does not string-equal its workspace path used to
 * fall out of that workspace's membership and land in 未分组.
 *
 * Case folding is therefore **Windows-only**. The browser cannot ask for the platform, so the
 * spelling decides: a drive-letter root (`C:\`, `c:/`) is a Windows path, where `D:\Work` and
 * `d:/work` really are one directory; anything else is treated as case-sensitive, because on
 * POSIX `/tmp/Alpha` and `/tmp/alpha` are two different workspaces and folding them would render
 * one session under both.
 */
function isWindowsPath(value) {
  return /^[A-Za-z]:[\\/]/.test(value) || String(value ?? '').includes('\\');
}

export function samePath(left, right) {
  const normalize = (value) => {
    const text = String(value ?? '');
    const unified = isWindowsPath(text) ? text.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase() : text.replace(/\/+$/, '');
    return unified;
  };
  const a = normalize(left);
  return a !== '' && a === normalize(right);
}

/** The session the main conversation view is showing, mirroring the native `mainSessionId`. */
export function mainSessionId(list) {
  const byId = list?.byId ?? {};
  for (const session of Object.values(byId)) {
    if ((session?.retainedBy?.mainView ?? 0) > 0) return session.id;
  }
  return list?.current;
}

export function isVisibleSession(session, current, archived) {
  if (!session) return false;
  if (session.origin === 'subagent') return false;
  if (session.blank && session.id !== current) return false;
  if (archived.has(session.id)) return false;
  return true;
}

function relativeKey(updatedAt) {
  return Number.isFinite(updatedAt) ? -updatedAt : 0;
}

const PENDING_KINDS = new Set(['approval', 'plan-review', 'question']);
const PENDING_LABEL_KEYS = {
  approval: ['session.state.waitingApproval', 'session.state.compactApproval'],
  'plan-review': ['session.state.planReview', 'session.state.compactPlanReview'],
  question: ['session.state.waitingAnswer', 'session.state.compactAnswer'],
};

/** The full label for a pending interaction, or the compact trailing label used on the row. */
export function pendingStatusLabel(kind, compact = false) {
  const keys = PENDING_LABEL_KEYS[kind];
  return keys ? t(keys[compact ? 1 : 0]) : '';
}

/** Statuses arrive as a Map from `uiSession.sessionStatus`; tests may pass a plain object. */
function statusEntry(statuses, id) {
  if (!statuses) return undefined;
  return typeof statuses.get === 'function' ? statuses.get(id) : statuses[id];
}

/**
 * The session's own primary status follows the native precedence: a pending interaction
 * outranks live work, which outranks the unread-completion reminder.
 */
function readStatus(session, statuses) {
  const status = statusEntry(statuses, session?.id);
  const kind = status?.pendingInteraction?.kind;
  return {
    pendingKind: PENDING_KINDS.has(kind) ? kind : null,
    running: status?.running ?? Boolean(session?.running),
    completed: status?.completionUnread === true,
  };
}

/** Group and workspace rows use the precedence: pending > completed > running. */
function aggregateStatus(rows) {
  let done = false;
  let ongoing = false;
  for (const row of rows) {
    if (row.blank) continue;
    if (row.status === 'warning') return { state: 'warning', kind: row.pendingKind };
    if (row.completed) done = true;
    if (row.running) ongoing = true;
  }
  return { state: done ? 'done' : ongoing ? 'ongoing' : null, kind: null };
}

/**
 * Reference-stable row objects.
 *
 * `SessionRow` is `React.memo`, but a fresh object per build defeated it: every list
 * publish, status flip and 30s tick produced new `row` props and re-rendered every mounted
 * row (measured: 1500 rows ≈ 55–63 ms per trigger, DOM unchanged afterwards). The host's own
 * session list solves this the same way — `SessionManager.entryCache` reuses the previous
 * entry when every compared field matches, with the comment "or every SessionListItem memo
 * misses on every refresh".
 *
 * Reuse is only sound when *every* field the row exposes is unchanged, so the fingerprint
 * carries all of them plus the localized strings (a language switch must produce new rows).
 * The cache is per-module and pruned to the ids seen by the last build, so a long-lived
 * panel cannot accumulate rows for sessions the host dropped.
 */
const rowCache = new Map();
const rowFields = (row) => [
  row.id,
  row.title,
  row.updatedAt,
  row.timeLabel,
  row.running,
  row.completed,
  row.pendingKind,
  row.status,
  row.blank,
  row.isCurrent,
  row.archived,
  row.pinned,
  row.workspaceId,
  row.workspaceTitle,
  row.topicId,
  row.topicName,
  row.topicEmoji,
].join('\u0000');

function makeRow(session, { current, archived, pinned, workspaceId, workspaceTitle, topicId, topicName, topicEmoji, statuses, now }) {
  const title = session?.blank ? t('session.blank') : session?.displayTitle || session?.title || session?.id || '';
  const status = readStatus(session, statuses);
  const updatedAt = session.updatedAt ?? 0;
  const row = {
    id: session.id,
    title: String(title),
    updatedAt,
    // The relative label is rendered per row on every tick today, which forces the whole
    // tree through React for a string that only changes once a minute. It is computed here
    // from a minute-quantized `now`, so the row cache can skip a tick that changes nothing.
    timeLabel: formatRelative(updatedAt, now),
    running: status.running,
    completed: status.completed,
    pendingKind: status.pendingKind,
    status: status.pendingKind ? 'warning' : status.running ? 'ongoing' : status.completed ? 'done' : null,
    blank: Boolean(session.blank),
    isCurrent: session.id === current,
    archived: archived.has(session.id),
    pinned: pinned.has(session.id),
    workspaceId,
    workspaceTitle: workspaceTitle ?? null,
    topicId: topicId ?? null,
    topicName: topicName ?? null,
    topicEmoji: topicEmoji ?? null,
  };
  // Blanks are provisional rows whose content changes as the host fills them in; caching them
  // would only ever be a hit for a row the user cannot act on, so keep that path allocation-only.
  if (row.blank) return row;
  const key = rowFields(row);
  const cached = rowCache.get(row.id);
  if (cached !== undefined && cached.key === key) return cached.row;
  const entry = { key, row };
  rowCache.set(row.id, entry);
  return row;
}

/**
 * Workspace-level status is an overview, so it must not shrink when a topic filter or
 * search hides rows: derive it from every live member regardless of the display filters.
 *
 * This used to build throwaway row objects just to aggregate three booleans. That both
 * allocated O(n) garbage per build and fought the row cache (a scratch row and a display row
 * for the same session carry different fields, so the cache would thrash on every flush).
 */
function aggregateMembers(ids, { byId, archived, current, statuses }) {
  let done = false;
  let ongoing = false;
  for (const id of ids) {
    const session = byId[id];
    if (!session) continue;
    if (session.origin === 'subagent') continue;
    if (session.blank && id !== current) continue;
    if (archived.has(id)) continue;
    const status = readStatus(session, statuses);
    // Same precedence as `aggregateStatus`: a pending interaction outranks everything.
    if (status.pendingKind) return { state: 'warning', kind: status.pendingKind };
    if (status.completed) done = true;
    if (status.running) ongoing = true;
  }
  return { state: done ? 'done' : ongoing ? 'ongoing' : null, kind: null };
}

/**
 * @param {object} input
 * @param {Array} input.items - `useWorkspaces(s => s.items)`
 * @param {object} input.list - `useSessions(s => s)` snapshot
 * @param {Set|Array} input.archivedIds - registry-global archive set
 * @param {Set|Array} input.pinnedIds
 * @param {object} input.store - panel store (topics/assignments lookups)
 * @param {object} input.prefs - {workspaceFilter, topicFilter, showArchived, collapsedWorkspaces, collapsedTopics}
 * @param {string} input.query - local search text
 */
/**
 * Manual drag order, as a permutation of the ids it names — never as an absolute order.
 *
 * The stored list is a snapshot of the ids that existed when the user last dragged, so it can
 * only speak for those. Sorting the whole list by "rank, unknown last" (the old behaviour)
 * demoted everything the snapshot did not mention: a session created afterwards landed at the
 * bottom of its bucket instead of the top, which is the opposite of the host — `attachSession`
 * prepends, so a new session leads its workspace. Here the named ids keep their own slots and
 * only permute among them; rows the snapshot never met keep the host's position untouched.
 */
function orderBy(rows, manual, keyOf) {
  if (!Array.isArray(manual) || manual.length === 0) return rows;
  const pick = keyOf ?? ((entry) => entry.id);
  const order = new Map();
  for (const id of manual) if (!order.has(id)) order.set(id, order.size);
  const slots = [];
  for (let index = 0; index < rows.length; index += 1) if (order.has(pick(rows[index]))) slots.push(index);
  if (slots.length === 0) return rows;
  const named = rows.filter((row) => order.has(pick(row)));
  named.sort((left, right) => order.get(pick(left)) - order.get(pick(right)));
  const next = [...rows];
  slots.forEach((slot, index) => { next[slot] = named[index]; });
  return next;
}

/**
 * Moves `dragId` next to `targetId` inside `ids`, which is the order the drag operates on.
 * Returns the input unchanged when the target is missing (nothing to anchor the move to).
 */
export function moveWithin(ids, dragId, targetId, position) {
  const next = ids.filter((id) => id !== dragId);
  const at = next.indexOf(targetId);
  if (at < 0) return ids;
  next.splice(position === 'after' ? at + 1 : at, 0, dragId);
  return next;
}

/**
 * Section/group reference reuse.
 *
 * `Section` is memoized on its `section` and `group` props, so a fresh object per build made
 * the memo decorative even after the rows themselves became stable. A candidate is compared
 * against the cached one by a scalar fingerprint plus element-wise identity of its child
 * array: rows/sections are themselves reused, so "same elements in the same order" really
 * does mean "nothing the component reads has changed".
 */
const SECTION_SCALARS = ['kind', 'id', 'name', 'emoji', 'system', 'bare', 'status', 'statusKind', 'collapsed', 'total'];
const GROUP_SCALARS = ['workspaceId', 'title', 'path', 'status', 'statusKind', 'liveCount', 'archivedCount', 'topicCount', 'collapsed', 'isSelectedWorkspaceFilter', 'virtual'];

function fingerprintOf(value, keys) {
  let out = '';
  for (const key of keys) out += `${value[key] ?? ''}\u0000`;
  return out;
}

function sameElements(left, right) {
  if (left === right) return true;
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return false;
  return true;
}

/** Returns the cached object when nothing visible changed, otherwise stores and returns the new one. */
function stabilize(cache, key, value, scalars, childKey) {
  const fingerprint = fingerprintOf(value, scalars);
  const cached = cache.get(key);
  if (cached !== undefined && cached.fingerprint === fingerprint && sameElements(cached.children, value[childKey])) {
    return cached.value;
  }
  cache.set(key, { fingerprint, children: value[childKey], value });
  return value;
}

/** Drops cache entries the current build did not touch (closed workspaces, deleted topics). */
function pruneCache(cache, liveKeys) {
  if (cache.size <= liveKeys.size) return;
  for (const key of cache.keys()) if (!liveKeys.has(key)) cache.delete(key);
}

const sectionCache = new Map();
const groupCache = new Map();

/**
 * True when a session's own `cwd` resolves to any registered workspace path. Such a session is
 * not a stray even if the host has not accounted it yet: it belongs to a workspace, and the
 * panel shows it under that workspace's header via the straggler rule above.
 */
function ungroupedBucketMatches(session, workspacePaths) {
  for (const path of workspacePaths) if (samePath(session.cwd, path)) return true;
  return false;
}

export function buildTree({ items, list, statuses, archivedIds, pinnedIds, topicsOf, assignmentsOf, prefs, query, now }) {
  const workspaces = orderBy(normalizeWorkspaces(items), prefs?.workspaceOrder ?? [], (entry) => entry.workspaceId);
  const archived = toSet(archivedIds);
  const pinned = toSet(pinnedIds);
  // `pinnedSessionIds` is ordered most-recently-pinned first; that order is the tie-break
  // between pinned rows, exactly like the host's own `reconcileManualOrder`.
  const pinnedRank = new Map();
  [...pinned].forEach((id, index) => pinnedRank.set(id, index));
  const byId = list?.byId ?? {};
  const current = mainSessionId(list);
  // Minute-quantized: the label's own precision is minutes, so a tick inside the same minute
  // must produce identical row fingerprints (and therefore zero re-renders).
  const minuteNow = Number.isFinite(now) ? Math.floor(now / 60_000) * 60_000 : Date.now();
  const search = String(query ?? '').trim().toLowerCase();
  const workspaceFilter = prefs?.workspaceFilter ?? null;
  const topicFilter = prefs?.topicFilter ?? null;
  const showArchived = Boolean(prefs?.showArchived);
  const collapsedWorkspaces = toSet(prefs?.collapsedWorkspaces);
  const collapsedTopics = toSet(prefs?.collapsedTopics);

  // A topic lives in exactly one workspace, so "only this topic" implies its workspace —
  // otherwise the other workspaces would still render as empty (or, with a clashing title,
  // look like they matched too).
  const topicOwner = topicFilter
    ? workspaces.find((workspace) => (topicsOf(workspace.workspaceId) ?? []).some((topic) => topic.id === topicFilter))?.workspaceId ?? null
    : null;
  const scopeId = workspaceFilter ?? topicOwner;
  const scoped = scopeId ? workspaces.filter((workspace) => workspace.workspaceId === scopeId) : workspaces;
  const groups = [];
  let matched = 0;
  let truncated = false;
  // Native order: the provisional New Session leads, then pinned rows in host pin order,
  // then everything else in its existing (manual or recency) order.
  const unpinnedRank = Number.MAX_SAFE_INTEGER;
  const sortRows = (rows) => {
    const rankOf = (row) => (row.archived ? unpinnedRank : pinnedRank.get(row.id) ?? unpinnedRank);
    rows.sort((left, right) => {
      if (left.blank !== right.blank) return left.blank ? -1 : 1;
      return rankOf(left) - rankOf(right);
    });
    return rows;
  };

  for (const workspace of scoped) {
    if (truncated) break;
    // The default group is a reserved, server-managed topic; a snapshot that predates it is
    // patched here so every workspace always renders (and accepts drops into) one.
    let topics = withDefaultTopic(topicsOf(workspace.workspaceId));
    topics = [...topics].sort((left, right) => (left.order ?? 0) - (right.order ?? 0));
    const assignments = assignmentsOf(workspace.workspaceId) ?? {};
    const topicById = new Map(topics.map((topic) => [topic.id, topic]));

    const orderedIds = [];
    const seen = new Set();
    for (const id of workspace.sessionIds) {
      if (seen.has(id) || !byId[id]) continue;
      seen.add(id);
      orderedIds.push(id);
    }
    // Workspace records can lag the session list; anything known but unaccounted for is
    // appended by recency so the panel never hides a session the native list shows.
    const stragglers = Object.values(byId)
      .filter((session) => session && !seen.has(session.id) && samePath(session.cwd, workspace.path))
      .sort((left, right) => relativeKey(left.updatedAt) - relativeKey(right.updatedAt));
    for (const session of stragglers) orderedIds.push(session.id);
    // A drag inside a workspace reorders its sessions; the manual list is a stable overlay
    // on the host's order, so sessions created later simply fall in at the end.
    const manualSessions = prefs?.sessionOrder?.[workspace.workspaceId];
    const finalIds = orderBy(orderedIds, manualSessions, (id) => id);

    const rows = [];
    for (const id of finalIds) {
      const session = byId[id];
      const isArchived = archived.has(id);
      if (session?.origin === 'subagent') continue;
      if (session?.blank && id !== current) continue;
      if (isArchived && !showArchived) continue;
      if (!session) continue;
      const topicId = assignments[id] ?? DEFAULT_TOPIC_ID;
      const topic = topicById.get(topicId) ?? topicById.get(DEFAULT_TOPIC_ID) ?? null;
      // A topic filter means "only this folder" — archived rows stay only when they belong
      // to that topic, so the bucket never shows unrelated history.
      if (topicFilter && topic?.id !== topicFilter) continue;
      const row = makeRow(session, {
        current,
        archived,
        pinned,
        statuses,
        now: minuteNow,
        workspaceId: workspace.workspaceId,
        workspaceTitle: workspace.title,
        topicId: topic?.id ?? DEFAULT_TOPIC_ID,
        topicName: topic ? topicLabel(topic) : null,
        topicEmoji: topic?.emoji ?? '',
      });
      if (search) {
        const haystack = `${row.title} ${workspace.title} ${workspace.path} ${topic?.name ?? ''}`.toLowerCase();
        if (!haystack.includes(search)) continue;
        if (matched >= SEARCH_RESULT_LIMIT) {
          truncated = true;
          break;
        }
        matched += 1;
      }
      rows.push(row);
    }

    // Native order: the provisional New Session leads, then pinned rows in host pin order,
    // then everything else in its existing (manual or recency) order. Sections filter this
    // list, so each bucket gets the same treatment without pinned rows leaving their topic.
    sortRows(rows);

    const live = rows.filter((row) => !row.archived);
    const archivedRows = rows.filter((row) => row.archived);

    const sections = [];
    for (const topic of topics) {
      const topicRows = live.filter((row) => row.topicId === topic.id);
      if (topicRows.length === 0 && search) continue;
      const status = aggregateStatus(topicRows);
      const key = `${workspace.workspaceId}:${topic.id}`;
      sections.push(stabilize(sectionCache, key, {
        kind: 'topic',
        id: topic.id,
        name: topicLabel(topic),
        emoji: topic.emoji ?? '',
        system: topic.system === true,
        rows: topicRows,
        status: status.state,
        statusKind: status.kind,
        collapsed: search ? false : collapsedTopics.has(key),
        total: topicRows.length,
      }, SECTION_SCALARS, 'rows'));
    }
    if (archivedRows.length > 0) {
      const key = `${workspace.workspaceId}:archived`;
      sections.push(stabilize(sectionCache, key, { kind: 'archived', id: '__archived__', name: null, emoji: '', rows: archivedRows, status: null, statusKind: null, collapsed: search ? false : collapsedWorkspaces.has(key), total: archivedRows.length }, SECTION_SCALARS, 'rows'));
    }

    const workspaceStatus = aggregateMembers(finalIds, {
      byId,
      archived,
      current,
      statuses,
    });
    groups.push(stabilize(groupCache, workspace.workspaceId, {
      workspaceId: workspace.workspaceId,
      title: workspace.title,
      path: workspace.path,
      sections,
      status: workspaceStatus.state,
      statusKind: workspaceStatus.kind,
      liveCount: live.length,
      archivedCount: archivedRows.length,
      topicCount: topics.length,
      collapsed: search ? false : collapsedWorkspaces.has(workspace.workspaceId),
      isSelectedWorkspaceFilter: workspaceFilter === workspace.workspaceId,
    }, GROUP_SCALARS, 'sections'));
  }

  // The native browser trails a virtual 未分组 workspace for sessions no workspace
  // accounts for. It stays out of filters (those are workspace-scoped) and out of the
  // workspace order; it is only a home for live rows that would otherwise disappear.
  // Archived sessions always belong to their workspace's archived bucket: sessions with no
  // workspace at all stay out instead of surfacing under 未分组.
  if (!workspaceFilter && !topicFilter) {
    const accounted = new Set();
    for (const workspace of workspaces) for (const id of workspace.sessionIds ?? []) accounted.add(id);
    const workspacePaths = workspaces.map((workspace) => workspace.path).filter(Boolean);
    const strays = Object.values(byId)
      .filter((session) => session && !accounted.has(session.id) && !ungroupedBucketMatches(session, workspacePaths) && !archived.has(session.id))
      .sort((left, right) => relativeKey(left.updatedAt) - relativeKey(right.updatedAt));
    const orderedStrays = orderBy(strays.map((session) => session.id), prefs?.sessionOrder?.[UNGROUPED_WORKSPACE_ID], (id) => id);
    const defaultName = t('topic.default');
    const rows = [];
    for (const id of orderedStrays) {
      if (truncated) break;
      const session = byId[id];
      if (!session) continue;
      if (session.origin === 'subagent') continue;
      if (session.blank && id !== current) continue;
      const row = makeRow(session, {
        current,
        archived,
        pinned,
        statuses,
        now: minuteNow,
        workspaceId: UNGROUPED_WORKSPACE_ID,
        workspaceTitle: t('group.ungrouped'),
        topicId: DEFAULT_TOPIC_ID,
        topicName: defaultName,
        topicEmoji: '',
      });
      if (search) {
        const haystack = `${row.title} ${row.workspaceTitle} ${defaultName}`.toLowerCase();
        if (!haystack.includes(search)) continue;
        if (matched >= SEARCH_RESULT_LIMIT) {
          truncated = true;
          break;
        }
        matched += 1;
      }
      rows.push(row);
    }
    if (rows.length > 0) {
      sortRows(rows);
      const status = aggregateStatus(rows);
      const sections = [stabilize(sectionCache, `${UNGROUPED_WORKSPACE_ID}:${DEFAULT_TOPIC_ID}`, {
        kind: 'topic',
        id: DEFAULT_TOPIC_ID,
        name: defaultName,
        emoji: '',
        system: true,
        // 未分组 is a bucket, not a workspace that groups anything: its rows hang directly
        // off the workspace header instead of a "default group" row.
        bare: true,
        rows,
        status: status.state,
        statusKind: status.kind,
        collapsed: false,
        total: rows.length,
      }, SECTION_SCALARS, 'rows')];
      const workspaceStatus = aggregateMembers(orderedStrays, {
        byId,
        archived,
        current,
        statuses,
      });
      groups.push(stabilize(groupCache, UNGROUPED_WORKSPACE_ID, {
        workspaceId: UNGROUPED_WORKSPACE_ID,
        title: t('group.ungrouped'),
        path: '',
        sections,
        status: workspaceStatus.state,
        statusKind: workspaceStatus.kind,
        liveCount: rows.length,
        archivedCount: 0,
        topicCount: 1,
        collapsed: search ? false : collapsedWorkspaces.has(UNGROUPED_WORKSPACE_ID),
        isSelectedWorkspaceFilter: false,
        virtual: true,
      }, GROUP_SCALARS, 'sections'));
    }
  }

  if (search) {
    // Search opens every bucket, so the *effective* collapsed flag is false for the whole
    // build. It is folded into the objects below (and therefore their fingerprints) instead
    // of being patched afterwards: these objects are cached and shared with the previous
    // build, so mutating one in place would poison the cache for the next tick.
  }

  // The tinted folder is the one the user is looking at: the explicit workspace filter when
  // one is set, otherwise the workspace that owns the session on screen (native behaviour).
  let currentWorkspaceId = null;
  if (current) {
    const owner = workspaces.find((workspace) => (workspace.sessionIds ?? []).includes(current));
    if (owner) currentWorkspaceId = owner.workspaceId;
    else if (byId[current]?.cwd) {
      const byPath = workspaces.find((workspace) => samePath(workspace.path, byId[current].cwd));
      if (byPath) currentWorkspaceId = byPath.workspaceId;
    }
  }
  const highlightedWorkspaceId = workspaceFilter ?? currentWorkspaceId;

  // A closed workspace or a deleted topic must not leave a cached row/section/group behind:
  // the module lives as long as the page, so anything unmatched here would never be freed.
  const liveGroupKeys = new Set(groups.map((group) => group.workspaceId));
  pruneCache(groupCache, liveGroupKeys);
  const liveSectionKeys = new Set();
  const liveRowIds = new Set();
  for (const group of groups) {
    for (const section of group.sections) {
      liveSectionKeys.add(section.kind === 'archived' ? `${group.workspaceId}:archived` : `${group.workspaceId}:${section.id}`);
      for (const row of section.rows) liveRowIds.add(row.id);
    }
  }
  pruneCache(sectionCache, liveSectionKeys);
  pruneCache(rowCache, liveRowIds);

  return { groups, search, truncated, matched, currentSessionId: current, currentWorkspaceId: highlightedWorkspaceId };
}

/** Workspace option list for the header dropdown, with per-workspace session counts. */
export function buildWorkspaceOptions({ items, list, archivedIds }) {
  const archived = toSet(archivedIds);
  const byId = list?.byId ?? {};
  const current = mainSessionId(list);
  return normalizeWorkspaces(items).map((workspace) => {
    const known = workspace.sessionIds.filter((id) => byId[id] && byId[id].origin !== 'subagent' && !(byId[id].blank && id !== current) && !archived.has(id));
    return { ...workspace, visibleCount: known.length, archivedCount: workspace.sessionIds.filter((id) => archived.has(id)).length };
  });
}

/**
 * The topic a freshly started session belongs to: the workspace's most recently created
 * group. `createdAt` is authoritative when the document carries it; the server appends new
 * topics, so array position is the fallback for older documents.
 *
 * Kept exported because it is the honest answer to "which group is newest", but no longer used
 * by the new-session watcher: topics render oldest-first, so the newest group is usually the
 * *last* one, and filing a fresh session there put it at the bottom of the workspace.
 */
export function newestTopic(topics) {
  const list = topics ?? [];
  if (list.length === 0) return null;
  const stamped = list.filter((topic) => Number.isFinite(Number(topic?.createdAt)));
  if (stamped.length === 0) return list[list.length - 1];
  return stamped.reduce((best, topic) => (Number(topic.createdAt) >= Number(best.createdAt) ? topic : best), stamped[0]);
}
