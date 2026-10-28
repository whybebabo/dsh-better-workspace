/**
 * Route wiring for `lib/index.js`.
 *
 * The panel talks to these handlers; they were previously untested, so the loopback guard, the
 * method gate and the error mapping had no coverage at all. Everything here is exercised against
 * the real plugin entry with a fake `webServer`, not against a re-implementation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import plugin from '../lib/index.js';

const API = '/dsh-better-workspace/api';

/** Boots the plugin against a captured `webServer.register` and an adopted-services stub. */
async function boot({ home, services = {}, config } = {}) {
  const routes = [];
  const ctx = {
    inject(names, enter) {
      if (!names.includes('webServer')) return;
      enter({
        get: () => ({ register: (route) => { routes.push(route); return () => {}; } }),
        effect: () => {},
      });
    },
    get(name) {
      if (name in services) return services[name];
      return undefined;
    },
    logger: { warn() {} },
  };
  plugin(ctx, config ?? { enabled: true, storageHome: home });
  const find = (path) => routes.find((route) => route.path === path);
  return { routes, find };
}

/** Minimal req/res pair; the WebRoute contract is `handle(req, res)`. */
function fakeRequest({ method = 'POST', host = '127.0.0.1:3080', origin, contentType = 'application/json', body } = {}) {
  const headers = { host };
  if (origin !== undefined) headers.origin = origin;
  if (contentType !== null) headers['content-type'] = contentType;
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  return {
    method,
    headers,
    async *[Symbol.asyncIterator]() {
      yield* payload;
    },
  };
}

function fakeResponse() {
  const out = { status: 0, headers: {}, body: null };
  return {
    out,
    writeHead(status, extra) {
      out.status = status;
      Object.assign(out.headers, extra ?? {});
      return this;
    },
    end(text) {
      out.body = text === undefined ? null : String(text);
    },
  };
}

async function call(route, request) {
  const res = fakeResponse();
  await route.handler(request, res);
  return { status: res.out.status, headers: res.out.headers, json: res.out.body === null ? null : JSON.parse(res.out.body) };
}

async function withHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-routes-'));
  try {
    return await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test('every route is registered on both carriers', async () => {
  await withHome(async (home) => {
    const { routes } = await boot({ home });
    const paths = routes.map((route) => route.path).sort();
    assert.ok(paths.includes(`${API}/state`));
    assert.ok(paths.includes(`${API}/emojis`), 'the static glyph table has its own route');
    assert.ok(paths.includes(`${API}/sessions/adopt`), 'the membership-repair route is registered');
    assert.ok(paths.includes(`${API}/delete/preview`));
    assert.ok(paths.every((path) => path.startsWith(`${API}/`)), 'all routes share the plugin prefix');
  });
});

test('the adopt route refuses a cross-site request', async () => {
  await withHome(async (home) => {
    const { find } = await boot({ home, services: { workspaceRegistry: {}, sessionPersistence: {} } });
    const result = await call(find(`${API}/sessions/adopt`), fakeRequest({ origin: 'http://evil.example' }));
    assert.equal(result.status, 403);
    assert.equal(result.json.code, 'origin');
  });
});

test('the write routes refuse an opaque Origin', async () => {
  await withHome(async (home) => {
    const { find } = await boot({ home, services: { workspaceRegistry: {}, sessionPersistence: {} } });
    const result = await call(find(`${API}/sessions/adopt`), fakeRequest({ origin: 'null' }));
    assert.equal(result.status, 403);
    assert.equal(result.json.code, 'origin');
  });
});

test('a write without a JSON content type is refused before parsing', async () => {
  await withHome(async (home) => {
    const { find } = await boot({ home });
    const result = await call(find(`${API}/topics/create`), fakeRequest({ contentType: 'text/plain', body: { workspaceId: 'ws_a', name: 'A' } }));
    assert.equal(result.status, 415);
    assert.equal(result.json.code, 'unsupported-media-type');
    const missing = await call(find(`${API}/topics/create`), fakeRequest({ contentType: null, body: {} }));
    assert.equal(missing.status, 415);
  });
});

test('the adopt route refuses a non-loopback Host', async () => {
  await withHome(async (home) => {
    const { find } = await boot({ home, services: { workspaceRegistry: {}, sessionPersistence: {} } });
    const result = await call(find(`${API}/sessions/adopt`), fakeRequest({ host: '10.0.0.5:3080' }));
    assert.equal(result.status, 403);
  });
});

test('the adopt route answers 405 for GET', async () => {
  await withHome(async (home) => {
    const { find } = await boot({ home });
    const result = await call(find(`${API}/sessions/adopt`), fakeRequest({ method: 'GET' }));
    assert.equal(result.status, 405);
    assert.equal(result.json.code, 'method');
  });
});

test('the adopt route reports unavailable instead of failing on a bare host', async () => {
  await withHome(async (home) => {
    const { find } = await boot({ home });
    const result = await call(find(`${API}/sessions/adopt`), fakeRequest({ body: {} }));
    assert.equal(result.status, 200);
    assert.equal(result.json.ok, true);
    assert.equal(result.json.result.available, false);
    assert.deepEqual(result.json.result.adopted, []);
  });
});

test('the adopt route re-attaches through the host and is idempotent', async () => {
  await withHome(async (home) => {
    const { mkdir } = await import('node:fs/promises');
    const project = join(home, 'project');
    await mkdir(project);
    const record = { path: project, sessionIds: [] };
    const workspace = {
      id: 'ws_a',
      get path() { return record.path; },
      get sessionIds() { return record.sessionIds; },
      async attachSession(id) {
        record.sessionIds = [id, ...record.sessionIds];
      },
    };
    // 0.2.1 always exposes the raw record table; without it the entity getter hides ids whose
    // cwd no longer matches, and the repair refuses to guess (see `adopt.js`). The fake table
    // stays live so a second call sees what the first one attached.
    const table = {
      keys: () => ['ws_a'],
      get: (key) => (key === 'ws_a' ? { sessionIds: record.sessionIds } : undefined),
    };
    const registry = { list: () => [workspace], archivedSessionIds: [], table };
    const persistence = { list: async () => [{ header: { id: 'ses_orphan', cwd: project, version: 4, type: 'session' } }] };
    const { find } = await boot({ home, services: { workspaceRegistry: registry, sessionPersistence: persistence } });

    const first = await call(find(`${API}/sessions/adopt`), fakeRequest({ body: {} }));
    assert.equal(first.status, 200);
    assert.deepEqual(first.json.result.adopted, ['ses_orphan']);
    assert.deepEqual(record.sessionIds, ['ses_orphan']);

    const second = await call(find(`${API}/sessions/adopt`), fakeRequest({ body: {} }));
    assert.deepEqual(second.json.result.adopted, [], 'a repeat is a no-op');
    assert.deepEqual(record.sessionIds, ['ses_orphan'], 'and does not duplicate the id');
  });
});

test('adopt refuses to repair when the registry exposes no raw table', async () => {
  await withHome(async (home) => {
    const { mkdir } = await import('node:fs/promises');
    const project = join(home, 'project');
    await mkdir(project);
    // The entity getter filters out ids whose cwd no longer matches, so "not listed" cannot be
    // read as "not accounted": attaching one of those to another workspace would double-account
    // a session, which the native registry refuses to boot. Skip instead of guessing.
    const workspace = {
      id: 'ws_a',
      path: project,
      get sessionIds() { return []; },
      attachSession: async () => { throw new Error('must not be called'); },
    };
    const registry = { list: () => [workspace], archivedSessionIds: [] };
    const persistence = { list: async () => [{ header: { id: 'ses_orphan', cwd: project, type: 'session' } }] };
    const { find } = await boot({ home, services: { workspaceRegistry: registry, sessionPersistence: persistence } });
    const result = await call(find(`${API}/sessions/adopt`), fakeRequest({ body: {} }));
    assert.equal(result.status, 200);
    assert.equal(result.json.result.available, false);
    assert.deepEqual(result.json.result.adopted, []);
  });
});

test('/state maps an unreadable document to the same JSON error envelope', async () => {
  await withHome(async (home) => {
    // A directory where the document belongs makes readFile fail with EISDIR (not ENOENT),
    // which is the class of error that used to escape the handler as a bare 500.
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(home, 'dsh-better-workspace', 'topics.v1.json'), { recursive: true });
    const { find } = await boot({ home });
    const result = await call(find(`${API}/state`), fakeRequest({ method: 'GET', body: undefined, contentType: null }));
    assert.equal(result.status, 500);
    assert.equal(result.json.ok, false);
    assert.equal(result.json.code, 'store-unreadable');
  });
});

test('/state stays a read-only GET carrying the topic document', async () => {
  await withHome(async (home) => {
    const { find } = await boot({ home });
    const result = await call(find(`${API}/state`), fakeRequest({ method: 'GET', body: undefined }));
    assert.equal(result.status, 200);
    assert.equal(result.json.ok, true);
    assert.equal(result.json.result.readOnly, false);
    assert.equal(typeof result.json.result.workspaces, 'object');
    const wrong = await call(find(`${API}/state`), fakeRequest({ method: 'POST', body: {} }));
    assert.equal(wrong.status, 405);
  });
});

test('the glyph table is a cached GET and no longer rides on /state', async () => {
  await withHome(async (home) => {
    const { find } = await boot({ home });
    const emojis = await call(find(`${API}/emojis`), fakeRequest({ method: 'GET', body: undefined }));
    assert.equal(emojis.status, 200);
    assert.equal(emojis.json.result.emojis.length, 1915);
    assert.match(String(emojis.headers['cache-control']), /max-age=\d+/, 'a static table is worth a browser cache');

    const state = await call(find(`${API}/state`), fakeRequest({ method: 'GET', body: undefined }));
    assert.equal('emojis' in state.json.result, false, 'the revisioned document no longer carries 11KB of glyphs');
    assert.match(String(state.headers['cache-control']), /no-store/, 'while the document itself must never be cached');
  });
});

test('a disabled plugin still answers /state, so the panel can hand the region back', async () => {
  const { routes, find } = await boot({ home: join(tmpdir(), 'dsh-disabled-unused'), config: { enabled: false } });
  // Only the kill-switch answer: no store, no sidecar, no delete routes.
  assert.deepEqual(routes.map((route) => route.path), [`${API}/state`]);
  const state = await call(find(`${API}/state`), fakeRequest({ method: 'GET', body: undefined }));
  assert.equal(state.status, 200);
  assert.equal(state.json.result.enabled, false, 'the panel sees "switched off" and unmounts itself');
});

test('a session filed into another workspace is refused, a matching one is not', async () => {
  await withHome(async (home) => {
    const services = {
      workspaceRegistry: {
        list: () => [
          { id: 'ws_a', path: 'D:/work/a', sessionIds: [] },
          { id: 'ws_b', path: 'D:/work/b', sessionIds: [] },
        ],
      },
      sessionPersistence: {
        list: async () => [
          { header: { type: 'session', id: 'ses_a', cwd: 'D:/work/a' } },
          { header: { type: 'session', id: 'ses_b', cwd: 'D:/work/b' } },
        ],
      },
    };
    const { find } = await boot({ home, services });
    const assign = find(`${API}/assign`);

    const crossed = await call(assign, fakeRequest({ body: { workspaceId: 'ws_a', sessionIds: ['ses_b'], topicId: null, expectedRevision: 0 } }));
    assert.equal(crossed.status, 400, 'proof of a mismatch is a client error, not a 500');
    assert.equal(crossed.json.code, 'cross-workspace');

    const created = await call(find(`${API}/topics/create`), fakeRequest({ body: { workspaceId: 'ws_b', name: 'X', sessionIds: ['ses_a'], expectedRevision: 0 } }));
    assert.equal(created.status, 400, 'the create route carries the same guard');

    const same = await call(assign, fakeRequest({ body: { workspaceId: 'ws_a', sessionIds: ['ses_a'], topicId: null, expectedRevision: 0 } }));
    assert.equal(same.status, 200, 'a session that lives in that workspace is filed normally');

    const unknown = await call(assign, fakeRequest({ body: { workspaceId: 'ws_b', sessionIds: ['ses_new'], topicId: null, expectedRevision: 1 } }));
    assert.equal(unknown.status, 200, 'a session the host has not accounted yet is exactly the case this must not block');
  });
});
