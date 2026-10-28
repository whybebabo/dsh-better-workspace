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
    /**
     * Rename a session the way the host's own rename dialog does.
     *
     * `UiWorkspace` has no `renameSession` in 0.2.1: the host dialog closes over
     * `sessions.using(id, { source: 'workspaceOperation' }, ref => ref.binding.session.rename(title))`
     * and checks `result.ok` (`ui-workspace/src/client/index.ts`). Requiring the missing method
     * made every save fail with "this host build cannot rename sessions". The `uiWorkspace`
     * branch stays first for a future host that adds it; the official service is the fallback.
     */
    async renameSession(sessionId, title) {
      const target = uiWorkspace();
      if (typeof target?.renameSession === 'function') return call(target, 'renameSession', sessionId, title);
      const service = sessions();
      if (typeof service?.using !== 'function') {
        throw Object.assign(new Error(t('host.renameUnsupported')), { code: 'host-command-missing' });
      }
      const result = await service.using(sessionId, { source: 'workspaceOperation' }, (reference) => {
        const rename = reference?.binding?.session?.rename;
        // A silently skipped optional call would report success while nothing was written.
        if (typeof rename !== 'function') {
          throw Object.assign(new Error(t('host.renameUnsupported')), { code: 'host-command-missing' });
        }
        return rename.call(reference.binding.session, title);
      });
      if (result && result.ok === false) {
        throw Object.assign(new Error(result.error?.message ?? t('host.renameUnsupported')), { code: 'host-rename-failed' });
      }
      return result;
    },
    /**
     * Fallback for adding a workspace when the host's own add control cannot be found.
     *
     * The panel normally delegates to that control, so the host runs whichever directory
     * interaction the deployment composed. This path only has the native face: Desktop's
     * window-owned bridge first (`__DSH_DIRECTORY_PICKER__.pick()`, an Electron sheet),
     * then the remote `pickDirectory` command. The latter is native-only — a browse
     * composition (tunnel, SSH, non-loopback bind) refuses it, which is why delegation is
     * the primary path.
     */
    async createWorkspace() {
      const bridge = globalThis.__DSH_DIRECTORY_PICKER__;
      const path = typeof bridge?.pick === 'function'
        ? await bridge.pick()
        : await call(uiWorkspace(), 'pickDirectory');
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
