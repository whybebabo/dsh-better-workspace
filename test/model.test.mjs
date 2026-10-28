import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTree, buildWorkspaceOptions, mainSessionId, basename, samePath, moveWithin, orderByManual, ungroupedSessionIds, workspaceSessionIds, DEFAULT_TOPIC_ID, UNGROUPED_WORKSPACE_ID } from '../client/model.js';

const WS_A = 'ws_a';
const WS_B = 'ws_b';

function fixture({ topics = {}, assignments = {} } = {}) {
  const items = [
    { workspaceId: WS_A, path: 'D:/work/alpha', title: 'Alpha', sessionIds: ['ses_1', 'ses_2', 'ses_3', 'ses_arch', 'ses_sub', 'ses_blank'], createdAt: 1, updatedAt: 10 },
    { workspaceId: WS_B, path: 'D:/work/beta', title: 'Beta', sessionIds: ['ses_9'], createdAt: 2, updatedAt: 20 },
  ];
  const byId = {
    ses_1: { id: 'ses_1', displayTitle: '设计讨论', cwd: 'D:/work/alpha', updatedAt: 500, running: true, blank: false, retainedBy: { mainView: 1 } },
    ses_2: { id: 'ses_2', displayTitle: 'API 排查', cwd: 'D:/work/alpha', updatedAt: 400 },
    ses_3: { id: 'ses_3', displayTitle: '登录问题', cwd: 'D:/work/alpha', updatedAt: 300 },
    ses_arch: { id: 'ses_arch', displayTitle: '归档会话', cwd: 'D:/work/alpha', updatedAt: 200 },
    ses_sub: { id: 'ses_sub', displayTitle: '子智能体', cwd: 'D:/work/alpha', updatedAt: 150, origin: 'subagent', parentId: 'ses_1' },
    ses_blank: { id: 'ses_blank', displayTitle: '', cwd: 'D:/work/alpha', updatedAt: 140, blank: true },
    ses_9: { id: 'ses_9', displayTitle: 'Beta 会话', cwd: 'D:/work/beta', updatedAt: 900 },
  };
  const list = { ids: Object.keys(byId), byId, current: 'ses_1', phase: 'ready' };
  const archivedIds = ['ses_arch'];
  const pinnedIds = ['ses_3'];
  const topicsOf = (workspaceId) => topics[workspaceId] ?? [];
  const assignmentsOf = (workspaceId) => assignments[workspaceId] ?? {};
  return { items, list, archivedIds, pinnedIds, topicsOf, assignmentsOf };
}

const flatten = (group) => group.sections.flatMap((section) => section.rows.map((row) => row.id));
const sectionIds = (group) => group.sections.map((section) => `${section.kind}:${section.name ?? ''}`);

test('mirrors native visibility: subagents and non-current blanks are hidden', () => {
  const built = buildTree({ ...fixture(), prefs: {}, query: '' });
  const alpha = built.groups.find((group) => group.workspaceId === WS_A);
  assert.equal(flatten(alpha).includes('ses_sub'), false);
  assert.equal(flatten(alpha).includes('ses_blank'), false);
  assert.equal(flatten(alpha).includes('ses_arch'), false, 'archived hidden by default');
  assert.equal(built.currentSessionId, 'ses_1');
  assert.equal(mainSessionId({ ids: [], byId: { a: { id: 'a' }, b: { id: 'b', retainedBy: { mainView: 2 } } }, current: 'a' }), 'b');
});

test('archived sessions appear in their own bucket when enabled', () => {
  const built = buildTree({ ...fixture(), prefs: { showArchived: true }, query: '' });
  const alpha = built.groups.find((group) => group.workspaceId === WS_A);
  assert.deepEqual(sectionIds(alpha).filter((entry) => entry.startsWith('archived')), ['archived:']);
  const archived = alpha.sections.find((section) => section.kind === 'archived');
  assert.deepEqual(archived.rows.map((row) => row.id), ['ses_arch']);
  assert.equal(archived.rows[0].archived, true);
});

test('topics folder the sessions and unassigned ones land in the default group', () => {
  const topics = { [WS_A]: [{ id: 'tp_1', name: '设计', emoji: '{1F4A1}', order: 0 }, { id: 'tp_2', name: '排查', emoji: '{1F3A8}', order: 1 }] };
  const assignments = { [WS_A]: { ses_1: 'tp_1', ses_2: 'tp_2', ses_arch: 'tp_1' } };
  const built = buildTree({ ...fixture({ topics, assignments }), prefs: {}, query: '' });
  const alpha = built.groups.find((group) => group.workspaceId === WS_A);
  assert.deepEqual(sectionIds(alpha), ['topic:默认分组', 'topic:设计', 'topic:排查'], 'the system default group leads');
  const fallback = alpha.sections[0];
  assert.equal(fallback.id, DEFAULT_TOPIC_ID);
  assert.equal(fallback.system, true);
  assert.deepEqual(fallback.rows.map((row) => row.id), ['ses_3'], 'unassigned sessions live in the default group');
  const design = alpha.sections[1];
  assert.deepEqual(design.rows.map((row) => row.id), ['ses_1']);
  assert.equal(design.rows[0].topicEmoji, '{1F4A1}');
  assert.equal(alpha.topicCount, 3);
  assert.equal(alpha.liveCount, 3);
});

test('a workspace with topics keeps its empty folders so they stay clickable', () => {
  const topics = { [WS_A]: [{ id: 'tp_empty', name: '空主题', emoji: '{1F6E0}', order: 0 }] };
  const built = buildTree({ ...fixture({ topics }), prefs: {}, query: '' });
  const alpha = built.groups.find((group) => group.workspaceId === WS_A);
  assert.equal(alpha.sections.some((section) => section.name === '空主题' && section.rows.length === 0), true);
});

test('pinned sessions lead their own bucket in host pin order', () => {
  const topics = {
    [WS_A]: [
      { id: 'tp_1', name: '设计', emoji: '{1F4A1}', order: 0 },
      { id: 'tp_2', name: '排查', emoji: '{1F3A8}', order: 1 },
    ],
  };
  // Most recently pinned first — the host returns the complete pin set in that order.
  const assignments = { [WS_A]: { ses_1: 'tp_1', ses_2: 'tp_1', ses_3: 'tp_2' } };
  const built = buildTree({ ...fixture({ topics, assignments }), pinnedIds: ['ses_2', 'ses_3'], prefs: {}, query: '' });
  const alpha = built.groups.find((group) => group.workspaceId === WS_A);
  const design = alpha.sections.find((section) => section.id === 'tp_1');
  const triage = alpha.sections.find((section) => section.id === 'tp_2');
  assert.deepEqual(design.rows.map((row) => row.id), ['ses_2', 'ses_1'], 'pinned row leads its topic');
  assert.deepEqual(triage.rows.map((row) => row.id), ['ses_3'], 'pinning never pulls a row out of its topic');
  assert.equal(design.rows[0].pinned, true);
});

test('pinned sessions lead the default group too', () => {
  const built = buildTree({ ...fixture(), pinnedIds: ['ses_3'], prefs: {}, query: '' });
  const alpha = built.groups.find((group) => group.workspaceId === WS_A);
  const fallback = alpha.sections.find((section) => section.id === DEFAULT_TOPIC_ID);
  assert.deepEqual(fallback.rows.map((row) => row.id), ['ses_3', 'ses_1', 'ses_2'], 'unpinned rows keep their relative order');
});

test('host statuses drive rows and roll up with pending > completed > running', () => {
  const topics = {
    [WS_A]: [
      { id: 'tp_1', name: '设计', emoji: '{1F4A1}', order: 0 },
      { id: 'tp_2', name: '排查', emoji: '{1F3A8}', order: 1 },
    ],
  };
  const assignments = { [WS_A]: { ses_1: 'tp_1', ses_2: 'tp_2', ses_3: 'tp_2', ses_arch: 'tp_1' } };
  const statuses = new Map([
    ['ses_1', { running: true, pendingInteraction: { kind: 'question' } }],
    ['ses_2', { running: false, completionUnread: true }],
    ['ses_3', { running: true }],
    ['ses_arch', { pendingInteraction: { kind: 'approval' } }],
  ]);
  const built = buildTree({ ...fixture({ topics, assignments }), statuses, prefs: { showArchived: true }, query: '' });
  const alpha = built.groups.find((group) => group.workspaceId === WS_A);
  const design = alpha.sections.find((section) => section.id === 'tp_1');
  const triage = alpha.sections.find((section) => section.id === 'tp_2');
  const archived = alpha.sections.find((section) => section.kind === 'archived');
  const pending = design.rows.find((row) => row.id === 'ses_1');
  const completed = triage.rows.find((row) => row.id === 'ses_2');
  const running = triage.rows.find((row) => row.id === 'ses_3');

  assert.equal(pending.pendingKind, 'question');
  assert.equal(pending.status, 'warning', 'a pending question wins over the live run');
  assert.equal(pending.running, true);
  assert.equal(completed.completed, true);
  assert.equal(completed.status, 'done');
  assert.equal(running.status, 'ongoing');
  assert.equal(design.status, 'warning');
  assert.equal(triage.status, 'done', 'an unread completion outranks a running sibling');
  assert.equal(alpha.status, 'warning', 'the workspace takes the strongest topic status');
  assert.equal(archived.status, null, 'archived rows never surface a status');
});

test('workspace status is an overview that ignores topic and search filters', () => {
  const topics = {
    [WS_A]: [
      { id: 'tp_1', name: '设计', order: 0 },
      { id: 'tp_2', name: '排查', order: 1 },
    ],
  };
  const assignments = { [WS_A]: { ses_1: 'tp_1', ses_2: 'tp_2', ses_3: 'tp_2' } };
  const statuses = new Map([
    ['ses_1', { pendingInteraction: { kind: 'question' } }],
    ['ses_2', { running: true }],
  ]);
  const base = { ...fixture({ topics, assignments }), statuses };

  const filtered = buildTree({ ...base, prefs: { topicFilter: 'tp_2' }, query: '' });
  const alpha = filtered.groups.find((group) => group.workspaceId === WS_A);
  assert.equal(alpha.status, 'warning', 'a pending row hidden by the topic filter still warns');
  assert.equal(alpha.sections.find((section) => section.id === 'tp_2').status, 'ongoing', 'the visible topic keeps its own status');

  const searched = buildTree({ ...base, prefs: {}, query: 'API' });
  const searchedAlpha = searched.groups.find((group) => group.workspaceId === WS_A);
  assert.equal(searchedAlpha.status, 'warning', 'a search does not hide the workspace overview');
  assert.deepEqual(flatten(searchedAlpha), ['ses_2']);
});

test('a topic filter locks the workspace it was opened from when ids are shared', () => {
  // Every workspace owns a virtual tp_default, so the id alone cannot identify the scope.
  const scoped = buildTree({
    ...fixture(),
    prefs: { topicFilter: DEFAULT_TOPIC_ID, workspaceFilter: WS_B },
    query: '',
  });
  assert.deepEqual(scoped.groups.map((group) => group.workspaceId), [WS_B]);
  assert.equal(scoped.currentWorkspaceId, WS_B, 'the locked workspace is the highlighted one');
});

test('workspace filter scopes the tree, topic filter keeps only that folder', () => {
  const topics = { [WS_A]: [{ id: 'tp_1', name: '设计', emoji: '{1F4A1}', order: 0 }], [WS_B]: [{ id: 'tp_b', name: 'Beta 主题', emoji: '{1F535}', order: 0 }] };
  const assignments = { [WS_A]: { ses_1: 'tp_1' }, [WS_B]: { ses_9: 'tp_b' } };
  const scoped = buildTree({ ...fixture({ topics, assignments }), prefs: { workspaceFilter: WS_A }, query: '' });
  assert.deepEqual(scoped.groups.map((group) => group.workspaceId), [WS_A]);

  const filtered = buildTree({ ...fixture({ topics, assignments }), prefs: { topicFilter: 'tp_1' }, query: '' });
  assert.deepEqual(filtered.groups.map((group) => group.workspaceId), [WS_A], 'a topic filter also scopes to the topic owner workspace');
  const alpha = filtered.groups.find((group) => group.workspaceId === WS_A);
  assert.deepEqual(flatten(alpha), ['ses_1']);
});

test('search matches title, workspace and topic names and caps results', () => {
  const topics = { [WS_A]: [{ id: 'tp_1', name: '登录', emoji: '{1F4A1}', order: 0 }] };
  const assignments = { [WS_A]: { ses_3: 'tp_1' } };
  const built = buildTree({ ...fixture({ topics, assignments }), prefs: {}, query: '登录' });
  assert.deepEqual(flatten(built.groups.find((group) => group.workspaceId === WS_A)), ['ses_3']);
  assert.equal(built.matched, 1);

  const byWorkspaceName = buildTree({ ...fixture(), prefs: {}, query: 'beta' });
  assert.deepEqual(byWorkspaceName.groups.flatMap(flatten), ['ses_9']);
  assert.deepEqual(byWorkspaceName.groups.map((group) => group.workspaceId), [WS_B], 'a workspace with no match does not render an empty header');
  const noMatch = buildTree({ ...fixture(), prefs: {}, query: 'nothing-matches' });
  assert.deepEqual(noMatch.groups, [], 'no matches leaves the tree empty so the empty state can render');
  assert.equal(noMatch.matched, 0);

  const many = { ids: [], byId: {}, current: undefined };
  for (let index = 0; index < 140; index++) {
    many.ids.push(`ses_${index}`);
    many.byId[`ses_${index}`] = { id: `ses_${index}`, displayTitle: `命中 ${index}`, cwd: 'D:/work/alpha', updatedAt: index };
  }
  const capped = buildTree({
    items: [{ workspaceId: WS_A, path: 'D:/work/alpha', title: 'Alpha', sessionIds: many.ids }],
    list: many,
    archivedIds: [],
    pinnedIds: [],
    topicsOf: () => [],
    assignmentsOf: () => ({}),
    prefs: {},
    query: '命中',
  });
  assert.equal(capped.truncated, true);
  assert.equal(capped.groups.flatMap(flatten).length, 100);
});

test('sessions missing from the workspace record still surface by cwd', () => {
  const built = buildTree({ ...fixture(), prefs: {}, query: '' });
  const alpha = built.groups.find((group) => group.workspaceId === WS_A);
  assert.equal(alpha.liveCount, 3);

  const loose = buildTree({
    items: [{ workspaceId: WS_A, path: 'D:/work/alpha', title: 'Alpha', sessionIds: ['ses_1'] }],
    list: fixture().list,
    archivedIds: ['ses_arch'],
    pinnedIds: [],
    topicsOf: () => [],
    assignmentsOf: () => ({}),
    prefs: {},
    query: '',
  });
  assert.deepEqual(
    flatten(loose.groups[0]).sort(),
    ['ses_1', 'ses_2', 'ses_3'],
    'cwd-matched sessions are appended even when the workspace record lags',
  );
});

test('sessions no workspace accounts for trail in a virtual 未分组 group', () => {
  const base = fixture();
  const byId = { ...base.byId, ses_stray: { id: 'ses_stray', displayTitle: '游离会话', cwd: 'D:/elsewhere', updatedAt: 50 } };
  const list = { ...base.list, ids: [...base.list.ids, 'ses_stray'], byId };
  const loose = { ...base, byId, list };

  const built = buildTree({ ...loose, prefs: {}, query: '' });
  const virtual = built.groups.at(-1);
  assert.equal(virtual.workspaceId, UNGROUPED_WORKSPACE_ID);
  assert.equal(virtual.virtual, true);
  assert.equal(virtual.title, '未分组');
  assert.deepEqual(flatten(virtual), ['ses_stray'], 'the row lives in the trailing group');
  assert.deepEqual(sectionIds(virtual), ['topic:默认分组']);
  assert.equal(virtual.sections[0].bare, true, '未分组 is a bucket, so it renders no group row');

  const filtered = buildTree({ ...loose, prefs: { workspaceFilter: WS_A }, query: '' });
  assert.equal(filtered.groups.some((group) => group.virtual), false, 'workspace filters never include 未分组');

  const searched = buildTree({ ...loose, prefs: {}, query: '游离' });
  assert.equal(searched.groups.at(-1).virtual, true);
  assert.deepEqual(flatten(searched.groups.at(-1)), ['ses_stray'], 'search can find stray sessions');

  const archivedOnly = buildTree({ ...loose, archivedIds: ['ses_stray'], prefs: { showArchived: true }, query: '' });
  assert.equal(archivedOnly.groups.some((group) => group.virtual), false, 'archived strays never create a 未分组 group');

  const byIdWithArchive = {
    ...byId,
    ses_arch_stray: { id: 'ses_arch_stray', displayTitle: '归档游离', cwd: 'D:/elsewhere', updatedAt: 60 },
  };
  const mixed = buildTree({
    ...loose,
    list: { ...list, ids: [...list.ids, 'ses_arch_stray'], byId: byIdWithArchive },
    byId: byIdWithArchive,
    archivedIds: ['ses_arch_stray'],
    prefs: { showArchived: true },
    query: '',
  });
  const mixedVirtual = mixed.groups.at(-1);
  assert.deepEqual(flatten(mixedVirtual), ['ses_stray'], 'archived strays stay out of the virtual group');
  assert.equal(mixedVirtual.archivedCount, 0, '未分组 never carries an archived bucket');
});

test('the virtual ungrouped workspace keeps its overview status under search', () => {
  const byId = {
    ses_match: { id: 'ses_match', displayTitle: '匹配会话', cwd: 'D:/elsewhere', updatedAt: 20 },
    ses_pending: { id: 'ses_pending', displayTitle: '待回答会话', cwd: 'D:/elsewhere', updatedAt: 10 },
  };
  const list = { ids: Object.keys(byId), byId, current: 'ses_match', phase: 'ready' };
  const statuses = new Map([['ses_pending', { pendingInteraction: { kind: 'question' } }]]);
  const built = buildTree({
    items: [],
    list,
    statuses,
    archivedIds: [],
    pinnedIds: [],
    topicsOf: () => [],
    assignmentsOf: () => ({}),
    prefs: {},
    query: '匹配',
  });
  const virtual = built.groups.at(-1);
  assert.equal(virtual.workspaceId, UNGROUPED_WORKSPACE_ID);
  assert.equal(virtual.status, 'warning', 'a matching row does not hide the pending sibling');
  assert.deepEqual(flatten(virtual), ['ses_match']);
});

test('collapse state is read from prefs with stable composite keys', () => {
  const topics = { [WS_A]: [{ id: 'tp_1', name: '设计', emoji: '{1F4A1}', order: 0 }] };
  const prefs = { collapsedWorkspaces: [WS_A], collapsedTopics: [`${WS_A}:tp_1`] };
  const built = buildTree({ ...fixture({ topics, assignments: { [WS_A]: { ses_1: 'tp_1' } } }), prefs, query: '' });
  const alpha = built.groups.find((group) => group.workspaceId === WS_A);
  assert.equal(alpha.collapsed, true);
  assert.equal(alpha.sections.find((section) => section.id === 'tp_1').collapsed, true);
});

test('search forces everything expanded', () => {
  const topics = { [WS_A]: [{ id: 'tp_1', name: '设计', emoji: '{1F4A1}', order: 0 }] };
  const built = buildTree({
    ...fixture({ topics, assignments: { [WS_A]: { ses_1: 'tp_1' } } }),
    prefs: { collapsedWorkspaces: [WS_A], collapsedTopics: [`${WS_A}:tp_1`] },
    query: '设计',
  });
  assert.equal(built.groups[0].collapsed, false);
  assert.equal(built.groups[0].sections[0].collapsed, false);
});

test('a topic filter also scopes the archived bucket', () => {
  const topics = { [WS_A]: [{ id: 'tp_1', name: '设计', emoji: '{1F4A1}', order: 0 }, { id: 'tp_2', name: '排查', emoji: '{1F3A8}', order: 1 }] };
  const assignments = { [WS_A]: { ses_1: 'tp_1', ses_arch: 'tp_2' } };
  const built = buildTree({
    ...fixture({ topics, assignments }),
    prefs: { topicFilter: 'tp_1', showArchived: true },
    query: '',
  });
  const alpha = built.groups.find((group) => group.workspaceId === WS_A);
  assert.deepEqual(flatten(alpha), ['ses_1'], "archived rows from another topic don't leak into this folder's view");
  assert.equal(alpha.sections.some((section) => section.kind === 'archived'), false);

  const other = buildTree({
    ...fixture({ topics, assignments }),
    prefs: { topicFilter: 'tp_2', showArchived: true },
    query: '',
  });
  const archived = other.groups.find((group) => group.workspaceId === WS_A).sections.find((section) => section.kind === 'archived');
  assert.deepEqual(archived.rows.map((row) => row.id), ['ses_arch'], 'an archived row keeps its topic membership');
});

test('moveWithin places the dragged id next to its target', () => {
  assert.deepEqual(moveWithin(['a', 'b', 'c'], 'a', 'c', 'after'), ['b', 'c', 'a']);
  assert.deepEqual(moveWithin(['a', 'b', 'c'], 'c', 'a', 'before'), ['c', 'a', 'b']);
  assert.deepEqual(moveWithin(['a', 'b'], 'a', 'zz', 'after'), ['a', 'b'], 'an unknown target changes nothing');
});

test('a manual order permutes only the ids it names and leaves the rest in place', () => {
  const reordered = buildTree({ ...fixture(), prefs: { workspaceOrder: [WS_B, WS_A] }, query: '' });
  assert.deepEqual(reordered.groups.map((group) => group.workspaceId), [WS_B, WS_A]);

  const sessions = buildTree({ ...fixture(), prefs: { sessionOrder: { [WS_A]: ['ses_3', 'ses_2', 'ses_1'] } }, query: '' });
  assert.deepEqual(flatten(sessions.groups.find((group) => group.workspaceId === WS_A)), ['ses_3', 'ses_2', 'ses_1']);

  // Ids the manual list never met keep the slot the host gave them instead of sinking to the
  // end: `ses_3` is pinned (so the host leads with it in the default bucket) and the manual
  // order does not name it, so it must stay first while `ses_2`/`ses_1` swap behind it.
  const partial = buildTree({ ...fixture(), prefs: { sessionOrder: { [WS_A]: ['ses_2', 'ses_1'] } }, query: '' });
  assert.deepEqual(flatten(partial.groups.find((group) => group.workspaceId === WS_A)), ['ses_3', 'ses_2', 'ses_1']);
});

test('a second drag anchors on the displayed order, not on the host order', () => {
  // What the panel does on drop: translate the pointer position inside the order the user sees.
  const ids = ['A', 'B', 'C'];
  const display = (manual) => orderByManual(ids, manual);
  const first = moveWithin(display([]), 'C', 'A', 'before');
  assert.deepEqual(display(first), ['C', 'A', 'B'], 'the first drag lands where it was dropped');
  // Anchoring on the raw host order here produced B A C (expected C B A) — the row jumped to a
  // place the insertion line never pointed at.
  const second = moveWithin(display(first), 'A', 'B', 'after');
  assert.deepEqual(display(second), ['C', 'B', 'A']);
});

test('a second workspace drag lands where the insertion line points', () => {
  const ids = [WS_A, WS_B, 'ws_c'];
  const items = [
    ...fixture().items,
    { workspaceId: 'ws_c', path: 'D:/work/gamma', title: 'Gamma', sessionIds: [], createdAt: 3, updatedAt: 30 },
  ];
  const manual = (workspaceOrder) => buildTree({ ...fixture(), items, prefs: { workspaceOrder }, query: '' }).groups.map((group) => group.workspaceId);
  const first = moveWithin(orderByManual(ids, []), 'ws_c', WS_A, 'before');
  assert.deepEqual(manual(first), ['ws_c', WS_A, WS_B]);
  const second = moveWithin(orderByManual(ids, first), WS_A, WS_B, 'after');
  assert.deepEqual(manual(second), ['ws_c', WS_B, WS_A]);
});

test('the drag baseline includes cwd-matched stragglers by recency and never subagents', () => {
  const base = fixture();
  // A session the workspace record never accounted for (host crashed before attachSession).
  const byId = {
    ...base.list.byId,
    ses_stray: { id: 'ses_stray', displayTitle: '漏记账的会话', cwd: 'D:/work/alpha', updatedAt: 800 },
  };
  const ids = workspaceSessionIds({ workspace: base.items[0], byId });
  assert.deepEqual(ids, ['ses_1', 'ses_2', 'ses_3', 'ses_arch', 'ses_blank', 'ses_stray'], 'record order, then stragglers by recency');
  assert.equal(ids.includes('ses_sub'), false, 'a subagent is never part of the manual order');
  const tree = buildTree({ ...fixture(), list: { ...base.list, byId }, prefs: {}, query: '' });
  assert.deepEqual(flatten(tree.groups.find((group) => group.workspaceId === WS_A)), ['ses_3', 'ses_1', 'ses_2', 'ses_stray'], 'and the tree appends the straggler by recency (ses_3 is pinned)');

  const strays = ungroupedSessionIds({ workspaces: base.items, byId: { ses_loose: { id: 'ses_loose', cwd: '/elsewhere', updatedAt: 1 } } });
  assert.deepEqual(strays, ['ses_loose'], 'a session no workspace accounts for belongs to 未分组');
});

test('a session created after a drag keeps its host position instead of sinking to the bottom', () => {
  // `attachSession` prepends, so a brand-new session is first in the workspace's own order.
  const created = { id: 'ses_new', displayTitle: '刚建的会话', cwd: 'D:/work/alpha', updatedAt: 999 };
  const base = fixture();
  const items = [
    { ...base.items[0], sessionIds: ['ses_new', ...base.items[0].sessionIds] },
    base.items[1],
  ];
  const list = { ...base.list, ids: ['ses_new', ...base.list.ids], byId: { ...base.list.byId, ses_new: created } };
  // A manual order saved before `ses_new` existed.
  const built = buildTree({
    ...base,
    items,
    list,
    // Pinning would lead the bucket anyway and hide what this test is about.
    pinnedIds: [],
    prefs: { sessionOrder: { [WS_A]: ['ses_2', 'ses_3', 'ses_1'] } },
    query: '',
  });
  const rows = flatten(built.groups.find((group) => group.workspaceId === WS_A));
  assert.equal(rows[0], 'ses_new', 'the unnamed new session keeps the front slot the host gave it');
  assert.deepEqual(rows.slice(1), ['ses_2', 'ses_3', 'ses_1'], 'and the named ids still permute among themselves');
});

test('workspace options carry live and archived counts', () => {
  const options = buildWorkspaceOptions(fixture());
  const alpha = options.find((option) => option.workspaceId === WS_A);
  assert.equal(alpha.title, 'Alpha');
  assert.equal(alpha.visibleCount, 3);
  assert.equal(alpha.archivedCount, 1);
  assert.equal(basename('D:/work/alpha/'), 'alpha');
  assert.equal(basename(''), '');
});

test('an unlabeled workspace falls back to its path basename', () => {
  const options = buildWorkspaceOptions({ items: [{ workspaceId: 'ws_x', path: 'D:/work/nova', sessionIds: [] }], list: { byId: {} }, archivedIds: [] });
  assert.equal(options[0].title, 'nova');
});

test('workspace paths compare by spelling, separator and case', () => {
  assert.equal(samePath('D:\\work\\alpha', 'D:/work/alpha'), true);
  assert.equal(samePath('D:\\work\\alpha\\', 'D:/work/alpha'), true, 'a trailing separator is not a different directory');
  assert.equal(samePath('d:\\WORK\\Alpha', 'D:/work/alpha'), true, 'Windows casing cannot split a workspace');
  assert.equal(samePath('D:/work/alpha', 'D:/work/beta'), false);
  assert.equal(samePath('', ''), false, 'two missing paths are not "the same workspace"');
  assert.equal(samePath(undefined, 'D:/work/alpha'), false);
});

test('POSIX paths stay case-sensitive, because they name different directories', () => {
  // Folding these would put one session under two workspaces (a real regression, reproduced
  // before this rule existed).
  assert.equal(samePath('/tmp/Alpha', '/tmp/alpha'), false);
  assert.equal(samePath('/tmp/alpha/', '/tmp/alpha'), true, 'a trailing slash is still the same directory');
  assert.equal(samePath('/tmp/a\\b', '/tmp/a/b'), false, 'a backslash is a legal filename character on POSIX');
});

test('a session in a case-only-different POSIX workspace renders exactly once', () => {
  const items = [
    { workspaceId: 'ws_upper', path: '/tmp/Alpha', title: 'Upper', sessionIds: [] },
    { workspaceId: 'ws_lower', path: '/tmp/alpha', title: 'Lower', sessionIds: [] },
  ];
  const built = buildTree({
    items,
    list: { ids: ['s1'], byId: { s1: { id: 's1', displayTitle: 'case only', cwd: '/tmp/alpha', updatedAt: 1 } }, current: 's1', phase: 'ready' },
    statuses: new Map(),
    archivedIds: [],
    pinnedIds: [],
    topicsOf: () => [],
    assignmentsOf: () => ({}),
    prefs: {},
    query: '',
  });
  const carriers = built.groups
    .filter((group) => group.sections.some((section) => section.rows.some((row) => row.id === 's1')))
    .map((group) => group.workspaceId);
  assert.deepEqual(carriers, ['ws_lower'], 'only the exact-case workspace shows it');
});

test('a session whose cwd spells its workspace path differently still joins that workspace', () => {
  const base = fixture();
  const items = [
    { ...base.items[0], sessionIds: ['ses_1'], path: 'D:\\work\\ALPHA' },
    base.items[1],
  ];
  const list = {
    ...base.list,
    ids: [...base.list.ids, 'ses_spelled'],
    byId: {
      ...base.list.byId,
      // The host has not accounted this one; its cwd only matches on the normalized spelling.
      ses_spelled: { id: 'ses_spelled', displayTitle: '拼写不同的会话', cwd: 'D:/work/alpha', updatedAt: 9 },
    },
  };
  const built = buildTree({ ...base, items, list, prefs: {}, query: '' });
  const alpha = built.groups.find((group) => group.workspaceId === WS_A);
  assert.ok(flatten(alpha).includes('ses_spelled'), 'the session is shown under its workspace');
  const ungrouped = built.groups.find((group) => group.workspaceId === UNGROUPED_WORKSPACE_ID);
  assert.equal(ungrouped, undefined, 'and not in the trailing 未分组 bucket');
});

test('the highlighted folder follows the workspace filter, then the open session', () => {
  const unfiltered = buildTree({ ...fixture(), prefs: {}, query: '' });
  assert.equal(unfiltered.currentWorkspaceId, WS_A, 'no filter: the folder owning the open session');

  const filtered = buildTree({ ...fixture(), prefs: { workspaceFilter: WS_B }, query: '' });
  assert.equal(filtered.currentWorkspaceId, WS_B, 'a filter wins: the folder the user is looking at');
  assert.deepEqual(filtered.groups.map((group) => group.workspaceId), [WS_B]);
});

/**
 * Reference stability is what makes `React.memo` on Section / SessionRow do anything at all:
 * a fresh row object per build re-rendered every mounted row for a list publish, a status flip
 * or a 30s tick (measured: 1500 rows ≈ 55–63 ms per trigger with zero DOM change). These
 * assertions fail if the caching is removed or its fingerprint stops covering a field.
 */
test('an unchanged build returns the same row, section and group objects', () => {
  const first = buildTree({ ...fixture(), prefs: {}, query: '', now: 1_700_000_000_000 });
  const second = buildTree({ ...fixture(), prefs: {}, query: '', now: 1_700_000_000_000 });
  assert.equal(second.groups.length, first.groups.length);
  for (const [index, group] of first.groups.entries()) {
    assert.equal(second.groups[index], group, 'the group object is reused');
    for (const [sectionIndex, section] of group.sections.entries()) {
      assert.equal(second.groups[index].sections[sectionIndex], section, 'the section object is reused');
      for (const [rowIndex, row] of section.rows.entries()) {
        assert.equal(second.groups[index].sections[sectionIndex].rows[rowIndex], row, 'the row object is reused');
      }
    }
  }
});

test('a tick inside the same minute reuses rows, a new minute does not', () => {
  const base = 1_700_000_040_000; // an exact minute boundary
  // The shared fixture's `updatedAt` values are epoch-adjacent, so their label would read
  // "N 年" and never vary. This case needs sessions updated seconds ago: that is the only
  // time the label has minute precision worth skipping a tick for.
  const byId = {
    ses_recent_a: { id: 'ses_recent_a', displayTitle: '刚说过话', cwd: 'D:/work/alpha', updatedAt: base - 30_000 },
    ses_recent_b: { id: 'ses_recent_b', displayTitle: '两分钟前', cwd: 'D:/work/alpha', updatedAt: base - 120_000 },
  };
  const items = [{ workspaceId: WS_A, path: 'D:/work/alpha', title: 'Alpha', sessionIds: Object.keys(byId), createdAt: 1, updatedAt: 10 }];
  const input = {
    items,
    list: { ids: Object.keys(byId), byId, current: 'ses_recent_a', phase: 'ready' },
    archivedIds: [],
    pinnedIds: [],
    topicsOf: () => [],
    assignmentsOf: () => ({}),
    prefs: {},
    query: '',
  };
  const early = buildTree({ ...input, now: base + 1_000 });
  const late = buildTree({ ...input, now: base + 45_000 });
  const nextMinute = buildTree({ ...input, now: base + 65_000 });
  const rowsOf = (built) => built.groups.flatMap((group) => group.sections.flatMap((section) => section.rows));
  assert.deepEqual(rowsOf(late), rowsOf(early), 'same minute: identical row objects');
  const previous = rowsOf(early);
  const changed = rowsOf(nextMinute).filter((row, index) => row !== previous[index]);
  assert.ok(changed.length > 0, 'a new minute produces new labels, so those rows must be rebuilt');
  assert.notEqual(changed[0].timeLabel, previous.find((row) => row.id === changed[0].id).timeLabel);
});

test('a changed field rebuilds only the affected row', () => {
  const input = { ...fixture(), prefs: {}, query: '', now: 1_700_000_000_000 };
  const before = buildTree(input);
  const byId = { ...input.list.byId, ses_2: { ...input.list.byId.ses_2, displayTitle: '改名之后' } };
  const after = buildTree({ ...input, list: { ...input.list, byId } });
  const rowsOf = (built) => built.groups.flatMap((group) => group.sections.flatMap((section) => section.rows));
  const previous = rowsOf(before);
  const next = rowsOf(after);
  const rebuilt = next.filter((row, index) => row !== previous[index]);
  assert.deepEqual(rebuilt.map((row) => row.id), ['ses_2'], 'only the renamed row is new');
  assert.equal(rebuilt[0].title, '改名之后');
});

test('a status flip rebuilds the row it touches and the sections above it', () => {
  const input = { ...fixture(), prefs: {}, query: '', now: 1_700_000_000_000 };
  const before = buildTree(input);
  const statuses = new Map([['ses_3', { running: true }]]);
  const after = buildTree({ ...input, statuses });
  const alphaBefore = before.groups.find((group) => group.workspaceId === WS_A);
  const alphaAfter = after.groups.find((group) => group.workspaceId === WS_A);
  assert.notEqual(alphaAfter, alphaBefore, 'the workspace aggregate changed');
  const rowsOf = (group) => group.sections.flatMap((section) => section.rows);
  const rebuilt = rowsOf(alphaAfter).filter((row, index) => row !== rowsOf(alphaBefore)[index]);
  assert.deepEqual(rebuilt.map((row) => row.id), ['ses_3'], 'exactly one row is rebuilt');
  assert.equal(rebuilt[0].running, true);
});

test('the row cache does not grow with sessions the host dropped', () => {
  const input = { ...fixture(), prefs: {}, query: '', now: 1_700_000_000_000 };
  buildTree(input);
  const items = input.items.map((item) => ({ ...item, sessionIds: item.sessionIds.filter((id) => id !== 'ses_3') }));
  const byId = { ...input.list.byId };
  delete byId.ses_3;
  const shrunk = buildTree({ ...input, items, list: { ...input.list, byId, ids: Object.keys(byId) } });
  assert.equal(shrunk.groups.some((group) => group.sections.some((section) => section.rows.some((row) => row.id === 'ses_3'))), false);
  // Build it back: the re-added row must be rebuilt rather than resurrect an evicted cache entry.
  const restored = buildTree(input);
  const row = restored.groups.find((group) => group.workspaceId === WS_A).sections.flatMap((section) => section.rows).find((entry) => entry.id === 'ses_3');
  assert.ok(row, 'the row comes back');
  assert.equal(row.id, 'ses_3');
});
