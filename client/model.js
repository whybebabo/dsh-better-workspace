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

function makeRow(session, { current, archived, pinned, workspaceId, topicId, topicName, topicEmoji }) {
  const title = session?.blank ? t('session.blank') : session?.displayTitle || session?.title || session?.id || '';
  return {
    id: session.id,
    title: String(title),
    updatedAt: session.updatedAt ?? 0,
    running: Boolean(session.running),
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
 * @param {object} input
 * @param {Array} input.items - `useWorkspaces(s => s.items)`
 * @param {object} input.list - `useSessions(s => s)` snapshot
 * @param {Set|Array} input.archivedIds - registry-global archive set
 * @param {Set|Array} input.pinnedIds
 * @param {object} input.store - panel store (topics/assignments lookups)
 * @param {object} input.prefs - {workspaceFilter, topicFilter, showArchived, collapsedWorkspaces, collapsedTopics}
 * @param {string} input.query - local search text
 */
export function buildTree({ items, list, archivedIds, pinnedIds, topicsOf, assignmentsOf, prefs, query }) {
  const workspaces = normalizeWorkspaces(items);
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

  for (const workspace of scoped) {
    if (truncated) break;
    const topics = topicsOf(workspace.workspaceId) ?? [];
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

    const rows = [];
    for (const id of orderedIds) {
      const session = byId[id];
      const isArchived = archived.has(id);
      if (session?.origin === 'subagent') continue;
      if (session?.blank && id !== current) continue;
      if (isArchived && !showArchived) continue;
      if (!session) continue;
      const topicId = assignments[id] ?? null;
      const topic = topicId ? topicById.get(topicId) : null;
      // A topic filter means "only this folder" — archived rows stay only when they belong
      // to that topic, so the bucket never shows unrelated history.
      if (topicFilter && topic?.id !== topicFilter) continue;
      const row = makeRow(session, {
        current,
        archived,
        pinned,
        workspaceId: workspace.workspaceId,
        topicId: topic?.id ?? null,
        topicName: topic?.name ?? null,
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
    const unpinnedRank = Number.MAX_SAFE_INTEGER;
    const rankOf = (row) => (row.archived ? unpinnedRank : pinnedRank.get(row.id) ?? unpinnedRank);
    rows.sort((left, right) => {
      if (left.blank !== right.blank) return left.blank ? -1 : 1;
      return rankOf(left) - rankOf(right);
    });

    const live = rows.filter((row) => !row.archived);
    const archivedRows = rows.filter((row) => row.archived);

    const sections = [];
    for (const topic of topics) {
      const topicRows = live.filter((row) => row.topicId === topic.id);
      if (topicRows.length === 0 && search) continue;
      sections.push({
        kind: 'topic',
        id: topic.id,
        name: topic.name,
        emoji: topic.emoji ?? '',
        rows: topicRows,
        collapsed: collapsedTopics.has(`${workspace.workspaceId}:${topic.id}`),
        total: topicRows.length,
      });
    }
    const unfiled = live.filter((row) => row.topicId === null);
    if (unfiled.length > 0) {
      sections.push({
        kind: 'ungrouped',
        id: null,
        name: null,
        emoji: '',
        rows: unfiled,
        collapsed: collapsedWorkspaces.has(`${workspace.workspaceId}:ungrouped`),
        total: unfiled.length,
      });
    }
    if (archivedRows.length > 0) {
      sections.push({ kind: 'archived', id: '__archived__', name: null, emoji: '', rows: archivedRows, collapsed: collapsedWorkspaces.has(`${workspace.workspaceId}:archived`), total: archivedRows.length });
    }

    groups.push({
      workspaceId: workspace.workspaceId,
      title: workspace.title,
      path: workspace.path,
      sections,
      liveCount: live.length,
      archivedCount: archivedRows.length,
      topicCount: topics.length,
      collapsed: collapsedWorkspaces.has(workspace.workspaceId),
      isSelectedWorkspaceFilter: workspaceFilter === workspace.workspaceId,
    });
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
