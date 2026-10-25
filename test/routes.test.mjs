/**
 * Route wiring for `lib/index.js`.
 *
 * The panel talks to these handlers; they were previously untested, so the loopback guard, the
 * method gate and the error mapping had no coverage at all. Everything here is exercised against
 * the real plugin entry with a fake `webServer`, not against a re-implementation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import plugin from '../lib/index.js';

const API = '/dsh-better-workspace/api';

/** Boots the plugin against a captured `webServer.register` and an adopted-services stub. */
async function boot({ home, services = {} } = {}) {
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
  plugin(ctx, { enabled: true, storageHome: home });
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
  return { status: res.out.status, json: res.out.body === null ? null : JSON.parse(res.out.body) };
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
    assert.ok(paths.includes(`${API}/sessions/adopt`), 'the membership-repair route is registered');
    assert.ok(paths.includes(`${API}/directory/list`), 'the in-app picker can list the host directories');
    assert.ok(paths.includes(`${API}/directory/create`));
    assert.ok(paths.includes(`${API}/delete/preview`));
    assert.ok(paths.every((path) => path.startsWith(`${API}/`)), 'all routes share the plugin prefix');
  });
});

test('the directory routes list and create folders under a client-supplied path', async () => {
  await withHome(async (home) => {
    await mkdir(join(home, 'project'));
    const { find } = await boot({ home });
    const listed = await call(find(`${API}/directory/list`), fakeRequest({ body: { path: home } }));
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.json.result.entries.map((entry) => entry.name), ['project']);

    const created = await call(find(`${API}/directory/create`), fakeRequest({ body: { path: home, name: 'second' } }));
    assert.equal(created.status, 200);
    assert.equal(created.json.result.path, join(home, 'second'));

    const bad = await call(find(`${API}/directory/create`), fakeRequest({ body: { path: home, name: '../escape' } }));
    assert.equal(bad.status, 400);
    assert.equal(bad.json.code, 'bad-directory-name');
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
    const registry = { list: () => [workspace], archivedSessionIds: [] };
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
