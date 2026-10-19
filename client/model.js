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

export const SEARCH_RESULT_LIMIT = 100;
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

function makeRow(session, { current, archived, pinned, workspaceId, topicId, topicName, topicEmoji, statuses }) {
  const title = session?.blank ? t('session.blank') : session?.displayTitle || session?.title || session?.id || '';
  const status = readStatus(session, statuses);
  return {
    id: session.id,
    title: String(title),
    updatedAt: session.updatedAt ?? 0,
    running: status.running,
    completed: status.completed,
    pendingKind: status.pendingKind,
    status: status.pendingKind ? 'warning' : status.running ? 'ongoing' : status.completed ? 'done' : null,
    blank: Boolean(session.blank),
    isCurrent: session.id === current,
    archived: archived.has(session.id),
    pinned: pinned.has(session.id),
    workspaceId,
    workspaceTitle: null,
    topicId: topicId ?? null,
    topicName: topicName ?? null,
    topicEmoji: topicEmoji ?? null,
  };
}

/**
 * Workspace-level status is an overview, so it must not shrink when a topic filter or
 * search hides rows: derive it from every live member regardless of the display filters.
 */
function liveStatusRows(ids, { byId, archived, current, pinned, statuses, workspaceId }) {
  const rows = [];
  for (const id of ids) {
    const session = byId[id];
    if (!session) continue;
    if (session.origin === 'subagent') continue;
    if (session.blank && id !== current) continue;
    if (archived.has(id)) continue;
    rows.push(makeRow(session, { current, archived, pinned, statuses, workspaceId }));
  }
  return rows;
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
 * Manual drag order: the ids a drag produced lead in that order, anything the user never
 * touched keeps the host's order (sort is stable, so unlisted entries stay put).
 */
function orderBy(rows, manual, keyOf) {
  if (!Array.isArray(manual) || manual.length === 0) return rows;
  const pick = keyOf ?? ((entry) => entry.id);
  const rank = new Map();
  manual.forEach((id, index) => rank.set(id, index));
  return [...rows].sort((left, right) => (rank.get(pick(left)) ?? Number.MAX_SAFE_INTEGER) - (rank.get(pick(right)) ?? Number.MAX_SAFE_INTEGER));
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

export function buildTree({ items, list, statuses, archivedIds, pinnedIds, topicsOf, assignmentsOf, prefs, query }) {
  const workspaces = orderBy(normalizeWorkspaces(items), prefs?.workspaceOrder ?? [], (entry) => entry.workspaceId);
  const archived = toSet(archivedIds);
  const pinned = toSet(pinnedIds);
  // `pinnedSessionIds` is ordered most-recently-pinned first; that order is the tie-break
  // between pinned rows, exactly like the host's own `reconcileManualOrder`.
  const pinnedRank = new Map();
  [...pinned].forEach((id, index) => pinnedRank.set(id, index));
  const byId = list?.byId ?? {};
  const current = mainSessionId(list);
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
      .filter((session) => session && !seen.has(session.id) && session.cwd === workspace.path)
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
        workspaceId: workspace.workspaceId,
        topicId: topic?.id ?? DEFAULT_TOPIC_ID,
        topicName: topic ? topicLabel(topic) : null,
        topicEmoji: topic?.emoji ?? '',
      });
      row.workspaceTitle = workspace.title;
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
      sections.push({
        kind: 'topic',
        id: topic.id,
        name: topicLabel(topic),
        emoji: topic.emoji ?? '',
        system: topic.system === true,
        rows: topicRows,
        status: status.state,
        statusKind: status.kind,
        collapsed: collapsedTopics.has(`${workspace.workspaceId}:${topic.id}`),
        total: topicRows.length,
      });
    }
    if (archivedRows.length > 0) {
      sections.push({ kind: 'archived', id: '__archived__', name: null, emoji: '', rows: archivedRows, status: null, statusKind: null, collapsed: collapsedWorkspaces.has(`${workspace.workspaceId}:archived`), total: archivedRows.length });
    }

    const workspaceStatus = aggregateStatus(liveStatusRows(finalIds, {
      byId,
      archived,
      current,
      pinned,
      statuses,
      workspaceId: workspace.workspaceId,
    }));
    groups.push({
      workspaceId: workspace.workspaceId,
      title: workspace.title,
      path: workspace.path,
      sections,
      status: workspaceStatus.state,
      statusKind: workspaceStatus.kind,
      liveCount: live.length,
      archivedCount: archivedRows.length,
      topicCount: topics.length,
      collapsed: collapsedWorkspaces.has(workspace.workspaceId),
      isSelectedWorkspaceFilter: workspaceFilter === workspace.workspaceId,
    });
  }

  // The native browser trails a virtual 未分组 workspace for sessions no workspace
  // accounts for. It stays out of filters (those are workspace-scoped) and out of the
  // workspace order; it is only a home for rows that would otherwise disappear.
  if (!workspaceFilter && !topicFilter) {
    const accounted = new Set();
    for (const workspace of workspaces) for (const id of workspace.sessionIds ?? []) accounted.add(id);
    const workspacePaths = new Set(workspaces.map((workspace) => workspace.path).filter(Boolean));
    const strays = Object.values(byId)
      .filter((session) => session && !accounted.has(session.id) && !workspacePaths.has(session.cwd))
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
      const isArchived = archived.has(id);
      if (isArchived && !showArchived) continue;
      const row = makeRow(session, {
        current,
        archived,
        pinned,
        statuses,
        workspaceId: UNGROUPED_WORKSPACE_ID,
        topicId: DEFAULT_TOPIC_ID,
        topicName: defaultName,
        topicEmoji: '',
      });
      row.workspaceTitle = t('group.ungrouped');
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
      const live = rows.filter((row) => !row.archived);
      const archivedRows = rows.filter((row) => row.archived);
      const sections = [];
      if (live.length > 0) {
        const status = aggregateStatus(live);
        sections.push({
          kind: 'topic',
          id: DEFAULT_TOPIC_ID,
          name: defaultName,
          emoji: '',
          system: true,
          // 未分组 is a bucket, not a workspace that groups anything: its rows hang directly
          // off the workspace header instead of a "default group" row.
          bare: true,
          rows: live,
          status: status.state,
          statusKind: status.kind,
          collapsed: false,
          total: live.length,
        });
      }
      if (archivedRows.length > 0) {
        sections.push({
          kind: 'archived',
          id: '__archived__',
          name: null,
          emoji: '',
          rows: archivedRows,
          status: null,
          statusKind: null,
          collapsed: collapsedWorkspaces.has(`${UNGROUPED_WORKSPACE_ID}:archived`),
          total: archivedRows.length,
        });
      }
      const workspaceStatus = aggregateStatus(liveStatusRows(orderedStrays, {
        byId,
        archived,
        current,
        pinned,
        statuses,
        workspaceId: UNGROUPED_WORKSPACE_ID,
      }));
      groups.push({
        workspaceId: UNGROUPED_WORKSPACE_ID,
        title: t('group.ungrouped'),
        path: '',
        sections,
        status: workspaceStatus.state,
        statusKind: workspaceStatus.kind,
        liveCount: live.length,
        archivedCount: archivedRows.length,
        topicCount: 1,
        collapsed: collapsedWorkspaces.has(UNGROUPED_WORKSPACE_ID),
        isSelectedWorkspaceFilter: false,
        virtual: true,
      });
    }
  }

  if (search) {
    for (const group of groups) {
      for (const section of group.sections) section.collapsed = false;
      group.collapsed = false;
    }
  }

  // The tinted folder is the one the user is looking at: the explicit workspace filter when
  // one is set, otherwise the workspace that owns the session on screen (native behaviour).
  let currentWorkspaceId = null;
  if (current) {
    const owner = workspaces.find((workspace) => (workspace.sessionIds ?? []).includes(current));
    if (owner) currentWorkspaceId = owner.workspaceId;
    else if (byId[current]?.cwd) {
      const byPath = workspaces.find((workspace) => workspace.path && workspace.path === byId[current].cwd);
      if (byPath) currentWorkspaceId = byPath.workspaceId;
    }
  }
  const highlightedWorkspaceId = workspaceFilter ?? currentWorkspaceId;

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
 */
export function newestTopic(topics) {
  const list = topics ?? [];
  if (list.length === 0) return null;
  const stamped = list.filter((topic) => Number.isFinite(Number(topic?.createdAt)));
  if (stamped.length === 0) return list[list.length - 1];
  return stamped.reduce((best, topic) => (Number(topic.createdAt) >= Number(best.createdAt) ? topic : best), stamped[0]);
}
