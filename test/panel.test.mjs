/**
 * Integration checks against the *shipped* bundle (`lib/client.js`), not the sources: the
 * bundle is what DSH loads, and it owns the only live copies of i18n, actions and geometry.
 *
 * jsdom performs no layout, so `getBoundingClientRect` is answered from a table keyed by the
 * same class names the real 0.2.1 shell produces; the host API is recorded through `fetch`.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const here = dirname(fileURLToPath(import.meta.url));
const BUNDLE = join(here, '..', 'lib', 'client.js');

const WORKSPACE = 'ws_one';
const TOPIC = 'tp_one';
const API = '/dsh-better-workspace/api';

let dom;
let window;
let document;
let container;
let root;
let React;
let act;
let calls;
let responseOverrides;
let sessionSource;
let workspaceSource;
let disposers;
let slotCalls;
/** Per-test override for `archiveSession`, so the "needs a stop" path can be exercised. */
let archiveImpl;
/** Per-test override for `pinSession`, so a click can move the host's pin set. */
let pinImpl;

function makeSessions(count, offset = 0) {
  const byId = {};
  const ids = [];
  for (let index = 0; index < count; index++) {
    const id = `ses_${index + offset}`;
    ids.push(id);
    byId[id] = { id, displayTitle: `会话 ${index + offset}`, cwd: 'D:/work/one', updatedAt: 1_700_000_000_000 + index, blank: false };
  }
  return { ids, byId, current: ids[0], phase: 'ready' };
}

function stateResult() {
  return {
    ok: true,
    result: {
      enabled: true,
      deleteAvailable: true,
      revision: 4,
      updatedAt: 1,
      readOnly: false,
      warning: null,
      emojis: ['\u{1F4C1}', '\u{1F4A1}', '\u{1F3A8}', '\u{1F680}'],
      workspaces: {
        [WORKSPACE]: {
          topics: [
            { id: 'tp_default', name: '默认分组', emoji: '', order: -1, createdAt: 0, system: true },
            { id: TOPIC, name: '设计', emoji: '\u{1F4A1}', order: 0, createdAt: 1 },
          ],
          assignments: { ses_0: TOPIC },
        },
      },
    },
  };
}

function makeSource(value) {
  const listeners = new Set();
  return {
    getSnapshot: () => value,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next) {
      value = next;
      listeners.forEach((listener) => listener(next));
    },
  };
}

function installFakeLayout() {
  const rects = new Map([
    ['BynINW_frame', { x: 0, y: 0, width: 1600, height: 900 }],
    ['BynINW_sidebarCol', { x: 0, y: 0, width: 280, height: 900 }],
    ['BynINW_overlayLayer', { x: 0, y: 0, width: 1600, height: 900 }],
    ['_2H3hWW_regionArea', { x: 0, y: 200, width: 272, height: 700 }],
    ['_9lTDKa_root', { x: 0, y: 200, width: 268, height: 700 }],
    ['_9lTDKa_sectionHeader', { x: 0, y: 200, width: 268, height: 28 }],
    ['_9lTDKa_list', { x: 0, y: 230, width: 268, height: 660 }],
    ['Hqq-bq_workspaceRow', { x: 600, y: 500, width: 700, height: 28 }],
    ['Hqq-bq_workspace', { x: 608, y: 504, width: 120, height: 20 }],
  ]);
  window.Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    const classes = (this.className || '').toString().split(/\s+/);
    let rect = { x: 0, y: 0, width: 0, height: 0 };
    for (const name of classes) {
      if (rects.has(name)) {
        rect = rects.get(name);
        break;
      }
    }
    return { ...rect, top: rect.y, left: rect.x, right: rect.x + rect.width, bottom: rect.y + rect.height, toJSON: () => rect };
  };
}

function installShell() {
  const frame = document.createElement('div');
  frame.className = 'BynINW_frame';
  const col = document.createElement('div');
  col.className = 'BynINW_sidebarCol';
  const region = document.createElement('div');
  region.className = '_2H3hWW_regionArea';
  const browserRoot = document.createElement('div');
  browserRoot.className = '_9lTDKa_root';
  const header = document.createElement('div');
  header.className = '_9lTDKa_sectionHeader';
  header.textContent = '工作区';
  const list = document.createElement('div');
  list.className = '_9lTDKa_list';
  list.setAttribute('role', 'tree');
  browserRoot.append(header, list);
  region.append(browserRoot);
  col.append(region);
  const layer = document.createElement('div');
  layer.className = 'BynINW_overlayLayer';
  layer.setAttribute('data-shell-overlay', '');
  frame.append(col, layer);
  const composerRow = document.createElement('div');
  composerRow.className = 'Hqq-bq_workspaceRow';
  const picker = document.createElement('button');
  picker.className = 'Hqq-bq_workspace';
  picker.setAttribute('aria-label', '选择工作区');
  picker.textContent = 'One';
  composerRow.append(picker);
  document.body.append(frame, composerRow);
  container = document.createElement('div');
  layer.append(container);
  return { frame, region, layer };
}

function makeDataTransfer(ids, text) {
  const store = new Map();
  if (ids) store.set('application/x-dsh-topic-sessions', JSON.stringify(ids));
  if (text !== undefined) store.set('text/plain', text);
  return {
    setData: (type, value) => store.set(type, value),
    getData: (type) => store.get(type) ?? '',
    effectAllowed: '',
    dropEffect: '',
  };
}

const tick = (ms = 30) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)));

function find(selector, text) {
  const nodes = [...container.querySelectorAll(selector)];
  return text ? nodes.find((node) => node.textContent.includes(text)) : nodes[0];
}

function findAnywhere(selector, text) {
  const nodes = [...document.querySelectorAll(selector)];
  return text ? nodes.find((node) => node.textContent.includes(text)) : nodes[0];
}

/** The host icon set, as the 0.2.1 client exposes it (components take no required props). */
function primitivesStub() {
  const icon = (name) => {
    const Component = ({ className }) => React.createElement('svg', { 'data-icon': name, className });
    Component.displayName = name;
    return Component;
  };
  return {
    IconFolderOpenRegular: icon('folder-open'),
    IconFolderCloseRegular: icon('folder-close'),
    IconTriangleRightFillRegular: icon('caret'),
  };
}

/** Loads the shipped bundle the way the DSH client loader does, and returns its exports. */
function loadBundle() {
  const source = readFileSync(BUNDLE, 'utf8');
  let definition = null;
  // The bundle runs in the page realm: `window`/`document` come from the globals above, and
  // only `require` is handed in by the loader.
  window.__ModuleLoader__ = { load: (entry) => { definition = entry; } };
  const require = (id) => {
    if (id === 'react') return React;
    if (id === 'react-dom') return global.__reactDom;
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return global.__noIcons ? {} : primitivesStub();
    throw new Error(`unexpected require: ${id}`);
  };
  new Function('require', source)(require);
  assert.ok(definition, 'the bundle registered itself with the module loader');
  const mod = definition.factory(require);
  assert.deepEqual(Object.keys(mod).sort(), ['apply', 'inject'], 'the client half exports apply/inject');
  return mod;
}

/** Runs the plugin's `apply(ctx)` against a fake slot host and returns the mounted component. */
function applyPlugin(mod) {
  const registered = [];
  const ctx = {
    effect: (run) => {
      const dispose = run();
      disposers.push(typeof dispose === 'function' ? dispose : () => {});
      return { dispose: () => {} };
    },
    get: (name) => {
      if (name === 'sessions') return { list: sessionSource, refresh() {} };
      if (name === 'workspaces') return { list: workspaceSource };
      if (name === 'uiWorkspace') {
        return {
          openSession() {},
          startSession() {},
          archiveSession: async (id) => (archiveImpl ? archiveImpl(id) : undefined),
          unarchiveSession: async () => {},
          pinSession: async (id) => (pinImpl ? pinImpl(id) : undefined),
          unpinSession: async () => {},
          pickDirectory: async () => null,
        };
      }
      if (name === 'layout') return { toggleSidebar() {} };
      throw new Error(`no such service: ${name}`);
    },
    slots: {
      inject: (name, factory) => {
        registered.push(factory());
      },
      register: (options, component) => ({ options, component }),
    },
  };
  mod.apply(ctx, {});
  assert.equal(registered.length, 1, 'exactly one slot entry was registered');
  const [entry] = registered;
  assert.equal(entry.options.name, 'shell.overlay');
  return { Component: entry.component, props: entry.options.inject() };
}

async function mount() {
  const mod = loadBundle();
  const { Component, props } = applyPlugin(mod);
  const ReactDOMClient = await import('react-dom/client');
  await act(async () => {
    root = ReactDOMClient.createRoot(container);
    root.render(React.createElement(Component, props));
  });
  await tick();
}

beforeEach(async () => {
  calls = [];
  responseOverrides = {};
  disposers = [];
  slotCalls = [];
  archiveImpl = null;
  pinImpl = null;
  const sessionsFixture = makeSessions(3);
  sessionSource = makeSource(sessionsFixture);
  workspaceSource = makeSource({
    items: [{ workspaceId: WORKSPACE, path: 'D:/work/one', title: 'One', sessionIds: sessionsFixture.ids, createdAt: 1, updatedAt: 1 }],
    archivedSessionIds: [],
    pinnedSessionIds: [],
    phase: 'ready',
    state: 'idle',
  });

  dom = new JSDOM('<!doctype html><html lang="zh-CN"><body></body></html>', { url: 'http://127.0.0.1:8791/', pretendToBeVisual: true });
  window = dom.window;
  document = window.document;
  global.window = window;
  global.document = document;
  // Node 24 exposes `navigator` as a getter-only global; redefine rather than assign.
  Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true, writable: true });
  global.localStorage = window.localStorage;
  global.MutationObserver = window.MutationObserver;
  global.Element = window.Element;
  global.HTMLElement = window.HTMLElement;
  global.Node = window.Node;
  global.Event = window.Event;
  global.KeyboardEvent = window.KeyboardEvent;
  global.getComputedStyle = window.getComputedStyle;
  global.requestAnimationFrame = window.requestAnimationFrame.bind(window);
  global.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
  global.IS_REACT_ACT_ENVIRONMENT = true;
  installFakeLayout();
  installShell();

  React = await import('react');
  global.__reactDom = await import('react-dom');
  act = (await import('react-dom/test-utils')).act;

  global.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url: String(url), method: options.method ?? 'GET', body });
    const handler = responseOverrides[String(url).replace(/^\/api/, '')] ?? (() => ({ ok: true, result: {} }));
    const payload = handler(body);
    return { ok: payload.ok !== false, status: payload.status ?? 200, json: async () => payload };
  };
});

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  root = null;
  // `apply()` registers plugin-scoped effects (styles, language watcher); the loader owns
  // their disposal, so the fake context has to run them or they leak into the next test.
  while (disposers.length) {
    const dispose = disposers.pop();
    await act(async () => dispose());
  }
  dom?.window?.close?.();
});

test('the bundle mounts over the workspace region and inert the native list', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  await mount();
  const overlay = find('.dts-overlay');
  assert.ok(overlay, 'the panel mounted');
  assert.equal(overlay.dataset.reason, 'ok');
  assert.equal(overlay.style.width, '272px', 'it covers the region width');
  assert.equal(overlay.style.top, '200px', 'it starts at the region top');
  assert.equal(document.querySelector('[class*="_regionArea"]').hasAttribute('inert'), true);
  assert.equal(document.querySelector('[class*="_regionArea"]').getAttribute('aria-hidden'), 'true');
  assert.ok(find('.dts-row--topic', '设计'));
  assert.equal(container.querySelectorAll('.dts-row--session').length, 3);
});

test('dragging a session onto a topic files it there', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  await mount();
  const row = find('.dts-row--session', '会话 1');
  const topicRow = find('.dts-row--topic', '设计');

  await act(async () => {
    const start = new window.Event('dragstart', { bubbles: true });
    start.dataTransfer = makeDataTransfer(['ses_1']);
    row.dispatchEvent(start);
  });
  await act(async () => {
    const over = new window.Event('dragover', { bubbles: true, cancelable: true });
    over.dataTransfer = makeDataTransfer(['ses_1']);
    topicRow.dispatchEvent(over);
  });
  assert.ok(topicRow.classList.contains('is-drop-ok'), 'the topic row highlights as a valid target');

  await act(async () => {
    const drop = new window.Event('drop', { bubbles: true, cancelable: true });
    drop.dataTransfer = makeDataTransfer(['ses_1']);
    topicRow.dispatchEvent(drop);
  });
  const assign = calls.find((call) => call.url.endsWith('/assign'));
  assert.ok(assign, 'the drop wrote an assignment');
  assert.deepEqual(assign.body.sessionIds, ['ses_1']);
  assert.equal(assign.body.topicId, TOPIC);
  assert.equal(assign.body.workspaceId, WORKSPACE);
});

test('dropping onto the default group re-files the session there', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  await mount();
  const unfiled = find('.dts-row--topic', '默认分组');
  assert.ok(unfiled, 'the default group renders like any other topic');
  await act(async () => {
    const start = new window.Event('dragstart', { bubbles: true });
    start.dataTransfer = makeDataTransfer(['ses_2']);
    find('.dts-row--session', '会话 2').dispatchEvent(start);
    const drop = new window.Event('drop', { bubbles: true, cancelable: true });
    drop.dataTransfer = makeDataTransfer(['ses_2']);
    unfiled.dispatchEvent(drop);
  });
  const assign = calls.find((call) => call.url.endsWith('/assign'));
  assert.equal(assign.body.topicId, 'tp_default', 'the drop lands in the reserved default group');
});

test('a foreign drop payload writes nothing', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  await mount();
  const topicRow = find('.dts-row--topic', '设计');
  await act(async () => {
    const drop = new window.Event('drop', { bubbles: true, cancelable: true });
    drop.dataTransfer = makeDataTransfer(null, 'C:\\Users\\someone\\Desktop');
    topicRow.dispatchEvent(drop);
  });
  assert.equal(calls.some((call) => call.url.endsWith('/assign')), false, 'no assignment was sent for a non-session drop');
});

test('double-clicking a topic renames it inline', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  responseOverrides[`${API}/topics/update`] = () => ({ ok: true, result: { revision: 5, result: { topic: { id: TOPIC, name: '新名字' } } } });
  await mount();
  await act(async () => {
    find('.dts-row--topic', '设计').dispatchEvent(new window.Event('dblclick', { bubbles: true }));
  });
  const input = find('.dts-input--inline');
  assert.ok(input, 'an inline editor replaced the label');
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '新名字');
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  await act(async () => {
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  const update = calls.find((call) => call.url.endsWith('/topics/update'));
  assert.ok(update, 'the rename reached the host');
  assert.equal(update.body.name, '新名字');
  assert.equal(update.body.topicId, TOPIC);
});

test('a rejected rename keeps the old label and reports the conflict', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  responseOverrides[`${API}/topics/update`] = () => ({ ok: false, error: '该工作区已有同名分组', code: 'topic-name-taken', status: 400 });
  await mount();
  await act(async () => {
    find('.dts-row--topic', '设计').dispatchEvent(new window.Event('dblclick', { bubbles: true }));
  });
  const input = find('.dts-input--inline');
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '设计');
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  await act(async () => {
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  await tick();
  assert.equal(find('.dts-input--inline'), undefined, 'the editor closes even when the host rejects');
  assert.ok(find('.dts-row--topic', '设计'), 'the topic keeps its old name in the tree');
});

test('long buckets render progressively and expand on demand', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  const many = makeSessions(70);
  sessionSource.set(many);
  workspaceSource.set({ ...workspaceSource.getSnapshot(), items: [{ workspaceId: WORKSPACE, path: 'D:/work/one', title: 'One', sessionIds: many.ids, createdAt: 1, updatedAt: 1 }] });
  await mount();
  const unfiledSection = [...container.querySelectorAll('.dts-section--topic')].find((node) => node.querySelector('.dts-row--topic')?.textContent.includes('默认分组'));
  assert.equal(unfiledSection.querySelectorAll('.dts-row--session').length, 60, 'only the first 60 rows of the long bucket mount');
  assert.equal(container.querySelectorAll('.dts-row--session').length, 61, 'plus the one row filed under the topic');
  const button = find('.dts-reveal');
  assert.ok(button, 'a reveal control appears past the limit');
  await act(async () => {
    button.dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  assert.equal(container.querySelectorAll('.dts-row--session').length, 70);
});

test('a session started from a topic is filed into it', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  responseOverrides[`${API}/assign`] = () => ({ ok: true, result: { revision: 6, result: { changed: 1 } } });
  await mount();
  await act(async () => {
    find('.dts-row--topic', '设计').dispatchEvent(new window.Event('contextmenu', { bubbles: true, cancelable: true }));
  });
  await tick();
  const item = [...document.querySelectorAll('.dts-pop--menu .dts-menu__item')].find((node) => node.textContent.includes('在此分组下新建会话'));
  assert.ok(item, 'the topic menu offers a new session');
  await act(async () => {
    item.dispatchEvent(new window.Event('click', { bubbles: true }));
  });

  const before = sessionSource.getSnapshot();
  const created = { id: 'ses_new', displayTitle: '', cwd: 'D:/work/one', updatedAt: Date.now(), blank: true, retainedBy: { mainView: 1 } };
  await act(async () => {
    sessionSource.set({ ...before, ids: [...before.ids, 'ses_new'], byId: { ...before.byId, ses_new: created }, current: 'ses_new' });
  });
  await tick();
  const assign = calls.find((call) => call.url.endsWith('/assign'));
  assert.ok(assign, 'the new session was filed into the topic');
  assert.deepEqual(assign.body.sessionIds, ['ses_new']);
  assert.equal(assign.body.topicId, TOPIC);
});

test('an unrelated session appearing later is not claimed by a pending topic', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  responseOverrides[`${API}/assign`] = () => ({ ok: true, result: { revision: 6, result: { changed: 1 } } });
  await mount();
  await act(async () => {
    find('.dts-row--topic', '设计').dispatchEvent(new window.Event('contextmenu', { bubbles: true, cancelable: true }));
  });
  await tick();
  const item = [...document.querySelectorAll('.dts-pop--menu .dts-menu__item')].find((node) => node.textContent.includes('在此分组下新建会话'));
  await act(async () => {
    item.dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  const before = sessionSource.getSnapshot();
  const opened = { id: 'ses_old2', displayTitle: '既有会话', cwd: 'D:/work/one', updatedAt: Date.now(), blank: false };
  await act(async () => {
    sessionSource.set({ ...before, ids: [...before.ids, 'ses_old2'], byId: { ...before.byId, ses_old2: opened }, current: 'ses_old2' });
  });
  await tick();
  assert.equal(calls.some((call) => call.url.endsWith('/assign')), false, 'a non-blank session is left alone');
});

test('a blank from the stock New Session button lands in the newest topic', async () => {
  responseOverrides[`${API}/state`] = () => {
    const payload = stateResult();
    payload.result.workspaces = {
      [WORKSPACE]: {
        topics: [
          { id: TOPIC, name: '设计', emoji: '\u{1F4A1}', order: 0, createdAt: 100 },
          { id: 'tp_newest', name: '最新分组', emoji: '', order: 1, createdAt: 900 },
        ],
        assignments: { ses_0: TOPIC },
      },
    };
    return payload;
  };
  responseOverrides[`${API}/assign`] = () => ({ ok: true, result: { revision: 6, result: { changed: 1 } } });
  await mount();

  const before = sessionSource.getSnapshot();
  const created = { id: 'ses_fresh', displayTitle: '', cwd: 'D:/work/one', updatedAt: Date.now(), blank: true, retainedBy: { mainView: 1 } };
  await act(async () => {
    sessionSource.set({ ...before, ids: [...before.ids, 'ses_fresh'], byId: { ...before.byId, ses_fresh: created }, current: 'ses_fresh' });
  });
  await tick();

  const assigns = calls.filter((call) => call.url.endsWith('/assign'));
  assert.equal(assigns.length, 1, 'the blank is filed exactly once');
  assert.deepEqual(assigns[0].body.sessionIds, ['ses_fresh']);
  assert.equal(assigns[0].body.workspaceId, WORKSPACE);
  assert.equal(assigns[0].body.topicId, 'tp_newest', 'the most recently created topic wins');
});

test('a blank restored with the first snapshot is not re-filed', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  const base = sessionSource.getSnapshot();
  sessionSource.set({
    ...base,
    ids: [...base.ids, 'ses_restored'],
    byId: { ...base.byId, ses_restored: { id: 'ses_restored', displayTitle: '', cwd: 'D:/work/one', updatedAt: Date.now(), blank: true } },
  });
  const workspace = workspaceSource.getSnapshot();
  workspaceSource.set({ ...workspace, items: [{ ...workspace.items[0], sessionIds: [...base.ids, 'ses_restored'] }] });
  await mount();
  await tick();
  assert.equal(calls.some((call) => call.url.endsWith('/assign')), false, 'an unsaved session from before the mount keeps its place');
});

test('the panel follows the host language through <html lang>', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  await mount();
  assert.equal(find('.dts-header__label').textContent, '工作区');
  await act(async () => {
    document.documentElement.lang = 'en-US';
  });
  await tick(60);
  assert.equal(find('.dts-header__label').textContent, 'Workspaces');
  assert.ok(findAnywhere('.dts-row--topic', '设计'), 'topic names are user data and keep their original text');
});

test('the panel stays hidden when the native region cannot be measured', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  await mount();
  assert.ok(find('.dts-overlay'));
  await act(async () => {
    document.querySelector('[class*="_regionArea"]').classList.add('_9lTDKa_root');
    document.querySelector('.BynINW_frame').setAttribute('data-sidebar-collapsed', '');
  });
  await tick(1200);
  assert.equal(find('.dts-overlay'), undefined, 'the cover steps aside in rail mode');
  assert.equal(document.querySelector('[class*="_regionArea"]').hasAttribute('inert'), false, 'and hands the region back');
});

test('the ＋ menu offers only a session starter and adding a workspace, neither greyed', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  await mount();
  const plus = [...container.querySelectorAll('.dts-header .dts-iconbtn')].find((node) => node.getAttribute('title') === '创建');
  assert.ok(plus, 'the create button exists');
  assert.equal(plus.disabled, false, 'it is never disabled for lack of a workspace selection');
  await act(async () => {
    plus.dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  await tick();
  const items = [...document.querySelectorAll('.dts-pop--create .dts-menu__item')];
  const labels = items.map((node) => node.textContent.trim());
  assert.deepEqual(labels, ['新会话', '添加工作区…']);
  assert.equal(items.every((node) => !node.disabled), true);
});

test('starting a session into a topic from the header files the new blank session', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  responseOverrides[`${API}/assign`] = () => ({ ok: true, result: { revision: 7, result: { changed: 1 } } });
  await mount();
  const plus = [...container.querySelectorAll('.dts-header .dts-iconbtn')].find((node) => node.getAttribute('title') === '创建');
  await act(async () => {
    plus.dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  await tick();
  await act(async () => {
    [...document.querySelectorAll('.dts-pop--create .dts-menu__item')].find((node) => node.textContent.includes('新会话')).dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  await tick();
  const topicStep = [...document.querySelectorAll('.dts-pop--create .dts-menu__item')].map((node) => node.textContent.trim());
  assert.ok(topicStep.some((label) => label.includes('设计')), 'the topic list is offered');
  assert.ok(topicStep.some((label) => label.includes('默认分组')), 'and so is the default group');
  await act(async () => {
    [...document.querySelectorAll('.dts-pop--create .dts-menu__item')].find((node) => node.textContent.includes('设计')).dispatchEvent(new window.Event('click', { bubbles: true }));
  });

  const before = sessionSource.getSnapshot();
  const created = { id: 'ses_from_header', displayTitle: '', cwd: 'D:/work/one', updatedAt: Date.now(), blank: true, retainedBy: { mainView: 1 } };
  await act(async () => {
    sessionSource.set({ ...before, ids: [...before.ids, 'ses_from_header'], byId: { ...before.byId, ses_from_header: created }, current: 'ses_from_header' });
  });
  await tick();
  const assign = calls.find((call) => call.url.endsWith('/assign'));
  assert.deepEqual(assign.body.sessionIds, ['ses_from_header']);
  assert.equal(assign.body.topicId, TOPIC);
});

test('choosing 默认分组 from the header files the blank into the default group', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  responseOverrides[`${API}/assign`] = () => ({ ok: true, result: { revision: 7, result: { changed: 1 } } });
  await mount();
  const plus = [...container.querySelectorAll('.dts-header .dts-iconbtn')].find((node) => node.getAttribute('title') === '创建');
  await act(async () => {
    plus.dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  await tick();
  await act(async () => {
    [...document.querySelectorAll('.dts-pop--create .dts-menu__item')].find((node) => node.textContent.includes('新会话')).dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  await tick();
  await act(async () => {
    [...document.querySelectorAll('.dts-pop--create .dts-menu__item')].find((node) => node.textContent.includes('默认分组')).dispatchEvent(new window.Event('click', { bubbles: true }));
  });

  const before = sessionSource.getSnapshot();
  const created = { id: 'ses_default', displayTitle: '', cwd: 'D:/work/one', updatedAt: Date.now(), blank: true, retainedBy: { mainView: 1 } };
  await act(async () => {
    sessionSource.set({ ...before, ids: [...before.ids, 'ses_default'], byId: { ...before.byId, ses_default: created }, current: 'ses_default' });
  });
  await tick();
  const assign = calls.find((call) => call.url.endsWith('/assign'));
  assert.ok(assign, 'the explicit default choice is honoured');
  assert.equal(assign.body.topicId, 'tp_default');
});

test('the default group renders as a system topic row', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  await mount();
  const row = find('.dts-row--topic', '默认分组');
  assert.ok(row, 'the default group is listed');
  assert.equal(row.className.includes('is-bucket'), false, 'it is a topic row, not a trailing bucket');
  assert.ok(row.querySelector('.dts-dash'), 'and carries the no-marker dash');
});

test('choosing a workspace in the create menu continues into the topic step', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  const extra = { workspaceId: 'ws_two', path: 'D:/work/two', title: 'Two', sessionIds: [], createdAt: 2, updatedAt: 2 };
  workspaceSource.set({ ...workspaceSource.getSnapshot(), items: [...workspaceSource.getSnapshot().items, extra] });
  await mount();
  const plus = [...container.querySelectorAll('.dts-header .dts-iconbtn')].find((node) => node.getAttribute('title') === '创建');
  await act(async () => {
    plus.dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  await tick();
  await act(async () => {
    [...document.querySelectorAll('.dts-pop--create .dts-menu__item')].find((node) => node.textContent.includes('新会话')).dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  await tick();
  let labels = [...document.querySelectorAll('.dts-pop--create .dts-menu__item')].map((node) => node.textContent.trim());
  assert.ok(labels.some((label) => label.startsWith('Two')), 'the workspace chooser appears because two workspaces are ambiguous');
  await act(async () => {
    [...document.querySelectorAll('.dts-pop--create .dts-menu__item')].find((node) => node.textContent.trim().startsWith('One')).dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  await tick();
  labels = [...document.querySelectorAll('.dts-pop--create .dts-menu__item')].map((node) => node.textContent.trim());
  assert.ok(labels.some((label) => label.includes('设计')), 'and picking a workspace lands on the topic list');
  assert.ok(labels.some((label) => label.includes('默认分组')));
});

test('unselected workspaces carry no background and only the current one tints its folder', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  const extra = { workspaceId: 'ws_two', path: 'D:/work/two', title: 'Two', sessionIds: ['ses_two'], createdAt: 2, updatedAt: 2 };
  const base = sessionSource.getSnapshot();
  workspaceSource.set({ ...workspaceSource.getSnapshot(), items: [...workspaceSource.getSnapshot().items, extra] });
  sessionSource.set({ ...base, ids: [...base.ids, 'ses_two'], byId: { ...base.byId, ses_two: { id: 'ses_two', displayTitle: 'Two 会话', cwd: 'D:/work/two', updatedAt: Date.now() } } });
  await mount();
  const groups = [...container.querySelectorAll('.dts-row--group')];
  assert.equal(groups.length, 2);
  const active = groups.filter((node) => getComputedStyle(node).backgroundColor !== 'rgba(0, 0, 0, 0)' && node.className.includes('is-active'));
  assert.equal(active.length, 0, 'no group row is background-highlighted');
  const tinted = [...container.querySelectorAll('.dts-folder.is-active')];
  assert.equal(tinted.length, 1, 'exactly one folder is tinted');
  assert.ok(groups[0].contains(tinted[0]), 'it is the workspace that owns the current session');
});

test('workspace rows use the native folder icons and swap to the caret on hover', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  await mount();
  const group = find('.dts-row--group');
  const folder = group.querySelector('.dts-folder svg');
  assert.ok(folder, 'a folder icon renders in the row slot');
  assert.equal(folder.getAttribute('data-icon'), 'folder-open', 'expanded workspaces show the open folder');
  assert.ok(group.querySelector('.dts-caret svg'), 'and a caret exists for the hover swap');
  const collapsed = find('.dts-row--group');
  await act(async () => {
    collapsed.dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  await tick();
  assert.equal(find('.dts-row--group .dts-folder svg').getAttribute('data-icon'), 'folder-close');
  assert.equal((find('.dts-row--group .dts-caret svg').getAttribute('class') ?? '').includes('is-open'), false, 'the caret stops rotating once collapsed');
});

test('a host build without the icon exports still renders via local fallbacks', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  const original = global.__noIcons;
  global.__noIcons = true;
  try {
    await mount();
    assert.ok(find('.dts-row--group'), 'the tree still mounts');
    assert.ok(find('.dts-row--group .dts-folder svg'), 'a fallback glyph is drawn');
  } finally {
    global.__noIcons = original;
  }
});

test('topics show their emoji and the default bucket shows a dash', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  await mount();
  const topicRow = find('.dts-row--topic', '设计');
  const mark = topicRow.querySelector('.dts-emoji');
  assert.ok(mark, 'the topic renders its emoji');
  assert.equal(mark.textContent, '\u{1F4A1}');
  assert.equal(topicRow.querySelector('.dts-dash'), null);

  const bucket = find('.dts-row--topic', '默认分组');
  assert.ok(bucket.querySelector('.dts-dash'), 'the default group carries a plain dash');
  assert.equal(bucket.querySelector('.dts-emoji'), null);
});

test('the create dialog picks the workspace from a dropdown', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  const extra = { workspaceId: 'ws_two', path: 'D:/work/two', title: 'Two', sessionIds: [], createdAt: 2, updatedAt: 2 };
  workspaceSource.set({ ...workspaceSource.getSnapshot(), items: [...workspaceSource.getSnapshot().items, extra] });
  await mount();
  await act(async () => {
    find('.dts-row--group .dts-row__actions .dts-iconbtn').dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  await tick();
  const select = document.querySelector('.dts-dialog--settings .dts-select select');
  assert.ok(select, 'a dropdown replaces the segmented switch');
  assert.equal(select.querySelectorAll('option').length, 2, 'one option per workspace');
  assert.equal(select.selectedOptions[0]?.value, WORKSPACE, 'opening from a workspace row preselects it');
});

test('the attach picker hides the provisional New Session', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  const base = sessionSource.getSnapshot();
  sessionSource.set({
    ...base,
    ids: [...base.ids, 'ses_blank'],
    byId: { ...base.byId, ses_blank: { id: 'ses_blank', displayTitle: '', cwd: 'D:/work/one', updatedAt: Date.now(), blank: true, retainedBy: { mainView: 1 } } },
  });
  const workspace = workspaceSource.getSnapshot();
  workspaceSource.set({ ...workspace, items: [{ ...workspace.items[0], sessionIds: [...base.ids, 'ses_blank'] }] });
  await mount();
  await act(async () => {
    find('.dts-row--group .dts-row__actions .dts-iconbtn').dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  await tick();
  const picker = document.querySelector('.dts-picker');
  assert.ok(picker, 'the attach picker renders');
  const titles = [...picker.querySelectorAll('.dts-picker__title')].map((node) => node.textContent.trim());
  assert.equal(titles.includes('新会话'), false, 'the blank row is not attachable');
  assert.equal(titles.includes('会话 1'), true, 'ordinary sessions stay attachable');
});

test('the batch bar greys out actions that conflict with the selection', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  window.localStorage.setItem('dsh-better-workspace:prefs:v1', JSON.stringify({ showArchived: true }));
  const base = sessionSource.getSnapshot();
  sessionSource.set({
    ...base,
    ids: [...base.ids, 'ses_arch2'],
    byId: { ...base.byId, ses_arch2: { id: 'ses_arch2', displayTitle: '归档项2', cwd: 'D:/work/one', updatedAt: Date.now() } },
  });
  workspaceSource.set({ ...workspaceSource.getSnapshot(), archivedSessionIds: ['ses_arch2'] });
  await mount();
  const headerButton = (title) => [...container.querySelectorAll('.dts-header .dts-iconbtn')].find((node) => node.getAttribute('title') === title);
  await act(async () => {
    headerButton('批量选择').dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  await tick();
  const toggle = (title) => {
    const row = find('.dts-row--session', title);
    row.querySelector('.dts-check input').dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  };
  await act(async () => {
    toggle('会话 1');
    toggle('归档项2');
  });
  await tick();
  const buttonByLabel = (label) => [...container.querySelectorAll('.dts-batchbar .dts-btn')].find((node) => node.textContent.trim() === label);
  assert.equal(buttonByLabel('归档').disabled, true, 'an archived row in the selection blocks 归档');
  assert.equal(buttonByLabel('取消归档').disabled, true, 'an unarchived row in the selection blocks 取消归档');
  assert.equal(buttonByLabel('移动到分组').disabled, true, 'archived rows cannot be re-filed');
  assert.equal(buttonByLabel('永久删除').disabled, false, 'deleting stays available for both kinds');
  await act(async () => {
    toggle('归档项2');
  });
  await tick();
  assert.equal(buttonByLabel('归档').disabled, false, 'unarchived-only selection can archive');
  assert.equal(buttonByLabel('取消归档').disabled, true, 'and still cannot unarchive');
  assert.equal(buttonByLabel('移动到分组').disabled, false);
});

test('exiting selection mode clears the selection', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  await mount();
  const headerButton = (title) => [...container.querySelectorAll('.dts-header .dts-iconbtn')].find((node) => node.getAttribute('title') === title);
  await act(async () => {
    headerButton('批量选择').dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  await tick();
  await act(async () => {
    const row = find('.dts-row--session', '会话 1');
    row.querySelector('.dts-check input').dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  });
  await tick();
  assert.ok(container.querySelector('.dts-row--session.is-selected'), 'the row highlights while selected');
  await act(async () => {
    headerButton('退出选择').dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  await tick();
  assert.equal(container.querySelector('.dts-row--session.is-selected'), null, 'no stale highlight survives the exit');
  assert.equal(container.querySelector('.dts-batchbar'), null);
});

test('an empty topic name explains itself once the field is touched', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  await mount();
  await act(async () => {
    find('.dts-row--group .dts-row__actions .dts-iconbtn').dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  await tick();
  const input = document.querySelector('.dts-dialog .dts-input');
  assert.equal(document.querySelector('.dts-dialog .dts-field__hint.is-error'), null, 'an untouched field stays quiet');
  await act(async () => {
    input.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true }));
  });
  await tick();
  const hint = document.querySelector('.dts-dialog .dts-field__hint.is-error');
  assert.ok(hint, 'the touched empty field explains what is missing');
  assert.equal(hint.textContent, '请填写分组名称');
  assert.equal(input.getAttribute('aria-invalid'), 'true');
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '有名字了');
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  await tick();
  assert.equal(document.querySelector('.dts-dialog .dts-field__hint.is-error'), null, 'typing clears the hint');
});

test('the create dialog offers the host emoji list and submits the chosen glyph', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  responseOverrides[`${API}/topics/create`] = () => ({ ok: true, result: { revision: 9, result: { topic: { id: 'tp_new', name: 'x' } } } });
  await mount();
  const addTopic = find('.dts-row--group .dts-row__actions .dts-iconbtn');
  assert.ok(addTopic, 'the workspace row carries a topic button');
  await act(async () => {
    addTopic.dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  await tick();
  const dialog = document.querySelector('.dts-dialog');
  assert.ok(dialog.classList.contains('dts-dialog--settings'), 'the create dialog uses the settings shell');
  assert.ok(dialog.querySelector('.dts-dialog__description'), 'with a settings-style introduction');
  assert.ok(dialog.textContent.includes('工作区'), 'and names the workspace field');
  const swatches = [...document.querySelectorAll('.dts-emojis__item')];
  assert.equal(swatches.length, 5, 'four host glyphs plus the no-marker option');
  assert.ok(swatches[0].querySelector('.dts-dash'), 'the first choice clears the marker');
  await act(async () => {
    swatches[3].dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  const input = document.querySelector('.dts-dialog .dts-input');
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '图标测试');
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  await act(async () => {
    [...document.querySelectorAll('.dts-dialog .dts-btn')].find((node) => node.textContent.trim() === '创建').dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  await tick();
  const create = calls.find((call) => call.url.endsWith('/topics/create'));
  assert.ok(create, 'the create request reached the host');
  assert.equal(create.body.name, '图标测试');
  assert.equal(create.body.emoji, '\u{1F3A8}', 'the third glyph was submitted');
});

test('the row menu offers the commands the panel can carry out itself', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  await mount();
  const row = find('.dts-row--session', '会话 0');
  await act(async () => {
    row.querySelector('.dts-row__act').dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  await tick();
  const menu = document.querySelector('.dts-pop--menu');
  assert.ok(menu, 'the popover opened');
  const labels = [...menu.querySelectorAll('.dts-menu__item')].map((node) => node.querySelector('.dts-menu__label').textContent.trim());
  assert.deepEqual(labels, ['置顶会话', '重命名', '分叉会话', '归档会话', '复制 Session ID', '移动到分组…', '永久删除'], labels.join('|'));
  const hints = [...menu.querySelectorAll('.dts-menu__hint')].map((node) => node.textContent.trim());
  assert.equal(hints.length, 3, 'rename / fork / archive carry the stock shortcut hints');
  assert.equal(slotCalls.length, 0, 'the panel never renders another package\'s slots');
});

test('rows render the native hover actions and follow the native drag rule', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  const base = sessionSource.getSnapshot();
  sessionSource.set({
    ...base,
    current: 'ses_blank',
    ids: [...base.ids, 'ses_blank', 'ses_archived'],
    byId: {
      ...base.byId,
      ses_blank: { id: 'ses_blank', displayTitle: '', cwd: 'D:/work/one', updatedAt: Date.now(), blank: true, retainedBy: { mainView: 1 } },
      ses_archived: { id: 'ses_archived', displayTitle: '归档项', cwd: 'D:/work/one', updatedAt: Date.now() },
    },
  });
  workspaceSource.set({ ...workspaceSource.getSnapshot(), archivedSessionIds: ['ses_archived'], items: [{ ...workspaceSource.getSnapshot().items[0], sessionIds: [...base.ids, 'ses_blank', 'ses_archived'] }] });
  await mount();
  const normal = find('.dts-row--session', '会话 1');
  assert.equal(normal.getAttribute('draggable'), 'true');
  assert.equal(normal.querySelectorAll('.dts-row__act').length, 3, 'ordinary rows keep the stock hover strip');
  const blank = find('.dts-row--session', '新会话');
  assert.ok(blank, 'the current blank session renders');
  assert.notEqual(blank.getAttribute('draggable'), 'true', 'a blank session is not draggable, like the native list');
  assert.equal(blank.querySelector('.dts-row__actions'), null, 'a blank row carries no menu/archive/pin strip');
  assert.equal(blank.querySelector('.dts-row__time'), null, 'a blank row carries no timestamp');
  await act(async () => {
    blank.dispatchEvent(new window.Event('dblclick', { bubbles: true }));
  });
  await tick();
  assert.equal(document.querySelector('.dts-dialog'), null, 'double-click does not offer to rename a blank row');
  await act(async () => {
    blank.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  });
  await tick();
  assert.equal(document.querySelector('.dts-pop--menu'), null, 'right-click opens no session menu on a blank row');
  const archived = find('.dts-row--session', '归档项');
  assert.equal(archived, undefined, 'archived rows stay hidden until 显示已归档 is on');
});

test('pin from the row strip moves the session to the top of its bucket', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  // The host answers with the complete pin set, most recently pinned first; the panel must
  // re-derive the tree from that snapshot instead of waiting for a manual refresh.
  pinImpl = (id) => {
    const snapshot = workspaceSource.getSnapshot();
    workspaceSource.set({ ...snapshot, pinnedSessionIds: [id, ...snapshot.pinnedSessionIds.filter((entry) => entry !== id)] });
  };
  await mount();
  const defaultSection = () => [...document.querySelectorAll('.dts-section--topic')]
    .find((node) => node.querySelector('.dts-row--topic')?.textContent.includes('默认分组'));
  const bucketIds = () => [...defaultSection().querySelectorAll('.dts-row--session')]
    .map((row) => row.querySelector('.dts-row__text')?.textContent);
  assert.deepEqual(bucketIds(), ['会话 1', '会话 2']);

  const target = find('.dts-row--session', '会话 2');
  const pinButton = target.querySelectorAll('.dts-row__act')[2];
  assert.equal(pinButton.getAttribute('title'), '置顶会话');
  await act(async () => {
    pinButton.dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  await tick();

  assert.deepEqual(bucketIds(), ['会话 2', '会话 1'], 'the pinned row leads its bucket');
  const pinnedRow = find('.dts-row--session', '会话 2');
  assert.ok(pinnedRow.querySelector('.dts-row__pin'), 'the pinned marker is rendered');
  assert.equal(pinnedRow.querySelectorAll('.dts-row__act')[2].getAttribute('title'), '取消置顶');
});

test('the menu works without any host-provided slot renderer', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  const mod = loadBundle();
  const { Component, props } = applyPlugin(mod);
  const ReactDOMClient = await import('react-dom/client');
  await act(async () => {
    root = ReactDOMClient.createRoot(container);
    root.render(React.createElement(Component, props));
  });
  await tick();
  const row = find('.dts-row--session', '会话 0');
  await act(async () => {
    row.querySelector('.dts-row__act').dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  await tick();
  const labels = [...document.querySelectorAll('.dts-pop--menu .dts-menu__item')].map((node) => node.querySelector('.dts-menu__label').textContent.trim());
  assert.deepEqual(labels, ['置顶会话', '重命名', '分叉会话', '归档会话', '复制 Session ID', '移动到分组…', '永久删除']);
});

test('the registration only injects slots and declares no foreign seats', async () => {
  // Declaring a seat another package already owns makes the 0.2.1 slot registry throw
  // ("slot ... is already declared"), which takes the whole web boot down with it. The
  // entry must therefore stay a plain list registration.
  responseOverrides[`${API}/state`] = stateResult;
  const mod = loadBundle();
  assert.deepEqual(mod.inject, ['slots'], 'only the slots service is injected');
  let options = null;
  const ctx = {
    effect: (run) => {
      run();
      return { dispose: () => {} };
    },
    get: () => {
      throw new Error('not needed');
    },
    slots: {
      inject: (name, factory) => {
        const entry = factory();
        options = entry.options;
      },
      register: (opts, component) => ({ options: opts, component }),
    },
  };
  mod.apply(ctx, {});
  assert.equal(options.name, 'shell.overlay', 'it registers in the overlay layer');
  assert.equal(options.children, undefined, 'it declares no child seats');
  assert.equal(typeof options.inject, 'function', 'and injects the host actions');
});

test('double-clicking a session row opens the rename dialog', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  await mount();
  const row = find('.dts-row--session', '会话 1');
  await act(async () => {
    row.dispatchEvent(new window.Event('dblclick', { bubbles: true }));
  });
  await tick();
  const dialog = document.querySelector('.dts-dialog');
  assert.ok(dialog, 'the rename dialog opened');
  assert.equal(dialog.querySelector('.dts-dialog__title').textContent, '重命名会话');
  assert.equal(dialog.querySelector('.dts-input').value, '会话 1');
});

test('the composer topic chip shows the open session topic and re-files it', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  responseOverrides[`${API}/assign`] = () => ({ ok: true, result: { revision: 6, result: { changed: 1 } } });
  await mount();
  const chip = findAnywhere('.dts-composer-topic');
  assert.ok(chip, 'the chip sits inside the composer row');
  assert.match(chip.textContent, /设计/, 'and starts on the topic the open session already belongs to');
  await act(async () => {
    chip.dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  await tick();
  const item = [...document.querySelectorAll('.dts-pop--composer .dts-menu__item')].find((node) => node.textContent.includes('默认分组'));
  assert.ok(item, 'the default group is offered');
  await act(async () => {
    item.dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  await tick();
  const assign = calls.find((call) => call.url.endsWith('/assign'));
  assert.deepEqual(assign.body.sessionIds, ['ses_0'], 'the open session is the one re-filed');
  assert.equal(assign.body.topicId, 'tp_default', 'picking the default group files into it');
});

test('an archived row keeps the stock menu and only adds permanent delete', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  const base = sessionSource.getSnapshot();
  sessionSource.set({
    ...base,
    ids: [...base.ids, 'ses_arch'],
    byId: { ...base.byId, ses_arch: { id: 'ses_arch', displayTitle: '归档项', cwd: 'D:/work/one', updatedAt: Date.now() } },
  });
  workspaceSource.set({
    ...workspaceSource.getSnapshot(),
    archivedSessionIds: ['ses_arch'],
    items: [{ ...workspaceSource.getSnapshot().items[0], sessionIds: [...base.ids, 'ses_arch'] }],
  });
  window.localStorage.setItem('dsh-better-workspace:prefs:v1', JSON.stringify({ showArchived: true }));
  await mount();
  const row = find('.dts-section--archived .dts-row--session', '归档项');
  assert.ok(row, 'the archived bucket is visible');
  await act(async () => {
    row.querySelector('.dts-row__act').dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  await tick();
  const labels = [...document.querySelectorAll('.dts-pop--menu .dts-menu__item')].map((node) => node.querySelector('.dts-menu__label').textContent.trim());
  assert.deepEqual(labels, ['重命名', '分叉会话', '取消归档', '复制 Session ID', '永久删除'], labels.join('|'));
});

test('the batch result dialog names the sessions that are still running', async () => {
  // Archiving a live session is rejected by the host with a *code* that carries no title.
  // The dialog must still show which session needs stopping, not a blank row.
  responseOverrides[`${API}/state`] = stateResult;
  archiveImpl = async () => {
    throw Object.assign(new Error('WorkspaceActiveSessionError: session is active'), { code: 'WorkspaceActiveSessionError' });
  };
  await mount();
  const row = find('.dts-row--session', '会话 0');
  await act(async () => {
    row.querySelector('.dts-row__act').dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  await tick();
  await act(async () => {
    [...document.querySelectorAll('.dts-pop--menu .dts-menu__item')]
      .find((node) => node.textContent.includes('归档会话'))
      .dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  await tick();
  const dialog = findAnywhere('.dts-dialog');
  assert.ok(dialog, 'the result dialog opens when the only outcome is "needs a stop"');
  const entries = [...dialog.querySelectorAll('.dts-result__item')].map((node) => node.textContent.trim());
  assert.equal(entries.length, 1);
  assert.ok(entries[0].includes('会话 0'), `the row keeps the session title, got: ${JSON.stringify(entries[0])}`);
  assert.ok(dialog.textContent.includes('停止并归档'), 'the stop proposal is offered');
});
