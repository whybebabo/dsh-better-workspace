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
import { createTopicStore, resolveDshHome, StoreError, validateSessionIds, TOPIC_EMOJIS } from './store.js';
import { previewDelete, executeDelete } from './delete.js';

export const name = 'dsh-better-workspace';

const API = '/dsh-better-workspace/api';
const MAX_BODY_BYTES = 64 * 1024;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

function json(res, status, body) {
  try {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
    res.end(JSON.stringify(body));
  } catch {
    try { res.writeHead(500).end(); } catch { /* response already gone */ }
  }
}

function failure(error) {
  if (error instanceof StoreError) {
    return { status: error.status, body: { ok: false, error: error.message, code: error.code, currentRevision: error.currentRevision } };
  }
  const status = error?.code === 'confirm-required' ? 400 : 500;
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
  if (origin === undefined || origin === '' || origin === 'null') return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function revisionOf(body) {
  return Number.isInteger(body?.expectedRevision) && body.expectedRevision >= 0 ? body.expectedRevision : null;
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

export default function topicSidebarPlugin(ctx, config) {
  const enabled = config?.enabled !== false;
  if (!enabled) return;

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
      const snapshot = await store.snapshot();
      json(res, 200, {
        ok: true,
        result: {
          enabled: true,
          deleteAvailable: enableDelete,
          emojis: TOPIC_EMOJIS,
          storage: store.file,
          revision: snapshot.revision,
          updatedAt: snapshot.updatedAt,
          readOnly: snapshot.readOnly,
          warning: snapshot.warning,
          workspaces: snapshot.workspaces,
        },
      });
    },
  });

  const post = (path, run) => routes.push({
    kind: 'exact',
    path,
    methods: ['POST'],
    async handle(req, res) {
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: '仅支持 POST', code: 'method' });
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

  post(`${API}/topics/create`, (body) => store.createTopic({
    workspaceId: body.workspaceId,
    name: body.name,
    emoji: body.emoji,
    sessionIds: body.sessionIds,
    expectedRevision: revisionOf(body),
  }));

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

  post(`${API}/assign`, (body) => store.assign({
    workspaceId: body.workspaceId,
    sessionIds: body.sessionIds,
    topicId: body.topicId === undefined ? null : body.topicId,
    expectedRevision: revisionOf(body),
  }));

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
    const deleted = outcome.items.filter((item) => item.status === 'deleted').map((item) => item.sessionId);
    const cascaded = outcome.items.flatMap((item) => item.subagentsRemoved);
    try {
      if (deleted.length + cascaded.length > 0) await store.forgetSessions([...deleted, ...cascaded]);
    } catch (error) {
      outcome.assignmentCleanup = { failed: true, error: String(error?.message ?? error) };
    }
    return { ...outcome, home };
  });

  ctx.inject(['webServer'], (inner) => {
    const server = inner.get('webServer');
    if (!server || typeof server.register !== 'function') return;
    const disposers = routes.map((route) => server.register({
      kind: route.kind,
      path: route.path,
      handler: async (req, res) => {
        if (!trustedRequest(req)) return json(res, 403, { ok: false, error: '仅允许本机同源访问', code: 'origin' });
        await route.handle(req, res);
      },
    }));
    inner.effect(() => () => disposers.forEach((dispose) => { try { dispose(); } catch { /* already gone */ } }), 'dsh-better-workspace: web routes');
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

export { topicSidebarPlugin as apply };
