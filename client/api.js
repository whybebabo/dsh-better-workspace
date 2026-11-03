/**
 * Host transport for the panel.
 *
 * Browser-hosted profiles reach the plugin's `webServer` routes directly; the Desktop
 * shell serves the same handlers over its authenticated `/api` carrier, detected by the
 * `dsh-app:` document protocol. The route is chosen before sending — a mutating request
 * is never retried on the other carrier.
 *
 * Every request without a caller-owned `AbortSignal` gets its own timeout. Reads already
 * carry one from the store (`/state` 10s, `/emojis`); writes, adoption and deletion used to
 * wait forever when a host accepted the connection and never answered, which left the panel
 * busy and the serialized write queue blocked. A timed-out write is reported as `timeout`, not
 * as a plain failure: its outcome is unknown, and the caller must reconcile.
 */
import { t } from './i18n.js';

const API = '/dsh-better-workspace/api';
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Store codes the panel can phrase itself. Everything else falls back to the host text — the
 * alternative was printing raw Chinese store messages in an English UI. The code is kept on
 * `ApiError.code`; only the message is localized.
 */
const CODE_TEXT = {
  'topic-name-taken': 'topic.nameTaken',
  'topic-name-empty': 'topic.nameRequired',
  'topic-name-too-long': 'topic.nameTooLong',
  'topic-not-found': 'error.topicNotFound',
  'workspace-not-found': 'error.workspaceNotFound',
  'default-topic-protected': 'error.defaultTopicProtected',
  'batch-too-large': 'batch.limit',
  'cross-workspace': 'session.crossWorkspace',
  'delete-disabled': 'delete.disabled',
  'revision-required': 'error.revisionRequired',
  'confirm-required': 'delete.confirmRequired',
  'bad-emoji': 'error.badRequest',
  'bad-topic-id': 'error.badRequest',
  'bad-topic-ids': 'error.badRequest',
  'bad-workspace': 'error.badRequest',
  'bad-session-ids': 'error.badRequest',
  'bad-session-id': 'error.badRequest',
  'bad-json': 'error.badRequest',
  'body-too-large': 'error.badRequest',
  'store-locked': 'error.storeLocked',
  'store-read-only': 'error.storeReadOnly',
  'store-unreadable': 'error.storeUnreadable',
  'store-write-failed': 'error.storeWriteFailed',
  'store-future-version': 'error.storeFutureVersion',
};

function apiPath(path) {
  const desktop = typeof window !== 'undefined' && window.location?.protocol === 'dsh-app:';
  return desktop ? `/api${path}` : path;
}

export class ApiError extends Error {
  constructor(message, { status = 0, code = 'unknown', currentRevision = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.currentRevision = currentRevision;
  }
}

async function request(path, { method = 'GET', body, signal, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  let controller = null;
  let timer = null;
  let timedOut = false;
  let effective = signal;
  if (!effective && typeof AbortController === 'function') {
    controller = new AbortController();
    effective = controller.signal;
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
  }
  const timeoutError = () => new ApiError(t('state.writeTimeout'), { code: 'timeout' });
  try {
    let response;
    try {
      response = await fetch(apiPath(path), {
        method,
        signal: effective,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      if (error?.name === 'AbortError') {
        if (timedOut) throw timeoutError();
        throw error;
      }
      throw new ApiError(t('state.unavailable'), { code: 'network' });
    }
    let payload = null;
    try {
      payload = await response.json();
    } catch (error) {
      if (error?.name === 'AbortError') {
        if (timedOut) throw timeoutError();
        throw error;
      }
      throw new ApiError(t('error.badResponse', { status: response.status }), { status: response.status, code: 'bad-response' });
    }
    if (!response.ok || payload?.ok !== true) {
      const code = payload?.code ?? 'failed';
      const key = CODE_TEXT[code];
      throw new ApiError(key ? t(key) : payload?.error ?? `HTTP ${response.status}`, {
        status: response.status,
        code,
        currentRevision: payload?.currentRevision ?? null,
      });
    }
    return payload.result;
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/**
 * The glyph table is static and cached for a day, so its URL carries the plugin version: a
 * release that changes the table must not keep serving yesterday's copy from the browser cache.
 */
const CACHE_VERSION = typeof __DSH_CLIENT_VERSION__ === 'string' ? __DSH_CLIENT_VERSION__ : 'dev';

function mutation(path, payload, options) {
  return request(path, { method: 'POST', body: payload, ...options });
}

export const api = {
  state: (signal) => request(`${API}/state`, { method: 'GET', signal }),
  /** Static glyph table, fetched once per page (see the store's one-shot emoji fetch). */
  emojis: (signal) => request(`${API}/emojis?v=${encodeURIComponent(CACHE_VERSION)}`, { method: 'GET', signal }),
  createTopic: (payload, options) => mutation(`${API}/topics/create`, payload, options),
  updateTopic: (payload, options) => mutation(`${API}/topics/update`, payload, options),
  reorderTopics: (payload, options) => mutation(`${API}/topics/reorder`, payload, options),
  deleteTopic: (payload, options) => mutation(`${API}/topics/delete`, payload, options),
  assign: (payload, options) => mutation(`${API}/assign`, payload, options),
  adoptSessions: (options) => mutation(`${API}/sessions/adopt`, {}, options),
  deletePreview: (sessionIds, options) => mutation(`${API}/delete/preview`, { sessionIds }, options),
  deleteExecute: (payload, options) => mutation(`${API}/delete/execute`, payload, options),
};
