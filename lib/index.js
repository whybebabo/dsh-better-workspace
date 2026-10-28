/**
 * dsh-better-workspace — host half.
 *
 * Two jobs the browser half cannot do on its own:
 *   - persist topic folders and session assignments in a sidecar JSON document;
 *   - delete session artifacts, which DSH does not expose as a command.
 *
 * Routes are published on both carriers: `webServer` for browser-hosted profiles and
 * `connection.fetch` for the portless Desktop shell (which reaches the host over the
 * authenticated `/api` carrier). Injection is reactive so headless/CLI boots, which
 * mount neither service, still start.
 */
import { realpath } from 'node:fs/promises';
import { createTopicStore, resolveDshHome, StoreError, validateSessionIds, TOPIC_EMOJIS } from './store.js';
import { previewDelete, executeDelete } from './delete.js';
import { adoptOrphanSessions } from './adopt.js';
import { foldPath } from './session-files.js';

export const name = 'dsh-better-workspace';

const API = '/dsh-better-workspace/api';
const MAX_BODY_BYTES = 64 * 1024;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

function json(res, status, body, extraHeaders) {
  try {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', ...extraHeaders });
    res.end(JSON.stringify(body));
  } catch {
    try { res.writeHead(500).end(); } catch { /* response already gone */ }
  }
}

/** Client mistakes must not surface as 500s: the panel treats a 5xx as "host unreachable". */
const CLIENT_ERROR_STATUS = {
  'confirm-required': 400,
  'bad-json': 400,
  'body-too-large': 413,
  'revision-required': 400,
  'bad-session-ids': 400,
  'bad-session-id': 400,
  'bad-workspace': 400,
  'bad-topic-id': 400,
  'bad-topic-ids': 400,
  'batch-too-large': 400,
  'bad-emoji': 400,
  'cross-workspace': 400,
  'delete-disabled': 403,
};

function failure(error) {
  if (error instanceof StoreError) {
    return { status: error.status, body: { ok: false, error: error.message, code: error.code, currentRevision: error.currentRevision } };
  }
  const status = CLIENT_ERROR_STATUS[error?.code] ?? 500;
  return { status, body: { ok: false, error: String(error?.message ?? error), code: error?.code ?? 'internal' } };
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error(`请求体超过 ${MAX_BODY_BYTES} 字节上限`), { code: 'body-too-large' });
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed;
  } catch (error) {
    throw Object.assign(new Error(`请求体不是合法的 JSON 对象: ${error?.message ?? error}`), { code: 'bad-json' });
  }
}

/**
 * The loopback guard protects the raw HTTP carrier. The Desktop carrier is already
 * authenticated by the shell and arrives without headers, so the bridge marks it.
 */
function trustedRequest(req) {
  if (req?.__trustedCarrier === true) return true;
  const host = req?.headers?.host;
  if (typeof host !== 'string') return false;
  let hostname;
  try {
    hostname = new URL(`http://${host}`).hostname;
  } catch {
    return false;
  }
  if (!LOOPBACK_HOSTS.has(hostname)) return false;
  if (req.headers?.['sec-fetch-site'] === 'cross-site') return false;
  const origin = req.headers?.origin;
  if (origin === undefined || origin === '') return true;
  // `null` is what a sandboxed iframe or a file:// page sends: it is never this app's own
  // origin, and accepting it would let such a page drive the write routes.
  if (origin === 'null') return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * The raw web carrier is reachable by any page on this machine's loopback interface, and the
 * origin check alone is not enough: a `text/plain` body is a CORS "simple request" that skips
 * the preflight. Requiring JSON makes a cross-origin write need a preflight (which the browser
 * blocks), and the Desktop carrier is exempt because it is already authenticated and arrives
 * without headers.
 */
function isJsonRequest(req) {
  if (req?.__trustedCarrier === true || !req?.headers) return true;
  const type = req.headers['content-type'];
  return typeof type === 'string' && /^application\/json(?:\s*;|$)/i.test(type.trim());
}

/**
 * The revision a write carries. `null` is passed through to the store, which refuses it for
 * client-facing writes (`revision-required`); keeping the distinction here means a malformed
 * value is rejected instead of silently disabling the conflict check.
 */
function revisionOf(body) {
  return Number.isInteger(body?.expectedRevision) && body.expectedRevision >= 0 ? body.expectedRevision : null;
}

/**
 * Refuses a write that files a session into a workspace it demonstrably does not belong to.
 *
 * The panel refuses cross-workspace filing everywhere — drag and drop, the blank-session
 * watcher, the composer chip — but these routes are a public surface, and a sidecar that pins a
 * session into a foreign workspace is data no view can interpret (the native registry also
 * refuses to boot a state where one session is accounted twice).
 *
 * Deliberately best-effort: it only refuses when the host can *prove* the mismatch, i.e. the
 * session's own `cwd` resolves to a different registered workspace. A session the host has not
 * accounted yet simply has no entry here, and refusing that would break every new session.
 */
function createMembershipGuard(ctx) {
  const service = (name) => {
    try { return ctx?.get?.(name) ?? null; } catch { return null; }
  };
  /** `sessionPersistence.list()` is a whole-tree read; a short memo covers one burst of writes. */
  let headersAt = 0;
  let headersById = null;
  const sessionHeaders = async () => {
    const persistence = service('sessionPersistence');
    if (typeof persistence?.list !== 'function') return null;
    const at = Date.now();
    if (headersById && at - headersAt < 2_000) return headersById;
    const snapshots = await persistence.list().catch(() => null);
    if (!Array.isArray(snapshots)) return headersById;
    const byId = new Map();
    for (const snapshot of snapshots) {
      const header = snapshot?.header;
      if (header && typeof header.id === 'string') byId.set(header.id, header);
    }
    headersAt = at;
    headersById = byId;
    return byId;
  };
  const workspacePaths = () => {
    const registry = service('workspaceRegistry');
    if (typeof registry?.list !== 'function') return null;
    const workspaces = registry.list();
    if (!Array.isArray(workspaces) || workspaces.length === 0) return null;
    const byId = new Map();
    const byPath = new Map();
    for (const workspace of workspaces) {
      const id = workspace?.id ?? workspace?.workspaceId;
      if (!id || typeof workspace.path !== 'string' || workspace.path === '') continue;
      const folded = foldPath(workspace.path);
      byId.set(id, folded);
      if (!byPath.has(folded)) byPath.set(folded, id);
    }
    return { byId, byPath };
  };

  return async function assertMembership({ workspaceId, sessionIds }) {
    if (!Array.isArray(sessionIds) || sessionIds.length === 0) return;
    const paths = workspacePaths();
    const target = paths?.byId.get(workspaceId);
    if (!paths || !target) return;
    const headers = await sessionHeaders();
    if (!headers) return;
    for (const sessionId of sessionIds) {
      const header = headers.get(sessionId);
      // Subagents are never filed; an unknown id is exactly the not-yet-accounted case.
      if (!header || header.origin === 'subagent') continue;
      if (typeof header.cwd !== 'string' || header.cwd === '') continue;
      const canonical = await realpath(header.cwd).catch(() => null);
      const owner = paths.byPath.get(foldPath(canonical ?? header.cwd));
      // Two records pointing at the same directory (a re-created workspace) are not a mismatch.
      if (owner && owner !== workspaceId && paths.byId.get(owner) !== target) {
        throw new StoreError(`会话不属于该工作区: ${sessionId}`, 'cross-workspace', 400);
      }
    }
  };
}

/** Bridges one WebRoute onto Connection's authenticated fetch carrier. */
function connectionRoute(route) {
  return {
    path: `/api${route.path}`,
    methods: route.methods,
    requestBody: 'buffered',
    async fetch(request) {
      const chunks = [];
      let size = 0;
      const reader = request.body?.getReader?.();
      try {
        if (reader) {
          for (;;) {
            request.signal?.throwIfAborted?.();
            const { done, value } = await reader.read();
            if (done) break;
            size += value?.byteLength ?? 0;
            if (size > MAX_BODY_BYTES) {
              await reader.cancel().catch(() => {});
              return Response.json({ ok: false, error: '请求体过大', code: 'body-too-large' }, { status: 413 });
            }
            chunks.push(Buffer.from(value));
          }
        }
      } finally {
        reader?.releaseLock?.();
      }
      const { Readable } = await import('node:stream');
      const url = new URL(request.url);
      const req = Readable.from(size > 0 ? [Buffer.concat(chunks, size)] : []);
      req.method = request.method;
      req.url = `${route.path}${url.search}`;
      req.__trustedCarrier = true;
      const headers = new Headers();
      let response = null;
      const res = {
        statusCode: 200,
        writeHead(status, extra) {
          this.statusCode = status;
          for (const [key, value] of Object.entries(extra ?? {})) {
            if (value !== undefined) headers.set(key, String(value));
          }
          return this;
        },
        setHeader(key, value) { headers.set(key, String(value)); },
        end(body) { response = new Response(body, { status: this.statusCode, headers }); },
      };
      try {
        await route.handle(req, res);
        if (!response) throw new Error('处理函数未产生响应');
        return response;
      } finally {
        req.destroy?.();
      }
    },
  };
}

/**
 * Publishes the routes on both carriers.
 *
 * Extracted so the disabled composition can publish its single `/state` answer without
 * starting the store: `config.enabled: false` used to `return` before registering anything,
 * which left the browser bundle (loaded by package name, not by this row's config) covering
 * the native list with a 404 banner.
 */
function publishRoutes(ctx, routes) {
  ctx.inject(['webServer'], (inner) => {
    const server = inner.get('webServer');
    if (!server || typeof server.register !== 'function') return;
    const disposers = [];
    const release = () => {
      for (const dispose of disposers.splice(0)) {
        try { dispose(); } catch { /* already gone */ }
      }
    };
    try {
      for (const route of routes) {
        disposers.push(server.register({
          kind: route.kind,
          path: route.path,
          handler: async (req, res) => {
            if (!trustedRequest(req)) return json(res, 403, { ok: false, error: '仅允许本机同源访问', code: 'origin' });
            await route.handle(req, res);
          },
        }));
      }
    } catch (error) {
      // A mid-way registration failure (duplicate path on reload) must not strand the routes
      // already added: without a disposer they would outlive this plugin instance.
      release();
      throw error;
    }
    inner.effect(() => release, 'dsh-better-workspace: web routes');
  });

  ctx.inject(['connection'], (inner) => {
    const connection = inner.get('connection');
    if (typeof connection?.fetch?.register !== 'function') return;
    const disposers = [];
    const failed = [];
    for (const route of routes) {
      try {
        disposers.push(connection.fetch.register(connectionRoute(route)));
      } catch (error) {
        failed.push(`${route.path}: ${String(error?.message ?? error)}`);
      }
    }
    inner.effect(() => async () => {
      for (const dispose of disposers) {
        try { await dispose(); } catch { /* already gone */ }
      }
    }, 'dsh-better-workspace: connection fetch routes');
    if (failed.length > 0) ctx.logger?.warn?.(`[dsh-better-workspace] 部分 Desktop 路由未注册: ${failed.join('; ')}`);
  });
}

export default function topicSidebarPlugin(ctx, config) {
  const enabled = config?.enabled !== false;
  if (!enabled) {
    // The panel must know it is switched off, or it keeps covering the stock list forever:
    // the client bundle is loaded by package name and never sees this row's config.
    publishRoutes(ctx, [{
      kind: 'exact',
      path: `${API}/state`,
      methods: ['GET'],
      async handle(req, res) {
        if (req.method !== 'GET') return json(res, 405, { ok: false, error: '仅支持 GET', code: 'method' });
        json(res, 200, { ok: true, result: { enabled: false } });
      },
    }]);
    return;
  }

  const enableDelete = config?.enableDelete !== false;
  const home = resolveDshHome(config?.storageHome);
  const store = createTopicStore({ configuredHome: home });
  const routes = [];

  routes.push({
    kind: 'exact',
    path: `${API}/state`,
    methods: ['GET'],
    async handle(req, res) {
      if (req.method !== 'GET') return json(res, 405, { ok: false, error: '仅支持 GET', code: 'method' });
      try {
        const snapshot = await store.snapshot();
        json(res, 200, {
          ok: true,
          result: {
            enabled: true,
            deleteAvailable: enableDelete,
            storage: store.file,
            revision: snapshot.revision,
            updatedAt: snapshot.updatedAt,
            readOnly: snapshot.readOnly,
            warning: snapshot.warning,
            warningCode: snapshot.warningCode ?? null,
            workspaces: snapshot.workspaces,
          },
        });
      } catch (error) {
        // The client distinguishes a JSON failure from a broken transport; an unhandled
        // filesystem error would surface as a bare 500 (or HTML) and read as "bad response".
        const { status, body } = failure(error);
        json(res, status, body);
      }
    },
  });

  /**
   * The picker glyphs live on their own route because they are static while the document is
   * revisioned: `/state` is re-read after every write, and carrying 1915 glyphs (~11KB) in each
   * of those made the panel re-download a constant table constantly. `no-store` is right for
   * the document and wrong for this.
   */
  routes.push({
    kind: 'exact',
    path: `${API}/emojis`,
    methods: ['GET'],
    async handle(req, res) {
      if (req.method !== 'GET') return json(res, 405, { ok: false, error: '仅支持 GET', code: 'method' });
      json(res, 200, { ok: true, result: { emojis: TOPIC_EMOJIS } }, { 'cache-control': 'private, max-age=86400' });
    },
  });

  const post = (path, run) => routes.push({
    kind: 'exact',
    path,
    methods: ['POST'],
    async handle(req, res) {
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: '仅支持 POST', code: 'method' });
      if (!isJsonRequest(req)) return json(res, 415, { ok: false, error: '请求体必须是 application/json', code: 'unsupported-media-type' });
      try {
        const body = await readJson(req);
        const result = await run(body);
        json(res, 200, { ok: true, result });
      } catch (error) {
        const { status, body: payload } = failure(error);
        json(res, status, payload);
      }
    },
  });

  const assertMembership = createMembershipGuard(ctx);

  post(`${API}/topics/create`, async (body) => {
    await assertMembership({ workspaceId: body.workspaceId, sessionIds: body.sessionIds });
    return store.createTopic({
      workspaceId: body.workspaceId,
      name: body.name,
      emoji: body.emoji,
      sessionIds: body.sessionIds,
      expectedRevision: revisionOf(body),
    });
  });

  post(`${API}/topics/update`, (body) => store.updateTopic({
    workspaceId: body.workspaceId,
    topicId: body.topicId,
    name: body.name,
    emoji: body.emoji,
    order: body.order,
    expectedRevision: revisionOf(body),
  }));

  post(`${API}/topics/delete`, (body) => store.deleteTopic({
    workspaceId: body.workspaceId,
    topicId: body.topicId,
    expectedRevision: revisionOf(body),
  }));

  post(`${API}/topics/reorder`, (body) => store.reorderTopics({
    workspaceId: body.workspaceId,
    topicIds: body.topicIds,
    expectedRevision: revisionOf(body),
  }));

  post(`${API}/assign`, async (body) => {
    await assertMembership({ workspaceId: body.workspaceId, sessionIds: body.sessionIds });
    return store.assign({
      workspaceId: body.workspaceId,
      sessionIds: body.sessionIds,
      topicId: body.topicId === undefined ? null : body.topicId,
      expectedRevision: revisionOf(body),
    });
  });

  post(`${API}/sessions/adopt`, async () => {
    // Re-attach sessions whose artifact header matches a workspace path but which the host
    // never accounted (a workspace registration that was deleted and re-created, a crash
    // between the header write and `attachSession`, a session resumed through another route).
    // Without this they stay in the trailing 未分组 bucket even though their cwd belongs to a
    // workspace — which reads as "the session is gone" once the plugin is removed.
    const result = await adoptOrphanSessions({ ctx });
    return result;
  });

  post(`${API}/delete/preview`, async (body) => {
    if (!enableDelete) throw new StoreError('插件配置已禁用永久删除', 'delete-disabled', 403);
    const sessionIds = validateSessionIds(body.sessionIds);
    const preview = await previewDelete({ home, ctx, sessionIds });
    return { home, ...preview };
  });

  post(`${API}/delete/execute`, async (body) => {
    if (!enableDelete) throw new StoreError('插件配置已禁用永久删除', 'delete-disabled', 403);
    const sessionIds = validateSessionIds(body.sessionIds);
    const outcome = await executeDelete({
      home,
      ctx,
      sessionIds,
      confirm: body.confirm === true,
      stopActivity: body.stopActivity !== false,
    });
    // `partial` means the session artifact itself is gone and only some children survived;
    // its own topic assignment must be dropped just like a clean delete's.
    const deleted = outcome.items
      .filter((item) => item.status === 'deleted' || item.status === 'partial')
      .map((item) => item.sessionId);
    const cascaded = outcome.items.flatMap((item) => item.subagentsRemoved);
    const toForget = [...new Set([...deleted, ...cascaded])];
    try {
      // A cascade can remove more than one batch (200) of children; `forgetSessions` validates
      // its input with the same cap as client writes, so send it in chunks instead of failing
      // the whole assignment cleanup for an otherwise successful delete.
      for (let index = 0; index < toForget.length; index += 200) {
        await store.forgetSessions(toForget.slice(index, index + 200));
      }
    } catch (error) {
      outcome.assignmentCleanup = { failed: true, error: String(error?.message ?? error) };
    }
    return { ...outcome, home };
  });

  publishRoutes(ctx, routes);
}

export { topicSidebarPlugin as apply };
