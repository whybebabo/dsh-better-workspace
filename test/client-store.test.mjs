/**
 * Client store lifecycle: teardown and request timeouts.
 *
 * The panel tests load the built bundle in a full JSDOM; these cases only need the store and a
 * fake transport, so they stay focused on the two failure paths that used to outlive the
 * component: a load that fails after `dispose()` and a host that never answers.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html lang="en"><body></body></html>', { url: 'http://127.0.0.1:3080/' });
global.window = dom.window;
global.document = dom.window.document;
global.localStorage = dom.window.localStorage;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A fetch that only settles when aborted, so the test controls the timing. */
function hangingFetch(urls) {
  return (url, options) => new Promise((resolve, reject) => {
    urls.push(String(url));
    const signal = options?.signal;
    const fail = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    if (signal?.aborted) fail();
    else signal?.addEventListener('abort', fail, { once: true });
  });
}

test('dispose aborts an in-flight state read and never schedules another', async () => {
  const urls = [];
  global.fetch = hangingFetch(urls);
  const { createPanelStore } = await import('../client/store.js');
  const store = createPanelStore();
  store.subscribe(() => {});

  const pending = store.load();
  await sleep(10);
  store.dispose();
  await pending;
  await sleep(700);

  const stateCalls = urls.filter((url) => url.endsWith('/state'));
  assert.equal(stateCalls.length, 1, 'the in-flight request is aborted and no retry follows teardown');
  assert.equal(await store.load(), false, 'a load started after teardown is a no-op');
  assert.equal(urls.filter((url) => url.endsWith('/state')).length, 1);
});

test('a host that never answers times out and enters the bounded retry', async () => {
  const urls = [];
  global.fetch = hangingFetch(urls);
  const { createPanelStore } = await import('../client/store.js');
  const store = createPanelStore({ stateTimeoutMs: 20 });
  store.subscribe(() => {});

  const pending = store.load();
  await sleep(650);
  assert.ok(
    urls.filter((url) => url.endsWith('/state')).length >= 2,
    'the timeout is treated as a transport failure and retried',
  );
  store.dispose();
  await pending;
  const afterDispose = urls.filter((url) => url.endsWith('/state')).length;
  await sleep(700);
  assert.equal(urls.filter((url) => url.endsWith('/state')).length, afterDispose, 'dispose stops the retry chain');
});

test('a hung write times out, clears busy and releases the serialized queue', async () => {
  const urls = [];
  global.fetch = (url, options = {}) => {
    const method = options.method ?? 'GET';
    urls.push({ method, url: String(url) });
    if (method === 'POST') {
      // A host that accepted the connection and never answers, but still honours the abort the
      // request timeout sends (a bare pending promise would make the abort a no-op).
      return new Promise((resolve, reject) => {
        const signal = options.signal;
        const fail = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        if (signal?.aborted) fail();
        else signal?.addEventListener('abort', fail, { once: true });
      });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { enabled: true, deleteAvailable: true, revision: 1, workspaces: {} } }),
    });
  };
  const { createPanelStore } = await import('../client/store.js');
  const store = createPanelStore({ requestTimeoutMs: 30 });
  store.subscribe(() => {});
  await store.load();

  await assert.rejects(
    store.assign({ workspaceId: 'ws_a', sessionIds: ['ses_a'], topicId: 'tp_default' }),
    (error) => error?.code === 'timeout',
  );
  assert.equal(store.getState().busy, null, 'busy is released after the timeout');
  assert.match(String(store.getState().error), /not confirmed/i, 'the banner says the outcome is unknown');

  await assert.rejects(
    store.updateTopic({ workspaceId: 'ws_a', topicId: 'tp_x', name: 'B' }),
    (error) => error?.code === 'timeout',
  );
  assert.equal(
    urls.filter((entry) => entry.method === 'POST').length,
    2,
    'the queue released the second write instead of blocking it forever',
  );
  store.dispose();
});

test('a store error code is localized before it reaches the UI', async () => {
  global.fetch = async () => ({
    ok: false,
    status: 400,
    json: async () => ({ ok: false, code: 'topic-name-taken', error: '该工作区已存在同名主题「X」' }),
  });
  const { createPanelStore } = await import('../client/store.js');
  const store = createPanelStore();
  store.subscribe(() => {});
  await assert.rejects(
    store.updateTopic({ workspaceId: 'ws_a', topicId: 'tp_x', name: 'X' }),
    (error) => error?.code === 'topic-name-taken' && /already has a topic/i.test(error.message),
  );
  assert.match(String(store.getState().error), /already has a topic/i);
  store.dispose();
});

test('a transient emoji failure is retried instead of permanently downgrading the picker', async () => {
  let emojiCalls = 0;
  global.fetch = async (url) => {
    if (String(url).includes('/emojis')) {
      emojiCalls += 1;
      if (emojiCalls === 1) {
        return { ok: false, status: 500, json: async () => ({ ok: false, code: 'internal', error: 'boom' }) };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { emojis: ['A', 'B'] } }) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { enabled: true, deleteAvailable: true, revision: 1, workspaces: {} } }),
    };
  };
  const { createPanelStore } = await import('../client/store.js');
  const store = createPanelStore({ stateTimeoutMs: 200 });
  store.subscribe(() => {});
  await store.load();
  await sleep(20);
  assert.deepEqual(store.getState().emojis, [], 'the first answer was a 500');

  await store.load();
  await sleep(20);
  assert.deepEqual(store.getState().emojis, ['A', 'B'], 'the next load retries the static table');
  assert.equal(emojiCalls, 2);
  store.dispose();
});
