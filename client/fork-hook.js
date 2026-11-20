/**
 * Learn which session a fork came from, from the host command that creates it.
 *
 * DSH 0.2.1-rc.3 made ordinary forks independent of their source: the child's header no longer
 * records `parentSession` and the session list's summary no longer carries `parentSessionId`
 * (upstream commit "make ordinary forks independent of source lineage"). The panel used to read
 * that lineage in two places — `topicOfSession`'s parent chain and the new-session watcher — so
 * every fork created outside this panel's own row menu (the stock fork shortcut, the chat view's
 * branch command, another surface) started landing in the default group instead of the source
 * session's group.
 *
 * `sessions.fork` is the one funnel all of those paths go through — `uiWorkspace.forkSession`
 * reaches it through navigation, the stock shortcut calls navigation, the chat branch calls it
 * directly — and it resolves to the child id. Wrapping that single instance method, with the
 * original `this`, arguments, result and rejection preserved, is the only place where the
 * source/child pair can still be observed.
 *
 * The wrapper is a pure observation shim: it never changes a result, never swallows an error, and
 * runs every listener inside a try/catch so a panel bug can never fail the user's fork.
 */

/**
 * Own-property marker holding the installed shim. A symbol key is invisible to normal property
 * enumeration, and `Symbol.for` keeps a second copy of this bundle (HMR, two profiles in one page)
 * from wrapping the same method twice and notifying each listener twice.
 */
const HOOK = Symbol.for('dsh-better-workspace:fork-hook');

/**
 * Watch every fork the host creates through `sessions.fork`.
 *
 * @param {object|null} sessions - the host `sessions` service (`ctx.get('sessions')`)
 * @param {(fork: {sourceId: string, childId: string}) => void} listener - called once per
 *   successful fork, after the host resolved the child id
 * @returns {(() => void)|null} an unsubscribe, or null when the service or its `fork` is missing
 *   (an older or differently-composed host: the panel then keeps its lineage-based fallback)
 */
export function watchSessionForks(sessions, listener) {
  if (!sessions || typeof sessions.fork !== 'function' || typeof listener !== 'function') return null;
  let state = sessions[HOOK];
  if (!state) {
    const service = sessions;
    const original = service.fork;
    const listeners = new Set();
    const notify = (fork) => {
      for (const entry of [...listeners]) {
        try {
          entry(fork);
        } catch { /* a panel-side bug must not fail the host's fork */ }
      }
    };
    const wrapper = function fork(...args) {
      const result = original.apply(service, args);
      // `fork` is a promise in every host that has it; anything else is passed straight through
      // so a future synchronous variant cannot be broken by this shim.
      if (!result || typeof result.then !== 'function') return result;
      return result.then((childId) => {
        const sourceId = args[0]?.sessionId;
        // A self-fork or a non-string id would file the source into its own group; skip both.
        if (typeof childId === 'string' && childId !== '' && typeof sourceId === 'string' && sourceId !== '' && childId !== sourceId) {
          notify({ sourceId, childId });
        }
        return childId;
      });
    };
    state = { original, listeners };
    try {
      // Non-enumerable: the shim must not show up when something inventories the service.
      Object.defineProperty(service, 'fork', { configurable: true, writable: true, enumerable: false, value: wrapper });
      Object.defineProperty(service, HOOK, { configurable: true, writable: true, enumerable: false, value: state });
    } catch {
      // A frozen service cannot be observed; the caller falls back to the lineage path.
      return null;
    }
  }
  state.listeners.add(listener);
  let active = true;
  return () => {
    // Idempotent: React may replay the teardown of an effect it already cleaned up.
    if (!active) return;
    active = false;
    state.listeners.delete(listener);
  };
}