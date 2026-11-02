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
