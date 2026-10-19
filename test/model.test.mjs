import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTree, buildWorkspaceOptions, mainSessionId, basename, newestTopic } from '../client/model.js';

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

test('topics folder the sessions and unfiled stays last', () => {
  const topics = { [WS_A]: [{ id: 'tp_1', name: '设计', emoji: '{1F4A1}', order: 0 }, { id: 'tp_2', name: '排查', emoji: '{1F3A8}', order: 1 }] };
  const assignments = { [WS_A]: { ses_1: 'tp_1', ses_2: 'tp_2', ses_arch: 'tp_1' } };
  const built = buildTree({ ...fixture({ topics, assignments }), prefs: {}, query: '' });
  const alpha = built.groups.find((group) => group.workspaceId === WS_A);
  assert.deepEqual(sectionIds(alpha), ['topic:设计', 'topic:排查', 'ungrouped:']);
  const design = alpha.sections[0];
  assert.deepEqual(design.rows.map((row) => row.id), ['ses_1']);
  assert.equal(design.rows[0].topicEmoji, '{1F4A1}');
  assert.deepEqual(alpha.sections[2].rows.map((row) => row.id), ['ses_3'], 'pinned/unfiled land in 未分类');
  assert.equal(alpha.topicCount, 2);
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

test('pinned sessions lead the unfiled bucket too', () => {
  const built = buildTree({ ...fixture(), pinnedIds: ['ses_3'], prefs: {}, query: '' });
  const alpha = built.groups.find((group) => group.workspaceId === WS_A);
  const unfiled = alpha.sections.find((section) => section.kind === 'ungrouped');
  assert.deepEqual(unfiled.rows.map((row) => row.id), ['ses_3', 'ses_1', 'ses_2'], 'unpinned rows keep their relative order');
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

test('collapse state is read from prefs with stable composite keys', () => {
  const topics = { [WS_A]: [{ id: 'tp_1', name: '设计', emoji: '{1F4A1}', order: 0 }] };
  const prefs = { collapsedWorkspaces: [WS_A], collapsedTopics: [`${WS_A}:tp_1`] };
  const built = buildTree({ ...fixture({ topics, assignments: { [WS_A]: { ses_1: 'tp_1' } } }), prefs, query: '' });
  const alpha = built.groups.find((group) => group.workspaceId === WS_A);
  assert.equal(alpha.collapsed, true);
  assert.equal(alpha.sections[0].collapsed, true);
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

test('the newest topic follows createdAt, then append order for older documents', () => {
  assert.equal(newestTopic([]), null);
  assert.equal(newestTopic(undefined), null);
  assert.equal(
    newestTopic([
      { id: 'tp_old', createdAt: 100 },
      { id: 'tp_new', createdAt: 300 },
      { id: 'tp_mid', createdAt: 200 },
    ]).id,
    'tp_new',
  );
  assert.equal(
    newestTopic([{ id: 'tp_a', order: 0 }, { id: 'tp_b', order: 1 }]).id,
    'tp_b',
    'documents without timestamps append new topics at the end',
  );
});

test('the highlighted folder follows the workspace filter, then the open session', () => {
  const unfiltered = buildTree({ ...fixture(), prefs: {}, query: '' });
  assert.equal(unfiltered.currentWorkspaceId, WS_A, 'no filter: the folder owning the open session');

  const filtered = buildTree({ ...fixture(), prefs: { workspaceFilter: WS_B }, query: '' });
  assert.equal(filtered.currentWorkspaceId, WS_B, 'a filter wins: the folder the user is looking at');
  assert.deepEqual(filtered.groups.map((group) => group.workspaceId), [WS_B]);
});
