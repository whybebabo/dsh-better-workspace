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

/**
 * Routes a test does not care about still have to answer: the picker glyphs moved off `/state`
 * onto their own cached route, so without this the create/edit dialogs would render only the
 * "no marker" swatch.
 */
const DEFAULT_RESPONSES = {
  [`${API}/emojis`]: () => ({ ok: true, result: { emojis: ['\u{1F4C1}', '\u{1F4A1}', '\u{1F3A8}', '\u{1F680}'] } }),
};

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
let sessionStatusSource;
let workspaceSource;
let disposers;
let slotCalls;
/** Per-test override for `archiveSession`, so the "needs a stop" path can be exercised. */
let archiveImpl;
let startSessionImpl;
let startSessionCalls = 0;
let startSessionArgs = [];
let openSessionCalls = 0;
let toggleSidebarCalls = 0;
let workspaceRenameCalls = [];
/** `sessions.using` calls: `[sessionId, source]`, and the titles the host rename stub received. */
let sessionRenameCalls = [];
let sessionRenameTitles = [];
let workspaceDeleteCalls = [];
let workspaceCreateCalls = [];
let pickDirectoryCalls = 0;
let sessionRefreshCalls = 0;
/** Per-test override for `pinSession`, so a click can move the host's pin set. */
let pinImpl;
/** Global scheduled-task catalog the fake Remote face answers with. */
let scheduleCatalog;
let scheduleReaders;
/** Live `schedule/changed` listeners; the schedule store releases them while paused. */
let scheduleSubscribers;

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
    /** Live subscriber count — the only way to observe a suspended `useSnapshot`. */
    listenerCount: () => listeners.size,
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

/** Topic creation now lives in the workspace menu; the row's hover plus starts a session. */
async function openTopicCreateDialog() {
  const menu = find('.dts-row--group').querySelector('.dts-row__actions .dts-iconbtn[aria-label="更多操作"]');
  await act(async () => {
    menu.dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  await tick();
  await act(async () => {
    [...document.querySelectorAll('.dts-pop--menu .dts-menu__item')]
      .find((node) => node.textContent.trim() === '新建分组')
      .dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  await tick();
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
    IconNewChatOutlineRegular: icon('new-chat'),
    StateDot: ({ state }) => React.createElement('span', { 'data-state': state, className: 'host-state-mark' }),
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
      if (name === 'sessions') {
        return {
          list: sessionSource,
          refresh() { sessionRefreshCalls += 1; },
          /**
           * The host's own rename path (`ui-workspace/src/client/index.ts`):
           * `sessions.using(id, {source:'workspaceOperation'}, ref => ref.binding.session.rename(title))`.
           * `uiWorkspace.renameSession` deliberately does not exist on this fake, exactly like 0.2.1.
           */
          async using(sessionId, options, run) {
            sessionRenameCalls.push([sessionId, options?.source]);
            return run({
              binding: {
                session: {
                  async rename(title) {
                    sessionRenameTitles.push(title);
                    return { ok: true, value: { title } };
                  },
                },
              },
            });
          },
        };
      }
      if (name === 'uiSession') return { sessionStatus: sessionStatusSource };
      if (name === 'workspaces') {
        return {
          list: workspaceSource,
          async rename(workspaceId, title) {
            workspaceRenameCalls.push([workspaceId, title]);
          },
          async delete(workspaceId) {
            workspaceDeleteCalls.push(workspaceId);
          },
          async create(input) {
            workspaceCreateCalls.push(input);
          },
        };
      }
      if (name === 'uiWorkspace') {
        return {
          openSession() { openSessionCalls += 1; },
          startSession(workspaceId) {
            startSessionCalls += 1;
            startSessionArgs.push(workspaceId);
            return startSessionImpl ? startSessionImpl(workspaceId) : undefined;
          },
          archiveSession: async (id) => (archiveImpl ? archiveImpl(id) : undefined),
          unarchiveSession: async () => {},
          pinSession: async (id) => (pinImpl ? pinImpl(id) : undefined),
          unpinSession: async () => {},
          pickDirectory: async () => {
            pickDirectoryCalls += 1;
            return null;
          },
        };
      }
      if (name === 'layout') return { toggleSidebar() { toggleSidebarCalls += 1; } };
      if (name === 'remote.schedule') {
        // The namespace is its own Cordis service, exactly as the Client assembly mounts it.
        return {
          async catalog() {
            scheduleReaders += 1;
            return { ok: true, value: scheduleCatalog };
          },
        };
      }
      if (name === 'remote') {
        return {
          // The facade carries forwarded events only. Reaching for a namespace as a property
          // is a bug: Cordis throws `cannot get property "remote.schedule" without inject`.
          get schedule() {
            throw new Error('cannot get property "remote.schedule" without inject');
          },
          // The schedule plugin subscribes to this invalidation; tracked live so a test can see
          // the store release it while the panel is hidden.
          $on: (event, listener) => {
            scheduleSubscribers.add(listener);
            return () => scheduleSubscribers.delete(listener);
          },
        };
      }
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
  startSessionImpl = null;
  startSessionCalls = 0;
  startSessionArgs = [];
  openSessionCalls = 0;
  toggleSidebarCalls = 0;
  workspaceRenameCalls = [];
  sessionRenameCalls = [];
  sessionRenameTitles = [];
  workspaceDeleteCalls = [];
  workspaceCreateCalls = [];
  pickDirectoryCalls = 0;
  delete globalThis.__DSH_DIRECTORY_PICKER__;
  sessionRefreshCalls = 0;
  scheduleCatalog = [];
  scheduleReaders = 0;
  scheduleSubscribers = new Set();
  const sessionsFixture = makeSessions(3);
  sessionSource = makeSource(sessionsFixture);
  sessionStatusSource = makeSource(new Map());
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
    const handler = responseOverrides[String(url).replace(/^\/api/, '')] ?? DEFAULT_RESPONSES[String(url)] ?? (() => ({ ok: true, result: {} }));
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

test('a native dialog rendered inside the covered region hands the region back until it closes', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  await mount();
  const region = document.querySelector('[class*="_regionArea"]');
  assert.equal(region.hasAttribute('data-dts-covered'), true, 'the panel marks the region it owns');

  const modal = document.createElement('div');
  modal.setAttribute('aria-modal', 'true');
  await act(async () => {
    region.querySelector('[role="tree"]').append(modal);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.equal(region.hasAttribute('inert'), false, 'the native dialog can be typed into');
  assert.equal(region.getAttribute('aria-hidden'), null, 'and is exposed to assistive tech');
  assert.equal(region.hasAttribute('data-dts-covered'), false, 'the stylesheet stops hiding it');

  await act(async () => {
    modal.remove();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.equal(region.hasAttribute('inert'), true, 'closing the dialog restores the inert cover');
  assert.equal(region.getAttribute('aria-hidden'), 'true');
  assert.equal(region.hasAttribute('data-dts-covered'), true);
});

test('macOS desktop keeps the sidebar gradient and hides the native region instead of repainting it', async () => {
  document.documentElement.dataset.platform = 'darwin';
  let region;
  try {
    responseOverrides[`${API}/state`] = stateResult;
    await mount();
    const overlay = find('.dts-overlay');
    region = document.querySelector('[class*="_regionArea"]');
    assert.equal(getComputedStyle(overlay).backgroundColor, 'rgba(0, 0, 0, 0)', 'the cover does not paint the sidebar fill over the vibrancy');
    assert.equal(getComputedStyle(region).opacity, '0', 'the native region is hidden behind the clear cover');
  } finally {
    delete document.documentElement.dataset.platform;
  }
  assert.equal(getComputedStyle(region).opacity, '1', 'the hiding is scoped to the macOS shell');
});

test('scheduled sessions keep the stock clock mark and hover task block', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  scheduleCatalog = [{
    id: 'sch_one',
    sessionId: 'ses_0',
    status: 'active',
    kind: 'daily',
    title: '每天早上发送问候',
    prompt: '问候',
    time: '09:00:00.000',
    timeZone: 'Asia/Shanghai',
    scheduledAt: new Date(Date.now() + 21 * 3_600_000).toISOString(),
  }];
  await mount();
  await tick();

  assert.equal(scheduleReaders, 1, 'one catalog read serves every row');
  const marked = find('.dts-row--session', '会话 0');
  const mark = marked.querySelector('.dts-row__schedule');
  assert.ok(mark, 'the idle row shows the clock in its leading cell');
  assert.equal(mark.getAttribute('aria-label'), '1 个自动化任务');
  assert.equal(find('.dts-row--session', '会话 1').querySelector('.dts-row__schedule'), null, 'only the task session is marked');

  await act(async () => {
    marked.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true, view: window }));
  });
  await tick(520);

  const tip = findAnywhere('.dts-tip');
  assert.ok(tip, 'the hover card opened');
  assert.equal(tip.querySelectorAll('.dts-tip__task').length, 1);
  assert.match(tip.textContent, /每天早上发送问候/);
  assert.match(tip.textContent, /每天 09:00（UTC\+08:00/, 'the rule keeps the host frequency copy');
  assert.match(tip.textContent, /\(21小时后\)|\(20小时后\)/, 'the distance sits in parentheses like the stock card');
});

test('a running session keeps its status dot and the hover block still lists the task', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  sessionStatusSource.set(new Map([['ses_0', { running: true }]]));
  scheduleCatalog = [{
    id: 'sch_one',
    sessionId: 'ses_0',
    status: 'active',
    kind: 'every',
    title: '构建巡检',
    everySeconds: 3_600,
    scheduledAt: new Date(Date.now() + 30 * 60_000).toISOString(),
  }];
  await mount();
  await tick();

  const row = find('.dts-row--session', '会话 0');
  assert.equal(row.querySelector('.dts-row__schedule'), null, 'live work keeps the leading cell');
  assert.ok(row.querySelector('[data-state="ongoing"]'), 'the status dot wins the cell');

  await act(async () => {
    row.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true, view: window }));
  });
  await tick(520);
  const tip = findAnywhere('.dts-tip');
  assert.match(tip.textContent, /构建巡检/);
  assert.match(tip.textContent, /1小时一次/);
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
  const plus = find('.dts-row--topic', '设计').querySelector('.dts-row__actions .dts-iconbtn[title="在此分组下新建会话"]');
  assert.ok(plus, 'the topic row offers a direct new-session button');
  assert.equal(plus.getAttribute('aria-label'), '在「设计」下新建会话');
  assert.equal(plus.querySelector('svg').getAttribute('data-icon'), 'new-chat', 'it uses the native new-session glyph');
  await act(async () => {
    plus.dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  await tick();
  assert.deepEqual(startSessionArgs, [WORKSPACE], 'the button starts the session in the topic workspace');
  assert.equal(find('.dts-row--topic', '设计').className.includes('is-collapsed'), false, 'and leaves the row expanded');

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
    find('.dts-row--topic', '设计').querySelector('.dts-row__actions .dts-iconbtn[title="在此分组下新建会话"]').dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  const before = sessionSource.getSnapshot();
  const opened = { id: 'ses_old2', displayTitle: '既有会话', cwd: 'D:/work/one', updatedAt: Date.now(), blank: false };
  await act(async () => {
    sessionSource.set({ ...before, ids: [...before.ids, 'ses_old2'], byId: { ...before.byId, ses_old2: opened }, current: 'ses_old2' });
  });
  await tick();
  assert.equal(calls.some((call) => call.url.endsWith('/assign')), false, 'a non-blank session is left alone');
});

test('a blank from the stock New Session button stays un-filed, which puts it first', async () => {
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

  assert.equal(
    calls.some((call) => call.url.endsWith('/assign')),
    false,
    'an implicit new session is not filed into a topic the user was not looking at',
  );
  const buckets = [...container.querySelectorAll('.dts-row--topic')].map((node) => node.querySelector('.dts-row__text')?.textContent);
  assert.deepEqual(buckets, ['默认分组', '设计', '最新分组'], 'and the newest group stays last, where a file would have hidden the row');
  const firstSection = container.querySelector('.dts-collapse');
  assert.ok(firstSection.querySelector('.dts-row--session').textContent.includes('新会话'), 'the blank leads the first bucket');
});

test('a blank created while a topic filter is active joins that topic', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  responseOverrides[`${API}/assign`] = () => ({ ok: true, result: { revision: 6, result: { changed: 1 } } });
  await mount();

  // "Only this topic" — the filter lives in prefs, so drive it through the topic row menu.
  await act(async () => {
    find('.dts-row--topic', '设计').dispatchEvent(new window.Event('contextmenu', { bubbles: true, cancelable: true }));
  });
  await tick();
  await act(async () => {
    [...document.querySelectorAll('.dts-pop--menu .dts-menu__item')]
      .find((node) => node.textContent.includes('只看此分组'))
      .dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  await tick();

  const before = sessionSource.getSnapshot();
  const created = { id: 'ses_filtered', displayTitle: '', cwd: 'D:/work/one', updatedAt: Date.now(), blank: true, retainedBy: { mainView: 1 } };
  await act(async () => {
    sessionSource.set({ ...before, ids: [...before.ids, 'ses_filtered'], byId: { ...before.byId, ses_filtered: created }, current: 'ses_filtered' });
  });
  await tick();

  const assigns = calls.filter((call) => call.url.endsWith('/assign'));
  assert.equal(assigns.length, 1, 'the blank is filed into the topic being looked at');
  assert.deepEqual(assigns[0].body.sessionIds, ['ses_filtered']);
  assert.equal(assigns[0].body.topicId, TOPIC);
});

test('a blank created in another workspace is not written into the filtered topic', async () => {
  // Two real workspaces: without the workspace guard the blank of `ws_two` would be filed into
  // `ws_one`'s topic id — a cross-workspace assignment, which is what the drag guard refuses.
  responseOverrides[`${API}/state`] = () => {
    const payload = stateResult();
    payload.result.workspaces = {
      ...payload.result.workspaces,
      ws_two: {
        topics: [{ id: 'tp_default', name: '默认分组', emoji: '', order: -1, createdAt: 0, system: true }],
        assignments: {},
      },
    };
    return payload;
  };
  responseOverrides[`${API}/assign`] = () => ({ ok: true, result: { revision: 6, result: { changed: 1 } } });
  const one = workspaceSource.getSnapshot();
  workspaceSource.set({
    ...one,
    items: [
      one.items[0],
      { workspaceId: 'ws_two', path: 'D:/work/two', title: 'Two', sessionIds: ['ses_other_ws'], createdAt: 2, updatedAt: 2 },
    ],
  });
  await mount();
  await act(async () => {
    find('.dts-row--topic', '设计').dispatchEvent(new window.Event('contextmenu', { bubbles: true, cancelable: true }));
  });
  await tick();
  await act(async () => {
    [...document.querySelectorAll('.dts-pop--menu .dts-menu__item')]
      .find((node) => node.textContent.includes('只看此分组'))
      .dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  await tick();

  const before = sessionSource.getSnapshot();
  const foreign = { id: 'ses_other_ws2', displayTitle: '', cwd: 'D:/work/two', updatedAt: Date.now(), blank: true, retainedBy: { mainView: 1 } };
  const two = workspaceSource.getSnapshot();
  workspaceSource.set({
    ...two,
    items: two.items.map((item) => (item.workspaceId === 'ws_two' ? { ...item, sessionIds: [...item.sessionIds, 'ses_other_ws2'] } : item)),
  });
  await act(async () => {
    sessionSource.set({ ...before, ids: [...before.ids, 'ses_other_ws2'], byId: { ...before.byId, ses_other_ws2: foreign }, current: 'ses_other_ws2' });
  });
  await tick();
  assert.equal(
    calls.some((call) => call.url.endsWith('/assign')),
    false,
    'filing it into another workspace’s topic is the assignment the drag guard refuses',
  );
});

test('a pending topic does not claim a blank created in another workspace', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  responseOverrides[`${API}/assign`] = () => ({ ok: true, result: { revision: 6, result: { changed: 1 } } });
  const one = workspaceSource.getSnapshot();
  workspaceSource.set({
    ...one,
    items: [
      one.items[0],
      { workspaceId: 'ws_two', path: 'D:/work/two', title: 'Two', sessionIds: [], createdAt: 2, updatedAt: 2 },
    ],
  });
  await mount();
  await act(async () => {
    find('.dts-row--topic', '设计').querySelector('.dts-row__actions .dts-iconbtn[title="在此分组下新建会话"]').dispatchEvent(new window.Event('click', { bubbles: true }));
  });

  // Another window starts a blank in ws_two while ws_one's topic arm is still pending.
  const before = sessionSource.getSnapshot();
  const foreign = { id: 'ses_foreign', displayTitle: '', cwd: 'D:/work/two', updatedAt: Date.now(), blank: true, retainedBy: { mainView: 1 } };
  await act(async () => {
    sessionSource.set({ ...before, ids: [...before.ids, 'ses_foreign'], byId: { ...before.byId, ses_foreign: foreign }, current: 'ses_foreign' });
  });
  await tick();
  assert.equal(calls.some((call) => call.url.endsWith('/assign')), false, 'the foreign blank is never written into ws_one');

  const own = { id: 'ses_own', displayTitle: '', cwd: 'D:/work/one', updatedAt: Date.now(), blank: true, retainedBy: { mainView: 1 } };
  await act(async () => {
    const current = sessionSource.getSnapshot();
    sessionSource.set({ ...current, ids: [...current.ids, 'ses_own'], byId: { ...current.byId, ses_own: own }, current: 'ses_own' });
  });
  await tick();
  const assign = calls.find((call) => call.url.endsWith('/assign'));
  assert.ok(assign, 'the blank from the clicked workspace is still claimed');
  assert.deepEqual(assign.body.sessionIds, ['ses_own']);
  assert.equal(assign.body.topicId, TOPIC);
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
  assert.ok(findAnywhere('.dts-row--topic', 'Default'), 'tree labels re-localize with the panel');
  assert.equal(findAnywhere('.dts-row--topic', '默认分组'), undefined, 'and the old locale is not left behind');
});

test('the panel asks the host to repair workspace membership once per page load', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  responseOverrides[`${API}/sessions/adopt`] = () => ({ ok: true, result: { available: true, adopted: ['ses_lost', 'ses_lost2'], skipped: 3, failed: [] } });
  await mount();
  await tick();

  const adopts = () => calls.filter((call) => call.url.endsWith('/sessions/adopt'));
  assert.equal(adopts().length, 1, 'a single repair call on the first on-screen pass');
  assert.equal(sessionRefreshCalls, 1, 'and the host session list is re-read so the rows move');
  assert.ok(findAnywhere('.dts-toast')?.textContent.includes('2'), 'the user is told how many sessions moved');
});

test('a failed repair stays silent instead of turning into a banner', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  responseOverrides[`${API}/sessions/adopt`] = () => ({ ok: false, status: 500, statusText: 'boom', error: 'boom', code: 'internal' });
  await mount();
  await tick();
  assert.equal(container.querySelector('.dts-banner'), null, 'a repair that cannot run is not a state change');
  assert.equal(findAnywhere('.dts-toast'), undefined, 'and it toasts nothing');
});

test('a hidden panel does not ask for a repair', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  // Rail mode before mount: the overlay never paints, so the once-per-load effect never runs.
  document.querySelector('.BynINW_frame').setAttribute('data-sidebar-collapsed', '');
  await mount();
  await tick(200);
  assert.equal(calls.some((call) => call.url.endsWith('/sessions/adopt')), false);
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

test('adding a workspace delegates to the host’s own control so the composed picker runs', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  await mount();
  const region = document.querySelector('[class*="_regionArea"]');
  const nativeAdd = document.createElement('button');
  nativeAdd.setAttribute('aria-label', '添加工作区');
  let nativeClicks = 0;
  nativeAdd.addEventListener('click', () => {
    nativeClicks += 1;
  });
  region.append(nativeAdd);
  assert.equal(region.hasAttribute('inert'), true, 'the stock control sits under the inert cover');

  const plus = [...container.querySelectorAll('.dts-header .dts-iconbtn')].find((node) => node.getAttribute('title') === '创建');
  await act(async () => {
    plus.dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  await tick();
  await act(async () => {
    [...document.querySelectorAll('.dts-pop--create .dts-menu__item')]
      .find((node) => node.textContent.includes('添加工作区'))
      .dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  await tick();

  assert.equal(nativeClicks, 1, 'the host flow owns the picker it actually composed (native or browse)');
  assert.equal(pickDirectoryCalls, 0, 'the plugin never calls the native-only RPC itself');
  assert.deepEqual(workspaceCreateCalls, [], 'the host creates the workspace in its own flow');
});

test('the delegated add control is found by shortcut when the label is another locale', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  await mount();
  const region = document.querySelector('[class*="_regionArea"]');
  const nativeAdd = document.createElement('button');
  nativeAdd.setAttribute('aria-label', 'Añadir área de trabajo');
  nativeAdd.setAttribute('aria-keyshortcuts', 'Control+Alt+O');
  let nativeClicks = 0;
  nativeAdd.addEventListener('click', () => {
    nativeClicks += 1;
  });
  region.append(nativeAdd);

  const plus = [...container.querySelectorAll('.dts-header .dts-iconbtn')].find((node) => node.getAttribute('title') === '创建');
  await act(async () => {
    plus.dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  await tick();
  await act(async () => {
    [...document.querySelectorAll('.dts-pop--create .dts-menu__item')]
      .find((node) => node.textContent.includes('添加工作区'))
      .dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  await tick();

  assert.equal(nativeClicks, 1);
  assert.equal(pickDirectoryCalls, 0);
});

test('a busy host add control is not replaced by a second picker', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  await mount();
  const region = document.querySelector('[class*="_regionArea"]');
  const nativeAdd = document.createElement('button');
  nativeAdd.setAttribute('aria-label', '添加工作区');
  nativeAdd.disabled = true;
  let nativeClicks = 0;
  nativeAdd.addEventListener('click', () => {
    nativeClicks += 1;
  });
  region.append(nativeAdd);

  const plus = [...container.querySelectorAll('.dts-header .dts-iconbtn')].find((node) => node.getAttribute('title') === '创建');
  await act(async () => {
    plus.dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  await tick();
  await act(async () => {
    [...document.querySelectorAll('.dts-pop--create .dts-menu__item')]
      .find((node) => node.textContent.includes('添加工作区'))
      .dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  await tick();

  assert.equal(nativeClicks, 0, 'the disabled host control already owns an open flow');
  assert.equal(pickDirectoryCalls, 0, 'no second chooser is opened on top');
});

test('adding a workspace falls back to the shell’s window-owned picker without a host control', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  const bridge = {
    calls: 0,
    pick: async () => {
      bridge.calls += 1;
      return 'D:/work/two';
    },
  };
  globalThis.__DSH_DIRECTORY_PICKER__ = bridge;
  try {
    await mount();
    const plus = [...container.querySelectorAll('.dts-header .dts-iconbtn')].find((node) => node.getAttribute('title') === '创建');
    await act(async () => {
      plus.dispatchEvent(new window.Event('click', { bubbles: true }));
    });
    await tick();
    await act(async () => {
      [...document.querySelectorAll('.dts-pop--create .dts-menu__item')]
        .find((node) => node.textContent.includes('添加工作区'))
        .dispatchEvent(new window.Event('click', { bubbles: true }));
    });
    await tick();

    assert.equal(bridge.calls, 1, 'the Desktop bridge opens the same window-owned sheet the host uses');
    assert.equal(pickDirectoryCalls, 0, 'the detached remote panel is not opened');
    assert.deepEqual(workspaceCreateCalls, [{ path: 'D:/work/two' }], 'the picked path becomes a workspace');
  } finally {
    delete globalThis.__DSH_DIRECTORY_PICKER__;
  }
});

test('adding a workspace falls back to the remote picker without the desktop bridge', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  await mount();
  const plus = [...container.querySelectorAll('.dts-header .dts-iconbtn')].find((node) => node.getAttribute('title') === '创建');
  await act(async () => {
    plus.dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  await tick();
  await act(async () => {
    [...document.querySelectorAll('.dts-pop--create .dts-menu__item')]
      .find((node) => node.textContent.includes('添加工作区'))
      .dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  await tick();

  assert.equal(pickDirectoryCalls, 1, 'the host command is the Web fallback');
  assert.deepEqual(workspaceCreateCalls, [], 'a cancelled pick creates nothing');
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

test('a reused blank is filed into the chosen group', async () => {
  // The host reuses an existing blank in the workspace (`createInWorkspace`) rather than
  // minting a new id, so a claim keyed only on new ids would leave it unfiled.
  responseOverrides[`${API}/state`] = stateResult;
  const sessions = makeSessions(3);
  sessions.ids = [...sessions.ids, 'ses_reused'];
  sessions.byId = {
    ...sessions.byId,
    ses_reused: { id: 'ses_reused', displayTitle: '', cwd: 'D:/work/one', updatedAt: 1, blank: true, retainedBy: { mainView: 1 } },
  };
  sessions.current = 'ses_reused';
  sessionSource.set(sessions);
  const one = workspaceSource.getSnapshot();
  workspaceSource.set({ ...one, items: [{ ...one.items[0], sessionIds: sessions.ids }] });
  const assignBodies = [];
  responseOverrides[`${API}/assign`] = (body) => {
    assignBodies.push(body);
    return { ok: true, result: { revision: 6, result: { changed: 1 } } };
  };
  await mount();

  await act(async () => {
    find('.dts-row--topic', '默认分组')
      .querySelector('.dts-row__actions .dts-iconbtn[title="在此分组下新建会话"]')
      .dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  await tick();

  assert.deepEqual(startSessionArgs, [WORKSPACE], 'the host is asked for a session in the clicked workspace');
  const assign = assignBodies.find((body) => body.sessionIds?.includes('ses_reused'));
  assert.ok(assign, 'the reused blank is filed into the chosen group');
  assert.equal(assign.topicId, 'tp_default');
});

test('the default group renders as a system topic row', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  await mount();
  const row = find('.dts-row--topic', '默认分组');
  assert.ok(row, 'the default group is listed');
  assert.equal(row.className.includes('is-bucket'), false, 'it is a topic row, not a trailing bucket');
  const mark = row.querySelector('.dts-dash');
  assert.ok(mark, 'and carries the no-marker dash');
  assert.equal(mark.textContent, '-', 'which is the literal - symbol');
});

test('the workspace menu keeps the native rename and delete commands', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  await mount();
  const openMenu = async () => {
    const menu = find('.dts-row--group').querySelector('.dts-row__actions .dts-iconbtn[aria-label="更多操作"]');
    await act(async () => {
      menu.dispatchEvent(new window.Event('click', { bubbles: true }));
    });
    await tick();
  };
  await openMenu();
  const labels = [...document.querySelectorAll('.dts-pop--menu .dts-menu__item')].map((node) => node.querySelector('.dts-menu__label').textContent.trim());
  assert.deepEqual(labels, ['工作区:One', '选择此分组全部会话', '新建分组', '重命名', '删除工作区'], 'the row + owns the new-session action, not this menu');

  await act(async () => {
    [...document.querySelectorAll('.dts-pop--menu .dts-menu__item')].find((node) => node.textContent.trim() === '重命名').dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  await tick();
  assert.equal(document.querySelector('.dts-dialog__title').textContent, '重命名工作区');
  const input = document.querySelector('.dts-dialog .dts-input');
  assert.equal(input.value, 'One', 'the dialog starts from the current workspace name');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  await act(async () => {
    setter.call(input, 'One Renamed');
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  await act(async () => {
    [...document.querySelectorAll('.dts-dialog__foot .dts-btn')].find((node) => node.textContent.trim() === '重命名').dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  await tick();
  assert.deepEqual(workspaceRenameCalls, [[WORKSPACE, 'One Renamed']], 'the rename goes through the host workspace service');
  assert.equal(document.querySelector('.dts-dialog'), null, 'and the dialog closes');

  await openMenu();
  await act(async () => {
    [...document.querySelectorAll('.dts-pop--menu .dts-menu__item')].find((node) => node.textContent.trim() === '删除工作区').dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  await tick();
  assert.equal(document.querySelector('.dts-dialog__title').textContent, '删除工作区');
  assert.ok(document.querySelector('.dts-dialog__description').textContent.includes('One'));
  await act(async () => {
    document.querySelector('.dts-dialog__foot .dts-btn--danger').dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  await tick();
  assert.deepEqual(workspaceDeleteCalls, [WORKSPACE], 'the delete goes through the host workspace service');
});

test('clicking the same row or header trigger toggles its menu closed', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  await mount();

  const rowTrigger = find('.dts-row--session', '会话 1').querySelector('.dts-row__actions .dts-iconbtn');
  await act(async () => rowTrigger.dispatchEvent(new window.Event('click', { bubbles: true })));
  await tick();
  assert.ok(document.querySelector('.dts-pop--menu'), 'the row menu opens');
  await act(async () => rowTrigger.dispatchEvent(new window.Event('click', { bubbles: true })));
  await tick();
  assert.equal(document.querySelector('.dts-pop--menu'), null, 'a second click on the same row trigger closes it');

  const headerTrigger = container.querySelector('.dts-header .dts-iconbtn[aria-label="更多操作"]');
  await act(async () => headerTrigger.dispatchEvent(new window.Event('click', { bubbles: true })));
  await tick();
  assert.ok(document.querySelector('.dts-pop--menu'), 'the header menu opens');
  await act(async () => headerTrigger.dispatchEvent(new window.Event('click', { bubbles: true })));
  await tick();
  assert.equal(document.querySelector('.dts-pop--menu'), null, 'a second click on the same header trigger closes it');
});

test('the topic menu no longer offers a new-session item', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  await mount();
  await act(async () => {
    find('.dts-row--topic', '设计').dispatchEvent(new window.Event('contextmenu', { bubbles: true, cancelable: true }));
  });
  await tick();
  const labels = [...document.querySelectorAll('.dts-pop--menu .dts-menu__item')].map((node) => node.querySelector('.dts-menu__label').textContent.trim());
  assert.deepEqual(labels, ['只看此分组', '选择此分组全部会话', '重命名分组', '删除分组'], 'the row + owns the new-session action, not this menu');
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

test('a workspace without a sidecar document still owns the default group', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  const extra = { workspaceId: 'ws_two', path: 'D:/work/two', title: 'Two', sessionIds: [], createdAt: 2, updatedAt: 2 };
  workspaceSource.set({ ...workspaceSource.getSnapshot(), items: [...workspaceSource.getSnapshot().items, extra] });
  await mount();

  const group = [...container.querySelectorAll('.dts-row--group')].find((node) => node.textContent.includes('Two'));
  assert.ok(group, 'the second workspace renders');
  const defaultRow = group.parentElement.querySelector('.dts-row--topic');
  assert.ok(defaultRow?.textContent.includes('默认分组'), 'the tree injects its system default group even before the first write');

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
    [...document.querySelectorAll('.dts-pop--create .dts-menu__item')].find((node) => node.textContent.trim().startsWith('Two')).dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  await tick();
  const labels = [...document.querySelectorAll('.dts-pop--create .dts-menu__item')].map((node) => node.textContent.trim());
  assert.ok(labels.some((label) => label.includes('默认分组')), 'and the new-session picker offers it');
  await act(async () => {
    [...document.querySelectorAll('.dts-pop--create .dts-menu__item')].find((node) => node.textContent.includes('默认分组')).dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  await tick();
  assert.deepEqual(startSessionArgs, ['ws_two'], 'picking it starts the session in that workspace');
});

test('a filter on the virtual default group survives reconciliation', async () => {
  window.localStorage.setItem('dsh-better-workspace:prefs:v1', JSON.stringify({ topicFilter: 'tp_default' }));
  responseOverrides[`${API}/state`] = () => ({
    ok: true,
    result: {
      enabled: true,
      deleteAvailable: true,
      revision: 4,
      updatedAt: 1,
      readOnly: false,
      warning: null,
      emojis: [],
      workspaces: {},
    },
  });
  await mount();
  await tick(60);
  const chips = [...container.querySelectorAll('.dts-chip')];
  assert.ok(chips.some((chip) => chip.textContent.includes('默认分组')), 'the virtual default group remains a valid filter target');
  assert.ok(find('.dts-row--topic', '默认分组'), 'and the tree still shows that group');
});

test('a default-group filter is scoped to the workspace it was opened from', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  const extra = { workspaceId: 'ws_two', path: 'D:/work/two', title: 'Two', sessionIds: [], createdAt: 2, updatedAt: 2 };
  workspaceSource.set({ ...workspaceSource.getSnapshot(), items: [...workspaceSource.getSnapshot().items, extra] });
  await mount();
  const twoHeader = [...container.querySelectorAll('.dts-row--group')].find((node) => node.textContent.includes('Two'));
  assert.ok(twoHeader, 'the second workspace renders');
  const twoDefault = twoHeader.parentElement.querySelector('.dts-row--topic');
  assert.ok(twoDefault?.textContent.includes('默认分组'), 'both workspaces show their default group');
  const filter = twoDefault.querySelector('.dts-row__actions .dts-iconbtn[aria-label="只看此分组"]');
  assert.ok(filter, 'the default group can be filtered');
  await act(async () => {
    filter.dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  await tick();
  const groups = [...container.querySelectorAll('.dts-row--group')];
  assert.equal(groups.length, 1, 'the filter scopes to one workspace');
  assert.ok(groups[0].textContent.includes('Two'), 'and it is the workspace whose group was clicked');
  const chips = [...container.querySelectorAll('.dts-chip')].map((chip) => chip.textContent);
  assert.ok(chips.some((text) => text.includes('Two')), 'the workspace lock is visible in the chips');
  assert.ok(chips.some((text) => text.includes('默认分组')), 'the topic chip stays visible');
  const saved = JSON.parse(window.localStorage.getItem('dsh-better-workspace:prefs:v1'));
  assert.equal(saved.workspaceFilter, 'ws_two');
  assert.equal(saved.topicFilter, 'tp_default');
  assert.equal(saved.topicFilterWorkspace, 'ws_two', 'the filter records which workspace owns that group id');
  const tinted = container.querySelectorAll('.dts-folder.is-active');
  assert.equal(tinted.length, 1, 'the filtered workspace folder is tinted');
  assert.ok(groups[0].parentElement.contains(tinted[0]));

  const activeGroup = [...container.querySelectorAll('.dts-row--topic')].find((node) => node.textContent.includes('默认分组'));
  const filterAgain = activeGroup.querySelector('.dts-row__actions .dts-iconbtn[aria-label="只看此分组"]');
  assert.ok(filterAgain, 'the active group still offers the filter toggle');
  await act(async () => {
    filterAgain.dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  await tick();
  assert.equal(container.querySelectorAll('.dts-row--group').length, 2, 'cancelling releases the workspace lock too');
  assert.equal(container.querySelector('.dts-header__chips'), null, 'both filter chips disappear');
  const cleared = JSON.parse(window.localStorage.getItem('dsh-better-workspace:prefs:v1'));
  assert.equal(cleared.workspaceFilter, null);
  assert.equal(cleared.topicFilter, null);
});

test('deleting the last workspace clears a stale filter', async () => {
  window.localStorage.setItem('dsh-better-workspace:prefs:v1', JSON.stringify({ workspaceFilter: 'ws_one', topicFilter: 'tp_default' }));
  responseOverrides[`${API}/state`] = stateResult;
  await mount();
  assert.ok(container.querySelector('.dts-header__chips'), 'the filter starts valid');
  const snapshot = workspaceSource.getSnapshot();
  await act(async () => {
    workspaceSource.set({ ...snapshot, items: [] });
  });
  await tick(60);
  assert.equal(container.querySelector('.dts-header__chips'), null, 'a filter pointing at no live workspace is dropped');
  assert.ok(find('.dts-row--group', '未分组'), 'the orphaned sessions remain reachable in 未分组');
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

  await act(async () => {
    groups[0].dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  await tick();
  assert.equal(container.querySelectorAll('.dts-folder.is-active').length, 0, 'collapsing the workspace returns the folder to gray');
  await act(async () => {
    groups[0].dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  await tick();
  assert.equal(container.querySelectorAll('.dts-folder.is-active').length, 1, 'and expanding it restores the tint');
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
  const dash = bucket.querySelector('.dts-dash');
  assert.ok(dash, 'the default group carries a plain dash');
  assert.equal(dash.textContent, '-', 'the dash is the - symbol');
  assert.equal(bucket.querySelector('.dts-emoji'), null);
});

test('session statuses mirror the native row and roll up to topic and workspace slots', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  await mount();
  const topicRow = () => find('.dts-row--topic', '设计');
  const defaultRow = () => find('.dts-row--topic', '默认分组');
  const workspaceRow = () => find('.dts-row--group', 'One');
  const apply = async (entries) => {
    await act(async () => {
      sessionStatusSource.set(new Map(entries));
    });
    await tick();
  };

  assert.equal(workspaceRow().querySelector('.dts-workspace-status'), null, 'an idle workspace shows its folder');
  assert.equal(workspaceRow().className.includes('has-status'), false);
  assert.equal(workspaceRow().className.includes('is-active-workspace'), false);

  await apply([['ses_0', { running: true, pendingInteraction: { kind: 'question' } }]]);
  const pendingRow = find('.dts-row--session', '会话 0');
  assert.ok(pendingRow.querySelector('.dts-state-mark [data-state="warning"]'), 'the pending row uses the host warning dot');
  assert.equal(pendingRow.querySelector('.dts-row__time').textContent, '待回答', 'and its compact native label replaces the time');
  assert.ok(topicRow().querySelector('.dts-section-status [data-state="warning"]'), 'the topic indicator sits in the caret slot');
  assert.ok(workspaceRow().querySelector('.dts-workspace-status [data-state="warning"]'), 'the workspace carries the same status');
  assert.ok(workspaceRow().className.includes('has-status'), 'and knows it outranks the folder');
  assert.ok(workspaceRow().className.includes('is-active-workspace'), 'the active workspace keeps a visible highlight');
  assert.ok(workspaceRow().getAttribute('aria-label').includes('待回答'), 'the workspace announces its status');
  assert.ok(workspaceRow().getAttribute('aria-label').includes('3 个会话'), 'and keeps the session count in its name');
  assert.equal(pendingRow.querySelector('.dts-visually-hidden'), null, 'the compact label already names the pending state');
  assert.ok(topicRow().getAttribute('aria-label').includes('待回答'), 'the aggregate status is announced');

  await apply([
    ['ses_0', { completionUnread: true }],
    ['ses_1', { running: true }],
  ]);
  const completedRow = find('.dts-row--session', '会话 0');
  assert.ok(completedRow.querySelector('.dts-state-mark [data-state="done"]'), 'an unread completion uses the host success dot');
  assert.notEqual(completedRow.querySelector('.dts-row__time').textContent, '待回答');
  assert.equal(completedRow.querySelector('.dts-visually-hidden').textContent, '已完成', 'the completion is announced too');
  assert.equal(find('.dts-row--session', '会话 1').querySelector('.dts-visually-hidden').textContent, '进行中');
  assert.ok(topicRow().getAttribute('aria-label').includes('已完成'));
  assert.ok(topicRow().querySelector('.dts-section-status [data-state="done"]'), 'the topic indicator follows its completion');
  assert.ok(defaultRow().querySelector('.dts-section-status [data-state="ongoing"]'), 'the running default group uses the native spinner');
  assert.ok(find('.dts-row--session', '会话 1').querySelector('.dts-state-mark [data-state="ongoing"]'), 'the running row uses the native spinner');
  assert.ok(workspaceRow().querySelector('.dts-workspace-status [data-state="done"]'), 'completion outranks running on the workspace');
  assert.ok(workspaceRow().getAttribute('aria-label').includes('已完成'));

  await apply([
    ['ses_0', { completionUnread: true }],
    ['ses_1', { running: true, pendingInteraction: { kind: 'approval' } }],
  ]);
  assert.ok(topicRow().querySelector('.dts-section-status [data-state="done"]'), 'design keeps its completion indicator');
  assert.ok(defaultRow().querySelector('.dts-section-status [data-state="warning"]'), 'pending outranks completion in the default group');
  assert.ok(defaultRow().getAttribute('aria-label').includes('待审批'), 'and the pending label reaches assistive tech');
  assert.ok(workspaceRow().querySelector('.dts-workspace-status [data-state="warning"]'), 'pending outranks completion on the workspace');
  assert.ok(workspaceRow().getAttribute('aria-label').includes('待审批'));
  assert.equal(find('.dts-row--session', '会话 1').querySelector('.dts-row__time').textContent, '待审批');
});

test('the status marker falls back to the native spinner geometry without host primitives', async () => {
  const original = global.__noIcons;
  global.__noIcons = true;
  try {
    responseOverrides[`${API}/state`] = stateResult;
    await mount();
    await act(async () => {
      sessionStatusSource.set(new Map([['ses_0', { running: true }]]));
    });
    await tick();
    assert.ok(find('.dts-row--session', '会话 0').querySelector('.dts-spinner'), 'running falls back to a spinner');
    assert.ok(find('.dts-row--topic', '设计').querySelector('.dts-section-status .dts-spinner'), 'the group slot shares the fallback');
    assert.ok(find('.dts-row--group').querySelector('.dts-workspace-status .dts-spinner'), 'the workspace slot shares the fallback');

    await act(async () => {
      sessionStatusSource.set(new Map([
        ['ses_0', { running: true }],
        ['ses_1', { running: true, pendingInteraction: { kind: 'question' } }],
      ]));
    });
    await tick();
    assert.ok(find('.dts-row--session', '会话 1').querySelector('.dts-state-dot--warning'), 'pending falls back to the warning dot');
    assert.ok(find('.dts-row--group').querySelector('.dts-workspace-status .dts-state-dot--warning'), 'the workspace falls back to the warning dot');
  } finally {
    global.__noIcons = original;
  }
});

test('the workspace row plus starts a new session in that workspace', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  await mount();
  const actionTitles = [...find('.dts-row--group').querySelectorAll('.dts-row__actions .dts-iconbtn')].map((node) => node.getAttribute('title'));
  assert.deepEqual(actionTitles, ['更多操作', '新会话'], 'the hover strip follows the native order: menu, then new session');
  const plus = find('.dts-row--group').querySelector('.dts-row__actions .dts-iconbtn[title="新会话"]');
  assert.equal(plus.getAttribute('aria-label'), '在「One」中新建会话');
  assert.equal(plus.querySelector('svg').getAttribute('data-icon'), 'new-chat', 'it uses the native new-session glyph');
  await act(async () => {
    plus.dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  await tick();
  assert.deepEqual(startSessionArgs, [WORKSPACE], 'the plus starts the session in the row workspace');
  assert.equal(document.querySelector('.dts-dialog'), null, 'and never opens the topic dialog');
});

test('the archived bucket has no new-session button', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  const base = sessionSource.getSnapshot();
  sessionSource.set({
    ...base,
    ids: [...base.ids, 'ses_archived'],
    byId: { ...base.byId, ses_archived: { id: 'ses_archived', displayTitle: '旧会话', cwd: 'D:/work/one', updatedAt: 1, blank: false } },
  });
  workspaceSource.set({ ...workspaceSource.getSnapshot(), archivedSessionIds: ['ses_archived'] });
  await mount();
  await act(async () => {
    container.querySelector('.dts-header .dts-iconbtn[aria-label="更多操作"]').dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  await tick();
  await act(async () => {
    [...document.querySelectorAll('.dts-pop--menu .dts-menu__item')].find((node) => node.textContent.includes('显示已归档')).dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  await tick();
  const archived = find('.dts-row--topic', '已归档');
  assert.ok(archived, 'the archived bucket renders');
  assert.equal(archived.querySelector('.dts-row__actions [title="在此分组下新建会话"]'), null, 'but a bucket is not a topic');
});

test('the create dialog picks the workspace from a dropdown', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  const extra = { workspaceId: 'ws_two', path: 'D:/work/two', title: 'Two', sessionIds: [], createdAt: 2, updatedAt: 2 };
  workspaceSource.set({ ...workspaceSource.getSnapshot(), items: [...workspaceSource.getSnapshot().items, extra] });
  await mount();
  await openTopicCreateDialog();
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
  await openTopicCreateDialog();
  const picker = document.querySelector('.dts-picker');
  assert.ok(picker, 'the attach picker renders');
  const titles = [...picker.querySelectorAll('.dts-picker__title')].map((node) => node.textContent.trim());
  assert.equal(titles.includes('新会话'), false, 'the blank row is not attachable');
  assert.equal(titles.includes('会话 1'), true, 'ordinary sessions stay attachable');
});

test('the attach picker labels each row with its current group', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  await mount();
  await openTopicCreateDialog();
  const picker = document.querySelector('.dts-picker');
  const labels = [...picker.querySelectorAll('.dts-picker__row')].map((row) => ({
    title: row.querySelector('.dts-picker__title').textContent.trim(),
    group: row.querySelector('.dts-picker__group').textContent.trim(),
  }));
  assert.deepEqual(labels, [
    { title: '会话 1', group: '默认分组' },
    { title: '会话 2', group: '默认分组' },
    { title: '会话 0', group: '设计' },
  ]);
  assert.equal(labels.some((entry) => entry.group === 'One'), false, 'the workspace title is not repeated on every row');
});

test('the selection toolbar greys out actions that conflict with the selection', async () => {
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
  const buttonByLabel = (label) => [...container.querySelectorAll('.dts-selectbar .dts-iconbtn')].find((node) => node.getAttribute('aria-label') === label);
  assert.equal(container.querySelector('.dts-selectbar__count').textContent.trim(), '已选 2 个会话');
  assert.equal(buttonByLabel('归档').disabled, true, 'an archived row in the selection blocks 归档');
  assert.equal(buttonByLabel('取消归档').disabled, true, 'an unarchived row in the selection blocks 取消归档');
  assert.equal(buttonByLabel('移动到分组').disabled, true, 'archived rows cannot be re-filed');
  assert.equal(buttonByLabel('永久删除').disabled, false, 'deleting stays available for both kinds');
  assert.equal(container.querySelector('.dts-selectbar__hint').textContent.trim(), '已归档与未归档会话不能一起处理');
  await act(async () => {
    toggle('归档项2');
  });
  await tick();
  assert.equal(buttonByLabel('归档').disabled, false, 'unarchived-only selection can archive');
  assert.equal(buttonByLabel('取消归档').disabled, true, 'and still cannot unarchive');
  assert.equal(buttonByLabel('移动到分组').disabled, false);
  assert.equal(container.querySelector('.dts-selectbar__hint'), null, 'the mixed-state hint clears with the selection');
});

test('selection mode leaves the provisional New Session out of the batch', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  const base = sessionSource.getSnapshot();
  sessionSource.set({
    ...base,
    current: 'ses_blank',
    ids: [...base.ids, 'ses_blank'],
    byId: {
      ...base.byId,
      ses_blank: { id: 'ses_blank', displayTitle: '', cwd: 'D:/work/one', updatedAt: Date.now(), blank: true, retainedBy: { mainView: 1 } },
    },
  });
  const workspace = workspaceSource.getSnapshot();
  workspaceSource.set({ ...workspace, items: [{ ...workspace.items[0], sessionIds: [...base.ids, 'ses_blank'] }] });
  await mount();
  assert.ok(find('.dts-row--session', '新会话'), 'the placeholder renders at rest');
  const headerButton = (title) => [...container.querySelectorAll('.dts-header .dts-iconbtn')].find((node) => node.getAttribute('title') === title);
  await act(async () => {
    headerButton('批量选择').dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  await tick();
  assert.equal(find('.dts-row--session', '新会话'), undefined, 'the placeholder steps out of the selection list');
  assert.equal(container.querySelector('.dts-selectbar__count').textContent.trim(), '已选 0 个会话');
  await act(async () => {
    find('.dts-row--topic', '默认分组').dispatchEvent(new window.Event('contextmenu', { bubbles: true, cancelable: true }));
  });
  await tick();
  await act(async () => {
    [...document.querySelectorAll('.dts-pop--menu .dts-menu__item')]
      .find((node) => node.textContent.trim() === '选择此分组全部会话')
      .dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  await tick();
  assert.equal(container.querySelector('.dts-selectbar__count').textContent.trim(), '已选 2 个会话', 'selecting the group skips the placeholder');
});

test('batch move is disabled when the selection includes an ungrouped session', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  const base = sessionSource.getSnapshot();
  sessionSource.set({
    ...base,
    ids: [...base.ids, 'ses_stray'],
    byId: { ...base.byId, ses_stray: { id: 'ses_stray', displayTitle: '游离会话', cwd: 'D:/elsewhere', updatedAt: Date.now() } },
  });
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
    toggle('游离会话');
  });
  await tick();
  const buttonByLabel = (label) => [...container.querySelectorAll('.dts-selectbar .dts-iconbtn')].find((node) => node.getAttribute('aria-label') === label);
  const move = buttonByLabel('移动到分组');
  assert.equal(move.disabled, true, 'an ungrouped row has no workspace to move within');
  assert.equal(move.title, '未分组会话没有工作区，不能移动到分组');
  assert.equal(buttonByLabel('归档').disabled, false, 'archive remains available');
  await act(async () => {
    toggle('游离会话');
  });
  await tick();
  assert.equal(buttonByLabel('移动到分组').disabled, false, 'the remaining workspace-only selection can move');
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
  assert.equal(container.querySelector('.dts-selectbar'), null);
});

test('an empty topic name explains itself once the field is touched', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  await mount();
  await openTopicCreateDialog();
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

test('a name that is taken or illegal is refused in the field', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  await mount();
  await openTopicCreateDialog();
  const input = document.querySelector('.dts-dialog .dts-input');
  const createButton = () => [...document.querySelectorAll('.dts-dialog .dts-btn')].find((node) => node.textContent.trim() === '创建');
  const hint = () => document.querySelector('.dts-dialog .dts-field__hint.is-error');
  const type = (value) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  };
  await act(async () => type('设计'));
  await tick();
  assert.equal(hint().textContent, '该工作区已有同名分组', 'a duplicate name is called out in the field');
  assert.equal(createButton().disabled, true);
  assert.equal(calls.some((call) => call.url.endsWith('/topics/create')), false, 'nothing is sent');
  await act(async () => type('非法\u0001字符'));
  await tick();
  assert.equal(hint().textContent, '分组名称不能包含控制字符', 'control characters are illegal');
  assert.equal(createButton().disabled, true);
  await act(async () => type('真的新分组'));
  await tick();
  assert.equal(hint(), null, 'a usable name clears the hint');
  assert.equal(createButton().disabled, false);
});

test('dragging a workspace row reorders the workspaces', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  const snapshot = workspaceSource.getSnapshot();
  workspaceSource.set({
    ...snapshot,
    items: [...snapshot.items, { workspaceId: 'ws_two', path: 'D:/work/two', title: 'Two', sessionIds: [], createdAt: 2, updatedAt: 2 }],
  });
  await mount();
  const titles = () => [...container.querySelectorAll('.dts-row--group .dts-row__text')].map((node) => node.textContent);
  assert.deepEqual(titles(), ['One', 'Two']);
  const rows = [...container.querySelectorAll('.dts-row--group')];
  await act(async () => {
    const start = new window.Event('dragstart', { bubbles: true });
    start.dataTransfer = makeDataTransfer([]);
    rows[0].dispatchEvent(start);
    const drop = new window.Event('drop', { bubbles: true, cancelable: true });
    drop.dataTransfer = makeDataTransfer([]);
    rows[1].dispatchEvent(drop);
  });
  await tick();
  assert.deepEqual(titles(), ['Two', 'One'], 'the dragged workspace lands where it was dropped');
});

test('dragging a topic row reorders the topics of that workspace', async () => {
  responseOverrides[`${API}/state`] = () => ({
    ok: true,
    result: {
      ...stateResult().result,
      workspaces: {
        [WORKSPACE]: {
          topics: [
            { id: 'tp_default', name: '默认分组', emoji: '', order: -1, createdAt: 0, system: true },
            { id: 'tp_a', name: 'A', emoji: '', order: 0, createdAt: 1 },
            { id: TOPIC, name: '设计', emoji: '', order: 1, createdAt: 2 },
          ],
          assignments: {},
        },
      },
    },
  });
  responseOverrides[`${API}/topics/reorder`] = () => ({ ok: true, result: { revision: 5, result: { topics: [] } } });
  await mount();
  const rows = [...container.querySelectorAll('.dts-row--topic')];
  assert.equal(rows.length, 3, 'default group plus two topics');
  await act(async () => {
    const start = new window.Event('dragstart', { bubbles: true });
    start.dataTransfer = makeDataTransfer([]);
    rows[1].dispatchEvent(start);
    const drop = new window.Event('drop', { bubbles: true, cancelable: true });
    drop.dataTransfer = makeDataTransfer([]);
    rows[2].dispatchEvent(drop);
  });
  await tick();
  const call = calls.find((entry) => entry.url.endsWith('/topics/reorder'));
  assert.ok(call, 'the new order is written to the sidecar');
  assert.deepEqual(call.body.topicIds, ['tp_default', TOPIC, 'tp_a']);
  assert.equal(call.body.workspaceId, WORKSPACE);

  // The default group drags too: being first is only its starting position.
  await act(async () => {
    const start = new window.Event('dragstart', { bubbles: true });
    start.dataTransfer = makeDataTransfer([]);
    rows[0].dispatchEvent(start);
    const drop = new window.Event('drop', { bubbles: true, cancelable: true });
    drop.dataTransfer = makeDataTransfer([]);
    rows[2].dispatchEvent(drop);
  });
  await tick();
  const last = calls.filter((entry) => entry.url.endsWith('/topics/reorder')).pop();
  assert.deepEqual(last.body.topicIds, ['tp_a', TOPIC, 'tp_default'], 'the default group can be filed anywhere');
});

test('a topic drag marks only the default group of the workspace being dragged in', async () => {
  // `tp_default` is the same id in every workspace; matching the insertion line on the id
  // alone drew it beside every workspace's default group.
  responseOverrides[`${API}/state`] = () => {
    const payload = stateResult();
    payload.result.workspaces = {
      ...payload.result.workspaces,
      ws_two: {
        topics: [{ id: 'tp_default', name: '默认分组', emoji: '', order: -1, createdAt: 0, system: true }],
        assignments: {},
      },
    };
    return payload;
  };
  const one = workspaceSource.getSnapshot();
  workspaceSource.set({
    ...one,
    items: [
      one.items[0],
      { workspaceId: 'ws_two', path: 'D:/work/two', title: 'Two', sessionIds: [], createdAt: 2, updatedAt: 2 },
    ],
  });
  await mount();

  const groups = [...container.querySelectorAll('.dts-group')];
  const [oneDefault, oneTopic] = groups[0].querySelectorAll('.dts-row--topic');
  const twoDefault = groups[1].querySelector('.dts-row--topic');
  assert.ok(oneDefault.textContent.includes('默认分组'));
  assert.ok(twoDefault.textContent.includes('默认分组'));

  await act(async () => {
    const start = new window.Event('dragstart', { bubbles: true });
    start.dataTransfer = makeDataTransfer([]);
    oneTopic.dispatchEvent(start);
    const over = new window.Event('dragover', { bubbles: true, cancelable: true });
    over.dataTransfer = makeDataTransfer([]);
    oneDefault.dispatchEvent(over);
  });
  await tick();

  const marked = (row) => row.classList.contains('is-dropbefore') || row.classList.contains('is-dropafter');
  assert.equal(marked(oneDefault), true, 'the hovered workspace default group shows the insertion line');
  assert.equal(marked(twoDefault), false, 'the other workspace default group stays clean');

  await act(async () => oneTopic.dispatchEvent(new window.Event('dragend', { bubbles: true })));
  await tick();
  assert.equal(marked(oneDefault), false, 'ending the drag clears the line');
});

test('dragging a session onto another session reorders them', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  await mount();
  const rowFor = (title) => find('.dts-row--session', title);
  await act(async () => {
    const start = new window.Event('dragstart', { bubbles: true });
    start.dataTransfer = makeDataTransfer(['ses_1']);
    rowFor('会话 1').dispatchEvent(start);
    const drop = new window.Event('drop', { bubbles: true, cancelable: true });
    drop.dataTransfer = makeDataTransfer(['ses_1']);
    rowFor('会话 2').dispatchEvent(drop);
  });
  await tick();
  assert.equal(calls.some((entry) => entry.url.endsWith('/assign')), false, 'reordering is not a re-file');
  const order = [...container.querySelectorAll('.dts-row--session .dts-row__text')].map((node) => node.textContent);
  assert.equal(order.indexOf('会话 2') < order.indexOf('会话 1'), true, 'the dropped row follows its target');
  const saved = JSON.parse(window.localStorage.getItem('dsh-better-workspace:prefs:v1')).sessionOrder;
  // The whole workspace order is persisted (not just the rows one topic section happened to
  // show), so a reorder can never drop a session out of the manual order.
  assert.deepEqual(saved[WORKSPACE], ['ses_0', 'ses_2', 'ses_1']);
});

test('a session drag opts a sibling row into the reorder drop and clears the hint on dragend', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  await mount();
  const source = find('.dts-row--session', '会话 1');
  const target = find('.dts-row--session', '会话 2');
  await act(async () => {
    const start = new window.Event('dragstart', { bubbles: true });
    start.dataTransfer = makeDataTransfer(['ses_1']);
    source.dispatchEvent(start);
  });
  const over = new window.Event('dragover', { bubbles: true, cancelable: true });
  over.dataTransfer = makeDataTransfer(['ses_1']);
  await act(async () => target.dispatchEvent(over));
  assert.equal(over.defaultPrevented, true, 'the sibling row allows the drop, which is what makes drop fire in a browser');
  assert.equal(target.classList.contains('is-dropafter'), true, 'the insertion line marks where the row would land');
  await act(async () => source.dispatchEvent(new window.Event('dragend', { bubbles: true })));
  await tick();
  assert.equal(target.classList.contains('is-dropafter'), false, 'cancelling the drag clears the insertion line');
});

test('a session dragged from another topic can be dropped on a row of that topic', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  await mount();
  const source = find('.dts-row--session', '会话 1');
  const target = find('.dts-row--session', '会话 0');
  await act(async () => {
    const start = new window.Event('dragstart', { bubbles: true });
    start.dataTransfer = makeDataTransfer(['ses_1']);
    source.dispatchEvent(start);
  });
  const over = new window.Event('dragover', { bubbles: true, cancelable: true });
  over.dataTransfer = makeDataTransfer(['ses_1']);
  await act(async () => target.dispatchEvent(over));
  assert.equal(over.defaultPrevented, true, 'a row of a different topic accepts a file drop');

  await act(async () => {
    const drop = new window.Event('drop', { bubbles: true, cancelable: true });
    drop.dataTransfer = makeDataTransfer(['ses_1']);
    target.dispatchEvent(drop);
  });
  const assign = calls.find((entry) => entry.url.endsWith('/assign'));
  assert.ok(assign, 'dropping on the row files the session');
  assert.equal(assign.body.topicId, TOPIC);
});

test('dragging a topic collapses its sibling groups until the drag ends', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  await mount();
  const source = find('.dts-row--topic', '设计');
  const sibling = find('.dts-row--topic', '默认分组');
  const siblingSection = sibling.closest('.dts-section');
  assert.equal(sibling.getAttribute('aria-expanded'), 'true');
  await act(async () => {
    const start = new window.Event('dragstart', { bubbles: true });
    start.dataTransfer = makeDataTransfer([]);
    source.dispatchEvent(start);
  });
  await tick();
  assert.equal(source.getAttribute('aria-expanded'), 'true', 'the group being dragged stays open');
  assert.equal(sibling.getAttribute('aria-expanded'), 'false', 'other groups in the workspace fold away');
  assert.equal(siblingSection.querySelector('.dts-collapse').classList.contains('is-collapsed'), true, 'and their bodies animate closed');
  assert.ok(siblingSection.querySelector('.dts-row--session'), 'the folded body stays mounted so the height can animate');

  await act(async () => source.dispatchEvent(new window.Event('dragend', { bubbles: true })));
  await tick();
  assert.equal(sibling.getAttribute('aria-expanded'), 'true', 'releasing restores the previous fold state');
});

test('a strip under the last topic appends a dragged topic to the end', async () => {
  responseOverrides[`${API}/state`] = () => ({
    ok: true,
    result: {
      ...stateResult().result,
      workspaces: {
        [WORKSPACE]: {
          topics: [
            { id: 'tp_default', name: '默认分组', emoji: '', order: -1, createdAt: 0, system: true },
            { id: 'tp_a', name: 'A', emoji: '', order: 0, createdAt: 1 },
            { id: TOPIC, name: '设计', emoji: '\u{1F4A1}', order: 1, createdAt: 2 },
          ],
          assignments: {},
        },
      },
    },
  });
  responseOverrides[`${API}/topics/reorder`] = () => ({ ok: true, result: { revision: 5, result: { topics: [] } } });
  await mount();
  const source = find('.dts-row--topic', 'A');
  const last = find('.dts-row--topic', '设计');
  await act(async () => {
    const start = new window.Event('dragstart', { bubbles: true });
    start.dataTransfer = makeDataTransfer([]);
    source.dispatchEvent(start);
  });
  await tick();
  const tail = container.querySelector('.dts-drop-tail');
  assert.ok(tail, 'a taller append target appears under the last group');

  const over = new window.Event('dragover', { bubbles: true, cancelable: true });
  over.dataTransfer = makeDataTransfer([]);
  await act(async () => tail.dispatchEvent(over));
  assert.equal(over.defaultPrevented, true, 'the strip accepts the drop');
  assert.equal(last.classList.contains('is-dropafter'), true, 'the insertion line sits after the last group');

  await act(async () => {
    const drop = new window.Event('drop', { bubbles: true, cancelable: true });
    drop.dataTransfer = makeDataTransfer([]);
    tail.dispatchEvent(drop);
  });
  await tick();
  const call = calls.find((entry) => entry.url.endsWith('/topics/reorder'));
  assert.ok(call, 'the drop writes the new order');
  assert.deepEqual(call.body.topicIds, ['tp_default', TOPIC, 'tp_a'], 'the dragged topic lands last');
  assert.equal(container.querySelector('.dts-drop-tail'), null, 'the strip disappears with the drag');
});

test('dragging a workspace collapses the other workspaces until the drag ends', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  const snapshot = workspaceSource.getSnapshot();
  workspaceSource.set({
    ...snapshot,
    items: [...snapshot.items, { workspaceId: 'ws_two', path: 'D:/work/two', title: 'Two', sessionIds: [], createdAt: 2, updatedAt: 2 }],
  });
  await mount();
  const [source, sibling] = [...container.querySelectorAll('.dts-row--group')];
  await act(async () => {
    const start = new window.Event('dragstart', { bubbles: true });
    start.dataTransfer = makeDataTransfer([]);
    source.dispatchEvent(start);
  });
  await tick();
  assert.equal(source.getAttribute('aria-expanded'), 'true', 'the dragged workspace stays open');
  assert.equal(sibling.getAttribute('aria-expanded'), 'false', 'the other workspace folds away');
  await act(async () => source.dispatchEvent(new window.Event('dragend', { bubbles: true })));
  await tick();
  assert.equal(sibling.getAttribute('aria-expanded'), 'true', 'releasing restores it');
});

test('sessions outside every workspace trail in a virtual 未分组 group', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  const base = sessionSource.getSnapshot();
  sessionSource.set({
    ...base,
    ids: [...base.ids, 'ses_stray'],
    byId: { ...base.byId, ses_stray: { id: 'ses_stray', displayTitle: '游离会话', cwd: 'D:/elsewhere', updatedAt: Date.now(), blank: false } },
  });
  await mount();
  const groups = [...container.querySelectorAll('.dts-row--group')];
  const virtual = groups[groups.length - 1];
  assert.ok(virtual.textContent.includes('未分组'), 'the trailing group is 未分组');
  const virtualGroup = virtual.closest('.dts-group');
  assert.ok([...virtualGroup.querySelectorAll('.dts-row--session')].some((row) => row.textContent.includes('游离会话')), 'it lives in the virtual group');
  assert.equal(virtual.getAttribute('draggable') !== 'true', true, '未分组 cannot be dragged');
  assert.equal(virtual.querySelector('.dts-row__actions'), null, 'it offers no workspace actions');
  assert.equal(virtualGroup.querySelector('.dts-row--topic'), null, '未分组 shows no group row');

  await act(async () => {
    virtualGroup.querySelector('.dts-row--session .dts-row__actions .dts-iconbtn').dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  await tick();
  assert.equal(document.querySelector('.dts-pop--menu').textContent.includes('移动到分组'), false, 'a session with no workspace cannot be moved to a topic');
});

test('sessions inside 未分组 reorder against its own full set, not an empty baseline', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  const base = sessionSource.getSnapshot();
  sessionSource.set({
    ...base,
    ids: [...base.ids, 'ses_stray_a', 'ses_stray_b'],
    byId: {
      ...base.byId,
      ses_stray_a: { id: 'ses_stray_a', displayTitle: '游离 A', cwd: 'D:/elsewhere', updatedAt: 1_700_000_002_000, blank: false },
      ses_stray_b: { id: 'ses_stray_b', displayTitle: '游离 B', cwd: 'D:/elsewhere', updatedAt: 1_700_000_001_000, blank: false },
    },
  });
  await mount();
  const rowFor = (title) => find('.dts-row--session', title);
  assert.equal([...container.querySelectorAll('.dts-row--session')].filter((row) => row.textContent.includes('游离 A')).length, 1, 'the virtual group renders the strays');

  await act(async () => {
    const start = new window.Event('dragstart', { bubbles: true });
    start.dataTransfer = makeDataTransfer(['ses_stray_a']);
    rowFor('游离 A').dispatchEvent(start);
    const drop = new window.Event('drop', { bubbles: true, cancelable: true });
    drop.dataTransfer = makeDataTransfer(['ses_stray_a']);
    rowFor('游离 B').dispatchEvent(drop);
  });
  await tick();

  const saved = JSON.parse(window.localStorage.getItem('dsh-better-workspace:prefs:v1')).sessionOrder;
  assert.deepEqual(saved.__ungrouped__, ['ses_stray_b', 'ses_stray_a'], 'the drop persists the reordered bucket');
  assert.deepEqual(saved[WORKSPACE], undefined, 'and does not invent a workspace order');
  const titles = [...container.querySelectorAll('.dts-row--session')]
    .map((row) => row.querySelector('.dts-row__text').textContent)
    .filter((title) => title.startsWith('游离'));
  assert.deepEqual(titles, ['游离 B', '游离 A'], 'the rendered rows follow the saved order');
});

test('archived orphans stay out of the virtual 未分组 group', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  const base = sessionSource.getSnapshot();
  sessionSource.set({
    ...base,
    ids: [...base.ids, 'ses_orphan'],
    byId: {
      ...base.byId,
      ses_orphan: { id: 'ses_orphan', displayTitle: '归档孤儿', cwd: '', updatedAt: Date.now(), blank: false },
    },
  });
  workspaceSource.set({ ...workspaceSource.getSnapshot(), archivedSessionIds: ['ses_orphan'] });
  window.localStorage.setItem('dsh-better-workspace:prefs:v1', JSON.stringify({ showArchived: true }));
  await mount();
  assert.equal(find('.dts-row--group', '未分组'), undefined, 'archived orphans do not create a virtual workspace');
  assert.equal(find('.dts-row--session', '归档孤儿'), undefined, 'the orphan is not smuggled into any tree');
});

test('dragging a workspace can drop just above the virtual 未分组 group', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  const base = sessionSource.getSnapshot();
  sessionSource.set({
    ...base,
    ids: [...base.ids, 'ses_stray'],
    byId: { ...base.byId, ses_stray: { id: 'ses_stray', displayTitle: '游离会话', cwd: 'D:/elsewhere', updatedAt: Date.now(), blank: false } },
  });
  const snapshot = workspaceSource.getSnapshot();
  workspaceSource.set({
    ...snapshot,
    items: [...snapshot.items, { workspaceId: 'ws_two', path: 'D:/work/two', title: 'Two', sessionIds: [], createdAt: 2, updatedAt: 2 }],
  });
  await mount();
  const groups = [...container.querySelectorAll('.dts-row--group')];
  const source = groups[0];
  const lastReal = groups[1];
  assert.ok(groups[2].textContent.includes('未分组'));
  await act(async () => {
    const start = new window.Event('dragstart', { bubbles: true });
    start.dataTransfer = makeDataTransfer([]);
    source.dispatchEvent(start);
  });
  await tick();
  const tail = container.querySelector('.dts-drop-tail');
  assert.ok(tail, 'a workspace-sized end strip appears');
  assert.ok(tail.nextElementSibling.querySelector('.dts-row--group').textContent.includes('未分组'), 'it sits directly above 未分组');

  const overVirtual = new window.Event('dragover', { bubbles: true, cancelable: true });
  overVirtual.dataTransfer = makeDataTransfer([]);
  await act(async () => groups[2].dispatchEvent(overVirtual));
  assert.equal(overVirtual.defaultPrevented, false, '未分组 itself stays outside the workspace order');

  const over = new window.Event('dragover', { bubbles: true, cancelable: true });
  over.dataTransfer = makeDataTransfer([]);
  await act(async () => tail.dispatchEvent(over));
  assert.equal(over.defaultPrevented, true, 'the strip accepts the drop');
  assert.equal(lastReal.classList.contains('is-dropafter'), true, 'the line marks the end of the draggable workspaces');

  await act(async () => {
    const drop = new window.Event('drop', { bubbles: true, cancelable: true });
    drop.dataTransfer = makeDataTransfer([]);
    tail.dispatchEvent(drop);
  });
  await tick();
  const saved = JSON.parse(window.localStorage.getItem('dsh-better-workspace:prefs:v1')).workspaceOrder;
  assert.deepEqual(saved, ['ws_two', WORKSPACE], 'the dropped workspace lands above 未分组');
  assert.ok(!saved.includes('__ungrouped__'), 'the virtual group never enters the workspace order');
});

test('a clipped session title scrolls once to its end and rests there', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  await mount();
  const proto = window.HTMLElement.prototype;
  const scrollWidth = Object.getOwnPropertyDescriptor(proto, 'scrollWidth');
  const clientWidth = Object.getOwnPropertyDescriptor(proto, 'clientWidth');
  Object.defineProperty(proto, 'scrollWidth', { configurable: true, get: () => 240 });
  Object.defineProperty(proto, 'clientWidth', { configurable: true, get: () => 120 });
  try {
    const row = find('.dts-row--session', '会话 1');
    await act(async () => {
      row.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true, view: window }));
    });
    await tick();
    const text = row.querySelector('.dts-row__text');
    const scroll = row.querySelector('.dts-row__scroll');
    assert.ok(text.classList.contains('is-marquee'), 'a title wider than its box reveals its tail');
    // The reveal crawls at the native 0.03 px/ms; wait long enough for the 120px range to be
    // exhausted, then assert it *rests* at the far edge instead of bouncing back.
    await tick(4600);
    assert.equal(scroll.style.transform, 'translateX(-120px)', 'the reveal stops at the far edge');
    assert.equal(scroll.dataset.revealed, '', 'and marks itself as fully revealed');
    const settled = scroll.style.transform;
    await tick(300);
    assert.equal(scroll.style.transform, settled, 'it does not scroll back and forth');
    await act(async () => {
      row.dispatchEvent(new window.MouseEvent('mouseout', { bubbles: true, view: window }));
    });
    await tick();
    assert.equal(row.querySelector('.dts-row__text').classList.contains('is-marquee'), false, 'and stops on leave');
    assert.equal(scroll.style.transform, '', 'leaving returns it to the start in one step');
  } finally {
    if (scrollWidth) Object.defineProperty(proto, 'scrollWidth', scrollWidth);
    else delete proto.scrollWidth;
    if (clientWidth) Object.defineProperty(proto, 'clientWidth', clientWidth);
    else delete proto.clientWidth;
  }
});

test('a title clipped by less than the dead zone does not move', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  await mount();
  const proto = window.HTMLElement.prototype;
  const scrollWidth = Object.getOwnPropertyDescriptor(proto, 'scrollWidth');
  const clientWidth = Object.getOwnPropertyDescriptor(proto, 'clientWidth');
  // 4px of overflow: below the native 8px threshold, where a reveal reads as jitter.
  Object.defineProperty(proto, 'scrollWidth', { configurable: true, get: () => 124 });
  Object.defineProperty(proto, 'clientWidth', { configurable: true, get: () => 120 });
  try {
    const row = find('.dts-row--session', '会话 1');
    await act(async () => {
      row.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true, view: window }));
    });
    await tick();
    assert.equal(row.querySelector('.dts-row__text').classList.contains('is-marquee'), false);
  } finally {
    if (scrollWidth) Object.defineProperty(proto, 'scrollWidth', scrollWidth);
    else delete proto.scrollWidth;
    if (clientWidth) Object.defineProperty(proto, 'clientWidth', clientWidth);
    else delete proto.clientWidth;
  }
});

test('the collapsed rail routes its new session and search through the panel', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  await mount();
  assert.ok(container.querySelector('.dts-header'), 'the panel starts visible');

  const frame = document.querySelector('[data-shell-overlay]').parentElement;
  frame.setAttribute('data-sidebar-collapsed', '');
  await tick(200);
  assert.equal(container.querySelector('.dts-header'), null, 'the panel steps aside for the rail');

  const railButton = (className, label) => {
    const button = document.createElement('button');
    button.className = className;
    button.setAttribute('aria-label', label);
    frame.append(button);
    return button;
  };
  const newSessionButton = railButton('_2H3hWW_newSession', '新建会话');
  let hostNewSessionClicks = 0;
  newSessionButton.addEventListener('click', () => { hostNewSessionClicks += 1; });
  await act(async () => {
    newSessionButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  });
  await tick();
  assert.equal(hostNewSessionClicks, 0, 'the rail’s new session is fully handled by the plugin');
  assert.equal(toggleSidebarCalls, 1, 'the rail’s new session reopens the sidebar first');
  assert.equal(startSessionCalls, 1, 'and then runs the host command the panel re-files');
  assert.equal(startSessionArgs[0], undefined, 'without a workspace hint, exactly like the expanded button');

  const addWorkspaceButton = railButton('_2H3hWW_addWorkspace', '添加工作区');
  let hostAddWorkspaceClicks = 0;
  addWorkspaceButton.addEventListener('click', () => { hostAddWorkspaceClicks += 1; });
  await act(async () => {
    addWorkspaceButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  });
  await tick();
  assert.equal(hostAddWorkspaceClicks, 1, 'the host’s own picker flow still receives the click');
  assert.equal(toggleSidebarCalls, 1, 'the sidebar stays collapsed while the rail picker is open');

  const baseWorkspace = workspaceSource.getSnapshot();
  await act(async () => {
    workspaceSource.set({
      ...baseWorkspace,
      items: [...baseWorkspace.items, { workspaceId: 'ws_added', path: 'D:/work/added', title: 'Added', sessionIds: [], createdAt: 3, updatedAt: 3 }],
    });
  });
  await tick();
  assert.equal(toggleSidebarCalls, 2, 'and reopens as soon as the new workspace lands');

  const searchButton = railButton('_9lTDKa_searchButton', '搜索会话');
  await act(async () => {
    searchButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  });
  await tick();
  assert.equal(toggleSidebarCalls, 3, 'and its search reopens the sidebar');

  frame.removeAttribute('data-sidebar-collapsed');
  await tick(200);
  await tick(300);
  assert.ok(container.querySelector('.dts-header__search'), 'where the panel opens its own search');
});

test('a cancelled rail add does not expand for a later workspace addition', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  await mount();
  const frame = document.querySelector('[data-shell-overlay]').parentElement;
  frame.setAttribute('data-sidebar-collapsed', '');
  await tick(200);
  const railButton = (className, label) => {
    const button = document.createElement('button');
    button.className = className;
    button.setAttribute('aria-label', label);
    frame.append(button);
    return button;
  };
  const add = railButton('_2H3hWW_addWorkspace', '添加工作区');
  await act(async () => {
    add.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  });
  await tick();
  assert.equal(toggleSidebarCalls, 0, 'the picker stays in the rail');

  const newSession = railButton('_2H3hWW_newSession', '新建会话');
  await act(async () => {
    newSession.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  });
  await tick();
  assert.equal(toggleSidebarCalls, 1, 'the explicit new session expands once');

  const base = workspaceSource.getSnapshot();
  await act(async () => {
    workspaceSource.set({
      ...base,
      items: [...base.items, { workspaceId: 'ws_late', path: 'D:/work/late', title: 'Late', sessionIds: [], createdAt: 3, updatedAt: 3 }],
    });
  });
  await tick();
  assert.equal(toggleSidebarCalls, 1, 'the abandoned add intent was cleared by the new session');
});

test('the create dialog offers the host emoji list and submits the chosen glyph', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  responseOverrides[`${API}/topics/create`] = () => ({ ok: true, result: { revision: 9, result: { topic: { id: 'tp_new', name: 'x' } } } });
  await mount();
  await openTopicCreateDialog();
  const dialog = document.querySelector('.dts-dialog');
  assert.ok(dialog.classList.contains('dts-dialog--settings'), 'the create dialog uses the settings shell');
  assert.ok(dialog.querySelector('.dts-dialog__description'), 'with a settings-style introduction');
  assert.ok(dialog.textContent.includes('工作区'), 'and names the workspace field');
  const swatches = [...document.querySelectorAll('.dts-emojis__item')];
  assert.equal(swatches.length, 5, 'four host glyphs plus the no-marker option');
  const none = swatches[0].querySelector('.dts-dash');
  assert.ok(none, 'the first choice clears the marker');
  assert.equal(none.textContent, '-', 'and shows the - symbol');
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

test('creating a group from the workspace menu expands, scrolls and highlights it', async () => {
  let created = false;
  responseOverrides[`${API}/state`] = () => {
    const state = stateResult();
    if (created) {
      state.result.revision = 9;
      state.result.workspaces[WORKSPACE].topics = [
        { id: 'tp_new', name: '新建组', emoji: '', order: -2, createdAt: 9 },
        ...state.result.workspaces[WORKSPACE].topics,
      ];
    }
    return state;
  };
  responseOverrides[`${API}/topics/create`] = () => {
    created = true;
    return { ok: true, result: { revision: 9, result: { topic: { id: 'tp_new', name: '新建组', emoji: '' } } } };
  };
  window.localStorage.setItem('dsh-better-workspace:prefs:v1', JSON.stringify({ collapsedWorkspaces: [WORKSPACE] }));
  const scrolled = [];
  window.Element.prototype.scrollIntoView = function scrollIntoView(options) {
    scrolled.push({ topic: this.getAttribute('data-dts-topic'), options });
  };
  await mount();
  assert.equal(find('.dts-row--group').getAttribute('aria-expanded'), 'false', 'the workspace starts collapsed');

  await openTopicCreateDialog();
  const input = document.querySelector('.dts-dialog .dts-input');
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '新建组');
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  await act(async () => {
    [...document.querySelectorAll('.dts-dialog .dts-btn')]
      .find((node) => node.textContent.trim() === '创建')
      .dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  await tick(80);

  assert.equal(find('.dts-row--group').getAttribute('aria-expanded'), 'true', 'the workspace holding the new group is expanded');
  const row = find('.dts-row--topic', '新建组');
  assert.ok(row, 'the new group is in the tree');
  assert.equal(row.classList.contains('is-revealed'), true, 'and carries the landing highlight');
  assert.deepEqual(scrolled.at(-1), { topic: 'tp_new', options: { block: 'nearest' } }, 'the row was scrolled into view');
  await tick(1700);
  assert.equal(find('.dts-row--topic', '新建组').classList.contains('is-revealed'), false, 'the highlight retires on its own');
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

test('a permanent delete re-reads the host session list and leaves a deleted open session', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  const baseSessions = sessionSource.getSnapshot();
  sessionSource.set({ ...baseSessions, current: 'ses_1' });
  responseOverrides[`${API}/delete/preview`] = () => ({
    ok: true,
    result: {
      items: [{ sessionId: 'ses_1', blockers: [] }],
      rootAvailable: true,
      hardBlocked: false,
      running: 0,
      subagents: 0,
      bytes: 1024,
    },
  });
  responseOverrides[`${API}/delete/execute`] = () => ({
    ok: true,
    result: {
      summary: { deleted: 1, skipped: 0, failed: 0, subagents: 0 },
      items: [{ sessionId: 'ses_1', status: 'deleted', code: null, error: null, notes: [], subagentsRemoved: [] }],
    },
  });
  await mount();
  const row = find('.dts-row--session', '会话 1');
  await act(async () => {
    row.querySelector('.dts-row__act').dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  await tick();
  await act(async () => {
    [...document.querySelectorAll('.dts-pop--menu .dts-menu__item')]
      .find((node) => node.textContent.trim() === '永久删除')
      .dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  await tick();
  const ack = document.querySelector('.dts-ack input');
  assert.ok(ack, 'the delete dialog reached its ready phase');
  await act(async () => {
    ack.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  });
  await tick();
  const confirm = [...document.querySelectorAll('.dts-dialog .dts-btn')].find((node) => node.textContent.trim() === '永久删除');
  assert.ok(confirm && !confirm.disabled, 'the acknowledged dialog can delete');
  await act(async () => {
    confirm.dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  await tick();
  assert.equal(sessionRefreshCalls, 1, 'the deleted row cannot linger until a manual F5');
  assert.equal(startSessionCalls, 1, 'deleting the open session starts a fresh one');
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

test('clicking the menu trigger again closes the popover', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  await mount();
  const trigger = find('.dts-header .dts-iconbtn[aria-label="创建"]');
  assert.ok(trigger, 'the create trigger exists');

  await act(async () => {
    trigger.dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  await tick();
  assert.ok(document.querySelector('.dts-pop--create'), 'the first click opens the menu');

  // A real pointer fires pointerdown before click. Treating the trigger as "outside" closed
  // the menu on pointerdown and the click reopened it, so it could never be dismissed.
  await act(async () => {
    trigger.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
    trigger.dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  await tick();
  assert.equal(document.querySelector('.dts-pop--create'), null, 'the second click closes it');
});

test('the rename dialog gives focus back to the element that opened it', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  await mount();
  const row = find('.dts-row--session', '会话 1');
  // The row is a focusable treeitem; make it the active element the way a click would.
  row.focus();
  assert.equal(document.activeElement, row, 'the row holds focus before the dialog opens');

  await act(async () => {
    row.dispatchEvent(new window.Event('dblclick', { bubbles: true }));
  });
  await tick();
  assert.ok(document.querySelector('.dts-dialog'), 'the dialog opened');

  await act(async () => {
    document.querySelector('.dts-dialog').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  await tick();
  assert.equal(document.querySelector('.dts-dialog'), null, 'Escape closes it');
  // Before the fix the restore target was the dialog's own input, so focus fell to <body>.
  assert.notEqual(document.activeElement, document.body, 'focus does not fall back to the body');
  assert.equal(document.activeElement, row, 'and it returns to the row');
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

test('saving a session rename goes through the host sessions service', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  await mount();
  const row = find('.dts-row--session', '会话 1');
  await act(async () => {
    row.dispatchEvent(new window.Event('dblclick', { bubbles: true }));
  });
  await tick();
  const dialog = document.querySelector('.dts-dialog');
  const input = dialog.querySelector('.dts-input');
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '改名后的会话');
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  await act(async () => {
    [...dialog.querySelectorAll('.dts-dialog__foot .dts-btn')]
      .find((node) => node.textContent.trim() === '保存')
      .dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  await tick();
  // 0.2.1's `UiWorkspace` has no `renameSession`: the host dialog uses the sessions service.
  // Requiring the missing method made every save fail with "this host build cannot rename".
  assert.deepEqual(sessionRenameCalls, [['ses_1', 'workspaceOperation']], 'the official service carries the rename');
  assert.deepEqual(sessionRenameTitles, ['改名后的会话']);
  assert.equal(document.querySelector('.dts-dialog'), null, 'and the dialog closes after a successful save');
});

test('the composer chip opens a dialog rather than a menu', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  await mount();
  const chip = findAnywhere('.dts-composer-topic');
  assert.ok(chip);
  assert.equal(chip.getAttribute('aria-haspopup'), 'dialog');
  await act(async () => {
    chip.dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  await tick();
  assert.equal(findAnywhere('.dts-pop--composer')?.getAttribute('role'), 'dialog');
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

test('creating a group from the composer files the open session into it', async () => {
  let state = stateResult();
  responseOverrides[`${API}/state`] = () => state;
  responseOverrides[`${API}/topics/create`] = () => {
    state.result.revision = 9;
    state.result.workspaces[WORKSPACE].topics = [
      { id: 'tp_new', name: '新建组', emoji: '', order: -2, createdAt: 9 },
      ...state.result.workspaces[WORKSPACE].topics,
    ];
    return { ok: true, result: { revision: 9, result: { topic: { id: 'tp_new', name: '新建组', emoji: '' } } } };
  };
  responseOverrides[`${API}/assign`] = (body) => {
    state.result.revision = 10;
    state.result.workspaces[WORKSPACE].assignments = {
      ...state.result.workspaces[WORKSPACE].assignments,
      ...Object.fromEntries((body.sessionIds ?? []).map((id) => [id, body.topicId])),
    };
    return { ok: true, result: { revision: 10, result: { changed: 1 } } };
  };
  await mount();
  const chip = findAnywhere('.dts-composer-topic');
  assert.match(chip.textContent, /设计/, 'the bar starts on the open session topic');
  await act(async () => {
    chip.dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  await tick();
  const add = [...document.querySelectorAll('.dts-pop--composer .dts-pop__foot .dts-menu__item')]
    .find((node) => node.textContent.includes('新建分组'));
  assert.ok(add, 'the bar offers creating a group');
  await act(async () => {
    add.dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  await tick();
  const input = document.querySelector('.dts-dialog .dts-input');
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '新建组');
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  await act(async () => {
    [...document.querySelectorAll('.dts-dialog .dts-btn')]
      .find((node) => node.textContent.trim() === '创建')
      .dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  await tick(80);
  const assign = calls.find((call) => call.url.endsWith('/assign'));
  assert.ok(assign, 'the open session is filed after the create');
  assert.equal(assign.body.workspaceId, WORKSPACE, 'into the workspace the session belongs to');
  assert.deepEqual(assign.body.sessionIds, ['ses_0'], 'the open session is the one re-filed');
  assert.equal(assign.body.topicId, 'tp_new', 'and the new group is its destination');
  assert.match(findAnywhere('.dts-composer-topic').textContent, /新建组/, 'the bar switches to the new group');
});

test('the composer topic chip survives the sidebar collapsing to the rail', async () => {
  let state = stateResult();
  responseOverrides[`${API}/state`] = () => state;
  responseOverrides[`${API}/assign`] = () => {
    state = stateResult();
    state.result.workspaces[WORKSPACE].assignments = {};
    return { ok: true, result: { revision: 6, result: { changed: 1 } } };
  };
  await mount();
  assert.ok(findAnywhere('.dts-composer-topic'), 'the chip starts in the composer');

  const frame = document.querySelector('.BynINW_frame');
  await act(async () => {
    frame.setAttribute('data-sidebar-collapsed', '');
  });
  await tick(1200);
  assert.equal(find('.dts-overlay'), undefined, 'the panel itself steps aside for the rail');

  const chip = findAnywhere('.dts-composer-topic');
  assert.ok(chip, 'the composer chip belongs to the composer, not the hidden panel');
  assert.match(chip.textContent, /设计/, 'and keeps the open session topic');
  await act(async () => {
    chip.dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  await tick();
  const item = [...document.querySelectorAll('.dts-pop--composer .dts-menu__item')].find((node) => node.textContent.includes('默认分组'));
  assert.ok(item, 'the topic menu still opens while the panel is hidden');
  await act(async () => {
    item.dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  await tick();
  const assign = calls.find((call) => call.url.endsWith('/assign'));
  assert.equal(assign.body.topicId, 'tp_default', 'the open session can still be re-filed from the rail');
  assert.match(findAnywhere('.dts-composer-topic').textContent, /默认分组/, 'and the chip reflects the new topic without reopening the sidebar');
});

test('a page that starts in rail still mounts the composer chip', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  document.querySelector('.BynINW_frame').setAttribute('data-sidebar-collapsed', '');
  await mount();
  await tick(300);
  assert.equal(find('.dts-overlay'), undefined, 'the panel never paints while the rail owns the sidebar');
  const chip = findAnywhere('.dts-composer-topic');
  assert.ok(chip, 'the chip is still seated in the composer');
  assert.match(chip.textContent, /设计/, 'and the sidecar was read for it despite the initial rail');
  assert.ok(calls.some((call) => call.url.endsWith(`${API}/state`)), 'the chip triggers the first sidecar read');
});

test('the hidden chip follows a different open session instead of keeping the old one', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  await mount();
  await act(async () => {
    document.querySelector('.BynINW_frame').setAttribute('data-sidebar-collapsed', '');
  });
  await tick(1200);
  assert.match(findAnywhere('.dts-composer-topic').textContent, /设计/, 'ses_0 is filed into 设计');

  const snapshot = sessionSource.getSnapshot();
  await act(async () => {
    sessionSource.set({ ...snapshot, current: 'ses_1' });
  });
  await tick(100);
  assert.match(findAnywhere('.dts-composer-topic').textContent, /默认分组/, 'the chip now describes ses_1, not the stale one');
});

test('the composer chip identifies the workspace by the open session, not a duplicated title', async () => {
  const state = stateResult();
  state.result.workspaces[WORKSPACE].assignments = {};
  state.result.workspaces.ws_two = {
    topics: [
      { id: 'tp_default', name: '默认分组', emoji: '', order: -1, createdAt: 0, system: true },
      { id: 'tp_two', name: '二组', emoji: '', order: 0, createdAt: 2 },
    ],
    assignments: { ses_0: 'tp_two' },
  };
  const baseSessions = sessionSource.getSnapshot();
  sessionSource.set({
    ...baseSessions,
    byId: { ...baseSessions.byId, ses_0: { ...baseSessions.byId.ses_0, cwd: 'D:/work/two' } },
  });
  const baseWorkspaces = workspaceSource.getSnapshot();
  workspaceSource.set({
    ...baseWorkspaces,
    items: [
      { workspaceId: WORKSPACE, path: 'D:/work/one', title: 'One', sessionIds: ['ses_1', 'ses_2'], createdAt: 1, updatedAt: 1 },
      { workspaceId: 'ws_two', path: 'D:/work/two', title: 'One', sessionIds: ['ses_0'], createdAt: 2, updatedAt: 2 },
    ],
  });
  responseOverrides[`${API}/state`] = () => state;
  responseOverrides[`${API}/assign`] = () => ({ ok: true, result: { revision: 6, result: { changed: 1 } } });
  await mount();

  const chip = findAnywhere('.dts-composer-topic');
  assert.match(chip.textContent, /二组/, 'the session record wins over the ambiguous picker title');
  await act(async () => {
    chip.dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  await tick();
  const item = [...document.querySelectorAll('.dts-pop--composer .dts-menu__item')].find((node) => node.textContent.includes('默认分组'));
  await act(async () => {
    item.dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  await tick();
  const assign = calls.find((call) => call.url.endsWith('/assign'));
  assert.equal(assign.body.workspaceId, 'ws_two', 'the write goes to the workspace that actually owns the session');
});

test('keyboard activation inside a row does not also open or collapse the row', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  await mount();
  const sessionRow = find('.dts-row--session', '会话 1');
  const menuButton = sessionRow.querySelector('.dts-row__act');
  menuButton.focus();
  await act(async () => {
    menuButton.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  });
  await tick();
  assert.equal(openSessionCalls, 0, 'Enter on the ⋯ button must not open the session');

  const topic = find('.dts-row--topic', '设计');
  const plus = topic.querySelector('.dts-row__actions .dts-iconbtn[title="在此分组下新建会话"]');
  plus.focus();
  await act(async () => {
    plus.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  });
  await tick();
  assert.equal(topic.className.includes('is-collapsed'), false, 'Enter on the topic + must not collapse the topic');
});

test('double-clicking a row action does not fall through to the row rename', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  await mount();
  const row = find('.dts-row--session', '会话 1');
  const menuButton = row.querySelector('.dts-row__act');
  await act(async () => {
    menuButton.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }));
  });
  await tick();
  assert.equal(document.querySelector('.dts-dialog'), null, 'the rename dialog stays closed');
});

test('a rejected async session start does not claim a later blank into the topic', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  responseOverrides[`${API}/assign`] = () => ({ ok: true, result: { revision: 6, result: { changed: 1 } } });
  startSessionImpl = async () => { throw new Error('host refused'); };
  await mount();
  const plus = find('.dts-row--topic', '设计').querySelector('.dts-row__actions .dts-iconbtn[title="在此分组下新建会话"]');
  await act(async () => {
    plus.dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  await tick();

  const base = sessionSource.getSnapshot();
  await act(async () => {
    sessionSource.set({
      ...base,
      ids: [...base.ids, 'ses_later'],
      byId: {
        ...base.byId,
        ses_later: { id: 'ses_later', displayTitle: '', cwd: 'D:/work/one', updatedAt: Date.now(), blank: true, retainedBy: { mainView: 1 } },
      },
    });
  });
  await tick(120);
  assert.equal(calls.some((call) => call.url.endsWith('/assign')), false, 'the failed arm was cleared, so the new blank stays unfiled');
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
    // Stale host data: a session pinned before it was archived must not keep pin chrome.
    pinnedSessionIds: ['ses_arch'],
    items: [{ ...workspaceSource.getSnapshot().items[0], sessionIds: [...base.ids, 'ses_arch'] }],
  });
  window.localStorage.setItem('dsh-better-workspace:prefs:v1', JSON.stringify({ showArchived: true }));
  await mount();
  const row = find('.dts-section--archived .dts-row--session', '归档项');
  assert.ok(row, 'the archived bucket is visible');
  assert.equal(row.querySelector('.dts-row__pin'), null, 'archived rows carry no pin marker');
  assert.deepEqual(
    [...row.querySelectorAll('.dts-row__act')].map((node) => node.getAttribute('title')),
    ['会话操作', '取消归档'],
    'archived rows carry no pin button',
  );
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

/**
 * A hidden panel used to keep working: the two `return null`s sit after the hooks, so a
 * rail-collapsed overlay still held the session/status/schedule subscriptions, re-rendered on
 * every host list publish and kept its minute timer armed — all to paint nothing.
 *
 * These count *live subscribers* rather than trusting a render count, because a subscription
 * that is merely unused still costs one wakeup per host publish. The one exception is the
 * session list: the composer chip outlives the rail and must follow the open session.
 */
test('a hidden panel releases the status subscription and keeps only the session list the chip needs', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  await mount();
  assert.ok(find('.dts-overlay'), 'the panel starts on screen');
  assert.ok(sessionSource.listenerCount() > 0, 'the session list is observed while visible');
  assert.ok(sessionStatusSource.listenerCount() > 0, 'the status map is observed while visible');

  await act(async () => {
    document.querySelector('[class*="_regionArea"]').classList.add('_9lTDKa_root');
    document.querySelector('.BynINW_frame').setAttribute('data-sidebar-collapsed', '');
  });
  await tick(1200);
  assert.equal(find('.dts-overlay'), undefined, 'the cover steps aside in rail mode');
  assert.equal(sessionSource.listenerCount(), 1, 'the chip keeps following the open session while hidden');
  assert.equal(sessionStatusSource.listenerCount(), 0, 'the status subscription is released while hidden');
  // The rail bridge reads the workspace list to notice "添加工作区", so that one must stay.
  assert.ok(workspaceSource.listenerCount() > 0, 'the workspace list stays observed: the rail bridge needs it');
  assert.ok(findAnywhere('.dts-composer-topic'), 'the chip is what keeps that one subscription alive');

  const snapshot = sessionSource.getSnapshot();
  await act(async () => {
    sessionSource.set({ ...snapshot, byId: { ...snapshot.byId } });
  });
  await tick(60);

  await act(async () => {
    document.querySelector('[class*="_regionArea"]').classList.remove('_9lTDKa_root');
    document.querySelector('.BynINW_frame').removeAttribute('data-sidebar-collapsed');
  });
  await tick(300);
  assert.ok(find('.dts-overlay'), 'the cover comes back');
  assert.ok(sessionSource.listenerCount() > 0, 'the session list is observed again');
  assert.ok(find('.dts-row--session', '会话 0'), 'and paints the rows it had before hiding');
  assert.ok(find('.dts-tree'), 'the tree is intact, not blanked');
});

test('without a composer seat the hidden panel releases the session list too', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  await mount();
  await act(async () => {
    document.querySelector('.BynINW_frame').setAttribute('data-sidebar-collapsed', '');
  });
  await tick(1200);
  assert.equal(find('.dts-overlay'), undefined);
  assert.equal(sessionSource.listenerCount(), 1, 'the chip is still seated');

  await act(async () => {
    document.querySelector('.Hqq-bq_workspaceRow').remove();
  });
  await tick(400);
  assert.equal(findAnywhere('.dts-composer-topic'), undefined, 'the chip lost its seat');
  assert.equal(sessionSource.listenerCount(), 0, 'so the last session-list subscription goes away');
});

test('hiding the panel issues no sidecar read and no catalog re-read', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  scheduleCatalog = [];
  await mount();
  const stateReads = () => calls.filter((call) => call.url.endsWith(`${API}/state`)).length;
  // Baselines are taken BEFORE hiding: the hide edge itself is allowed one teardown, so a
  // baseline captured afterwards would silently absorb the traffic being asserted.
  assert.ok(stateReads() >= 1, 'the document is read on the first paint');
  assert.equal(scheduleReaders, 1, 'the catalog is read once while on screen');
  assert.equal(scheduleSubscribers.size, 1, 'the catalog follows host invalidations while visible');

  await act(async () => {
    document.querySelector('[class*="_regionArea"]').classList.add('_9lTDKa_root');
    document.querySelector('.BynINW_frame').setAttribute('data-sidebar-collapsed', '');
  });
  await tick(1200);
  assert.equal(find('.dts-overlay'), undefined, 'the cover steps aside in rail mode');

  const hiddenReads = stateReads();
  const hiddenCatalogReads = scheduleReaders;
  const hiddenSubscribers = scheduleSubscribers.size;

  // Idle long enough that a live minute timer or a retry would have to show up.
  await tick(1500);
  assert.equal(stateReads(), hiddenReads, 'a hidden panel issues no document reads');
  assert.equal(scheduleReaders, hiddenCatalogReads, 'and does not keep polling the catalog');
  assert.equal(scheduleSubscribers.size, hiddenSubscribers, 'and released its host invalidation');

  await act(async () => {
    document.querySelector('[class*="_regionArea"]').classList.remove('_9lTDKa_root');
    document.querySelector('.BynINW_frame').removeAttribute('data-sidebar-collapsed');
  });
  await tick(400);
  assert.ok(stateReads() > hiddenReads, 'returning re-reads the document instead of trusting a stale copy');
  assert.ok(scheduleReaders > hiddenCatalogReads, 'and re-reads the catalog instead of showing stale marks');
  assert.equal(scheduleSubscribers.size, 1, 'and re-attaches exactly one invalidation');
});

test('a topic filter resolves in the workspace it was paired with', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  const extra = { workspaceId: 'ws_two', path: 'D:/work/two', title: 'Two', sessionIds: [], createdAt: 2, updatedAt: 2 };
  workspaceSource.set({ ...workspaceSource.getSnapshot(), items: [...workspaceSource.getSnapshot().items, extra] });
  // `tp_default` exists in every workspace, so the id alone is ambiguous: an id-only lookup
  // lands on whichever workspace comes first, which is not the one the user filtered.
  window.localStorage.setItem('dsh-better-workspace:prefs:v1', JSON.stringify({ topicFilter: 'tp_default', topicFilterWorkspace: 'ws_two' }));
  await mount();
  await tick(60);
  const groups = [...container.querySelectorAll('.dts-row--group')];
  assert.equal(groups.length, 1, 'the filter scopes to a single workspace');
  assert.ok(groups[0].textContent.includes('Two'), 'and it is the paired one, not the first owner of that id');
});

test('the delete-group confirmation counts the document, not the visible rows', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  window.localStorage.setItem('dsh-better-workspace:prefs:v1', JSON.stringify({ showArchived: true }));
  // `ses_0` is the only member of 设计. Archiving it moves the row into the archived bucket
  // while its assignment stays, so the group renders empty but still holds one session.
  workspaceSource.set({ ...workspaceSource.getSnapshot(), archivedSessionIds: ['ses_0'] });
  await mount();
  await tick(60);
  const topic = find('.dts-row--topic', '设计');
  assert.equal(topic.querySelector('.dts-row__count').textContent, '0', 'the group renders no live rows');
  const menu = topic.querySelector('.dts-row__actions .dts-iconbtn[aria-label="更多操作"]');
  await act(async () => {
    menu.dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  await tick();
  await act(async () => {
    [...document.querySelectorAll('.dts-pop--menu .dts-menu__item')]
      .find((node) => node.textContent.includes('删除分组'))
      .dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  await tick();
  const body = document.querySelector('.dts-dialog__text').textContent;
  assert.ok(body.includes('1 个会话'), `the confirmation names the real member count: ${body}`);
});

test('a collapsed bucket drops its rows from the DOM once the transition ends', async () => {
  responseOverrides[`${API}/state`] = stateResult;
  await mount();
  const section = find('.dts-row--topic', '设计').parentElement;
  const header = section.querySelector('.dts-row--topic');
  const rows = () => section.querySelectorAll('.dts-row--session').length;
  assert.equal(rows(), 1, 'the group starts expanded with its row mounted');

  await act(async () => {
    header.dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  await tick(60);
  assert.equal(rows(), 1, 'the row stays mounted while the height animates');
  await tick(220);
  assert.equal(rows(), 0, 'and leaves the DOM afterwards, so a collapsed workspace costs no layout');

  await act(async () => {
    header.dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  await tick(40);
  assert.equal(rows(), 1, 'expanding mounts it again without waiting for a timer');
});
