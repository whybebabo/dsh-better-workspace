/**
 * Thin, defensive wrapper over the host client services.
 *
 * Every command is feature-detected: a missing or renamed service in a future DSH build
 * surfaces as a toast in the panel instead of a crash in the shell, and the native list
 * stays reachable because the overlay hides itself on repeated failures.
 */
import { t } from './i18n.js';

export function createHostActions(ctx) {
  // Only `slots` is a hard dependency; the rest are resolved lazily so a composition that
  // lacks one of them still boots (the panel then reports the missing command on use).
  const resolve = (name) => {
    try {
      return ctx.get?.(name) ?? null;
    } catch {
      return null;
    }
  };
  const cached = new Map();
  const service = (name) => {
    // Do not pin a miss: services can mount after the plugin's first render.
    if (!cached.has(name) || cached.get(name) == null) cached.set(name, resolve(name));
    return cached.get(name);
  };
  const uiWorkspace = () => service('uiWorkspace');
  const uiSession = () => service('uiSession');
  const workspaces = () => service('workspaces');
  const sessions = () => service('sessions');
  const layout = () => service('layout');

  function call(target, name, ...args) {
    const method = target?.[name];
    if (typeof method !== 'function') {
      throw Object.assign(new Error(`宿主缺少 ${name} 命令`), { code: 'host-command-missing' });
    }
    return method.apply(target, args);
  }

  return {
    get sessionStore() {
      return sessions()?.list ?? null;
    },
    /** Host-global running / pending-interaction / completion-unread facts, keyed by session id. */
    get sessionStatusStore() {
      return uiSession()?.sessionStatus ?? null;
    },
    get workspaceStore() {
      return workspaces()?.list ?? null;
    },
    get workspaceActions() {
      return workspaces() ? { create: (input) => call(workspaces(), 'create', input) } : null;
    },
    openSession(sessionId) {
      call(uiWorkspace(), 'openSession', sessionId);
    },
    startSession(workspaceId) {
      if (workspaceId) return call(uiWorkspace(), 'startSession', workspaceId);
      return call(uiWorkspace(), 'startSession');
    },
    archiveSession(sessionId, options) {
      return call(uiWorkspace(), 'archiveSession', sessionId, options ?? {});
    },
    unarchiveSession(sessionId) {
      return call(uiWorkspace(), 'unarchiveSession', sessionId);
    },
    pinSession(sessionId) {
      return call(uiWorkspace(), 'pinSession', sessionId);
    },
    unpinSession(sessionId) {
      return call(uiWorkspace(), 'unpinSession', sessionId);
    },
    forkSession(sessionId) {
      return call(uiWorkspace(), 'forkSession', sessionId);
    },
    renameSession(sessionId, title) {
      const target = uiWorkspace();
      if (typeof target?.renameSession === 'function') return call(target, 'renameSession', sessionId, title);
      throw Object.assign(new Error(t('host.renameUnsupported')), { code: 'host-command-missing' });
    },
    /** Reuses the host's own directory picker so adding a workspace behaves exactly natively. */
    async createWorkspace() {
      const path = await call(uiWorkspace(), 'pickDirectory');
      if (!path) return null;
      await call(workspaces(), 'create', { path });
      return path;
    },
    renameWorkspace(workspaceId, title) {
      return call(workspaces(), 'rename', workspaceId, title);
    },
    deleteWorkspace(workspaceId) {
      return call(workspaces(), 'delete', workspaceId);
    },
    toggleSidebar() {
      const target = layout();
      if (typeof target?.toggleSidebar === 'function') return call(target, 'toggleSidebar');
      return undefined;
    },
    refreshSessions() {
      const target = sessions();
      if (typeof target?.refresh === 'function') return call(target, 'refresh');
      return undefined;
    },
    supports(name) {
      const target = uiWorkspace();
      return typeof target?.[name] === 'function';
    },
  };
}
