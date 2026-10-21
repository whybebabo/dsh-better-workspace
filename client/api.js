/**
 * Host transport for the panel.
 *
 * Browser-hosted profiles reach the plugin's `webServer` routes directly; the Desktop
 * shell serves the same handlers over its authenticated `/api` carrier, detected by the
 * `dsh-app:` document protocol. The route is chosen before sending — a mutating request
 * is never retried on the other carrier.
 */
import { t } from './i18n.js';

const API = '/dsh-better-workspace/api';

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

async function request(path, { method = 'GET', body, signal } = {}) {
  let response;
  try {
    response = await fetch(apiPath(path), {
      method,
      signal,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw new ApiError(t('state.unavailable'), { code: 'network' });
  }
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    throw new ApiError(`宿主返回了无法解析的响应(HTTP ${response.status})`, { status: response.status, code: 'bad-response' });
  }
  if (!response.ok || payload?.ok !== true) {
    throw new ApiError(payload?.error ?? `HTTP ${response.status}`, {
      status: response.status,
      code: payload?.code ?? 'failed',
      currentRevision: payload?.currentRevision ?? null,
    });
  }
  return payload.result;
}

export const api = {
  state: (signal) => request(`${API}/state`, { method: 'GET', signal }),
  createTopic: (payload) => request(`${API}/topics/create`, { method: 'POST', body: payload }),
  updateTopic: (payload) => request(`${API}/topics/update`, { method: 'POST', body: payload }),
  reorderTopics: (payload) => request(`${API}/topics/reorder`, { method: 'POST', body: payload }),
  deleteTopic: (payload) => request(`${API}/topics/delete`, { method: 'POST', body: payload }),
  assign: (payload) => request(`${API}/assign`, { method: 'POST', body: payload }),
  adoptSessions: () => request(`${API}/sessions/adopt`, { method: 'POST', body: {} }),
  deletePreview: (sessionIds) => request(`${API}/delete/preview`, { method: 'POST', body: { sessionIds } }),
  deleteExecute: (payload) => request(`${API}/delete/execute`, { method: 'POST', body: payload }),
};
