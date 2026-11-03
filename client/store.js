/**
 * Panel state: the topic document mirrored from the host, plus UI preferences that are
 * local-only (workspace filter, collapse sets, search, selection).
 *
 * Every mutation carries the last known revision; a 409 reloads the document and surfaces
 * a conflict instead of silently clobbering another window's write.
 */
import { api, ApiError } from './api.js';
import { t } from './i18n.js';
import { withDefaultTopic } from './model.js';

const PREFS_KEY = 'dsh-better-workspace:prefs:v1';
/**
 * A host that accepts the connection but never answers must not leave `load()` pending
 * forever: it would keep the panel hidden and never reach the retry path.
 */
const STATE_TIMEOUT_MS = 10_000;
const DEFAULT_PREFS = {
  workspaceFilter: null,
  topicFilter: null,
  /**
   * The workspace the active topic filter belongs to. A topic id is only unique inside its
   * workspace (`tp_default` exists in every one), so a bare id made "only this group" resolve to
   * whichever workspace happened to own that id first. Kept next to the filter rather than
   * replacing it with a composite key so the persisted shape stays readable.
   */
  topicFilterWorkspace: null,
  searchOpen: false,
  search: '',
  showArchived: false,
  collapsedWorkspaces: [],
  collapsedTopics: [],
  /**
   * Buckets the user expanded past the reveal limit, as `workspaceId:sectionKey` composite
   * keys. Persisted (not component state) because selection must agree with rendering: the
   * panel's grouping menus derive their selectable ids from this same set, and a state stored
   * inside `Section` was invisible to them.
   */
  revealedBuckets: [],
  selectMode: false,
  // Manual drag order: ids the user placed, everything else keeps the host's order.
  workspaceOrder: [],
  sessionOrder: {},
};

function readPrefs() {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_PREFS,
      ...parsed,
      // Selection is a transient mode, not a preference: a reload must never land in it.
      selectMode: false,
      collapsedWorkspaces: Array.isArray(parsed?.collapsedWorkspaces) ? parsed.collapsedWorkspaces : [],
      collapsedTopics: Array.isArray(parsed?.collapsedTopics) ? parsed.collapsedTopics : [],
      revealedBuckets: Array.isArray(parsed?.revealedBuckets) ? parsed.revealedBuckets : [],
      workspaceOrder: Array.isArray(parsed?.workspaceOrder) ? parsed.workspaceOrder : [],
      sessionOrder: parsed?.sessionOrder && typeof parsed.sessionOrder === 'object' ? parsed.sessionOrder : {},
      // A document written before the pairing existed carries the topic id alone; `buildTree`
      // then falls back to looking the owner up, exactly as it did before.
      topicFilterWorkspace: typeof parsed?.topicFilterWorkspace === 'string' ? parsed.topicFilterWorkspace : null,
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

function writePrefs(prefs) {
  try {
    const { selectMode, ...persisted } = prefs;
    localStorage.setItem(PREFS_KEY, JSON.stringify(persisted));
  } catch { /* private mode / quota: preferences stay in memory */ }
}

export function createPanelStore(options = {}) {
  const stateTimeoutMs = Number.isFinite(options.stateTimeoutMs) ? options.stateTimeoutMs : STATE_TIMEOUT_MS;
  // Timeout for a write / adoption / delete request. `undefined` keeps the API layer's default;
  // tests pass a small value. A timed-out write is not a failure: its outcome is unknown.
  const requestTimeoutMs = Number.isFinite(options.requestTimeoutMs) ? options.requestTimeoutMs : undefined;
  const listeners = new Set();
  let state = {
    ready: false,
    loading: true,
    reachable: true,
    error: null,
    readOnly: false,
    warning: null,
    warningCode: null,
    deleteAvailable: false,
    emojis: [],
    revision: 0,
    workspaces: {},
    prefs: readPrefs(),
    selection: [],
    busy: null,
  };

  const emit = () => listeners.forEach((listener) => listener());
  const patch = (next) => {
    state = { ...state, ...next };
    emit();
  };

  function subscribe(listener) {
    // A live listener means the store is in use again (React 18 StrictMode replays effects);
    // clear the teardown marker so a lazy load can still run. A component that is really gone
    // never subscribes again, and its queued work stays dormant.
    disposed = false;
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  const getState = () => state;

  /**
   * The picker glyphs. `/state` used to carry all 1915 of them (~11KB) and is re-read after
   * every write, so the panel re-downloaded a constant table on each keystroke-sized change.
   * One request per page, coalesced while it is in flight.
   */
  /**
   * The glyph table is fetched once per page, but a failure is not necessarily permanent: a
   * missing route (404 / an SPA fallback) stays one-shot, while a network error, timeout or 5xx
   * must not downgrade the picker to the eight local fallbacks for the rest of the page. Three
   * attempts bound a host that keeps failing; a recovered host loads the real table on the next
   * `load()`.
   */
  let emojiAttempted = false;
  let emojiFailures = 0;
  let emojiRequest = null;
  function loadEmojis() {
    if (disposed || state.emojis.length > 0) return Promise.resolve(state.emojis);
    if (emojiRequest) return emojiRequest;
    if (emojiAttempted) return Promise.resolve([]);
    emojiAttempted = true;
    const startedIn = generation;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    let timer = null;
    if (controller) {
      activeControllers.add(controller);
      // A host that accepts the connection and never answers must not leave the request pending
      // forever (it would keep `emojiRequest` set and the picker on the fallback list).
      timer = setTimeout(() => controller.abort(), stateTimeoutMs);
    }
    emojiRequest = api.emojis(controller?.signal)
      .then((result) => {
        const list = Array.isArray(result?.emojis) ? result.emojis : [];
        if (list.length > 0 && !disposed && startedIn === generation) patch({ emojis: list });
        return list;
      })
      .catch((error) => {
        const permanent = error instanceof ApiError && (error.status === 404 || error.code === 'bad-response');
        if (!permanent && !disposed && emojiFailures < 2) {
          emojiFailures += 1;
          emojiAttempted = false;
        }
        return [];
      })
      .finally(() => {
        if (timer !== null) clearTimeout(timer);
        emojiRequest = null;
        if (controller) activeControllers.delete(controller);
      });
    return emojiRequest;
  }
  /** Monotonic guard for `/state` reads; see `load()`. */
  let loadSeq = 0;
  /**
   * Bounded retry for a `/state` read that failed before the host answered.
   *
   * A 404 / unparsable answer / network error makes the panel hand the region back and render
   * nothing (see `load()`), which also removes the only menu entry that reloads the document.
   * Without this, one transient failure — the browser loading the page before the plugin's
   * routes are registered, a proxy hiccup, a host restart — blanked the panel until the user
   * reloaded the browser. The retries keep the region released while they run.
   */
  const RETRY_DELAYS = [500, 1_500, 3_000];
  let retryTimer = null;
  let retryAttempt = 0;
  /**
   * Teardown marker. `dispose()` clears listeners and bumps the generation, so an in-flight
   * `/state` that fails afterwards cannot patch state, arm a new retry or issue another
   * request. `subscribe()` clears it again: a store that regained a listener (React 18
   * StrictMode replays effects) is live, while a store whose component is really gone stays
   * dormant even if a queued mutation finishes later.
   */
  let disposed = false;
  let generation = 0;
  /** In-flight `/state` and `/emojis` requests, aborted on teardown. */
  const activeControllers = new Set();

  function cancelRetry() {
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
  }

  function scheduleRetry(startedIn = generation) {
    if (disposed || startedIn !== generation || retryTimer !== null || retryAttempt >= RETRY_DELAYS.length) return;
    const delay = RETRY_DELAYS[retryAttempt];
    retryAttempt += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (disposed || startedIn !== generation) return;
      void load();
    }, delay);
  }
  async function load() {
    if (disposed) return false;
    // The glyph table is static and lives on its own route, so it is fetched once per page
    // rather than riding along with every revisioned document read.
    loadEmojis().catch(() => {});
    // Reads are not serialized with writes, so two GETs can land out of order. Only the newest
    // one may patch the mirror: a stale snapshot used to overwrite a newer revision and turn the
    // *next* write into a phantom "changed in another window" conflict.
    const seq = ++loadSeq;
    const startedIn = generation;
    let controller = null;
    let timer = null;
    try {
      if (typeof AbortController === 'function') {
        controller = new AbortController();
        activeControllers.add(controller);
        timer = setTimeout(() => controller.abort(), stateTimeoutMs);
      }
      const result = await api.state(controller?.signal);
      if (seq !== loadSeq || disposed || startedIn !== generation) return false;
      if (result?.enabled === false) {
        // The host row is switched off (`config.enabled: false`). The bundle still loads — the
        // loader keys it by package name, not by that row's config — so without this the panel
        // covered the stock list with a 404 banner instead of handing it back.
        cancelRetry();
        retryAttempt = 0;
        patch({
          ready: false,
          loading: false,
          reachable: false,
          error: null,
          readOnly: false,
          warning: null,
          warningCode: null,
          deleteAvailable: false,
          revision: 0,
          workspaces: {},
        });
        return false;
      }
      patch({
        ready: true,
        loading: false,
        reachable: true,
        error: null,
        readOnly: Boolean(result.readOnly),
        warning: result.warning ?? null,
        warningCode: result.warningCode ?? null,
        deleteAvailable: Boolean(result.deleteAvailable),
        revision: result.revision,
        workspaces: result.workspaces ?? {},
      });
      cancelRetry();
      retryAttempt = 0;
      return true;
    } catch (error) {
      if (seq !== loadSeq || disposed || startedIn !== generation) return false;
      // A 404 (or an unparsable answer, e.g. the web server's SPA fallback) means the host half
      // is not there. Keeping `ready` true would cover the stock list with an error banner and
      // inert it, leaving the user no way back; release the region instead. An abort is our own
      // timeout: treat it as "nothing answered" and enter the same bounded retry.
      const aborted = error?.name === 'AbortError';
      const missing = error instanceof ApiError && (error.status === 404 || error.code === 'bad-response');
      const transport = missing || (error instanceof ApiError && error.code === 'network') || aborted;
      patch({
        ready: !missing,
        loading: false,
        reachable: !transport,
        error: aborted ? t('state.unavailable') : error instanceof ApiError ? error.message : String(error),
      });
      // Only the "nothing answered" cases are worth retrying: a 500 with a valid body still
      // renders the panel (with its banner), so retrying it would only add requests.
      if (transport) scheduleRetry(startedIn);
      return false;
    } finally {
      if (controller) activeControllers.delete(controller);
      if (timer !== null) clearTimeout(timer);
    }
  }

  function setPrefs(changes) {
    const prefs = { ...state.prefs, ...changes };
    writePrefs(prefs);
    patch({ prefs });
  }

  function toggleInList(key, value) {
    const list = state.prefs[key] ?? [];
    setPrefs({ [key]: list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value] });
  }

  function setSelection(ids) {
    patch({ selection: [...new Set(ids)] });
  }

  function toggleSelection(id) {
    const current = new Set(state.selection);
    if (current.has(id)) current.delete(id);
    else current.add(id);
    patch({ selection: [...current] });
  }

  function clearSelection() {
    if (state.selection.length === 0) return;
    patch({ selection: [] });
  }

  function topicsOf(workspaceId) {
    // The sidecar persists a workspace only after its first write; until then the system
    // default group is virtual, and every consumer (tree, pickers, composer, filters) needs
    // to see the same group.
    return withDefaultTopic(state.workspaces[workspaceId]?.topics);
  }

  function assignmentsOf(workspaceId) {
    return state.workspaces[workspaceId]?.assignments ?? {};
  }

  /**
   * Writes are serialized. Each one carries `state.revision`, so two mutations started from
   * the same snapshot would race: the second used to be rejected as a 409 and silently
   * dropped (auto-filing two new sessions is exactly that case). Chaining them means each
   * request sees the revision the previous one produced.
   */
  let mutationQueue = Promise.resolve();
  function enqueue(task) {
    const run = mutationQueue.then(task, task);
    // Keep the chain alive after a rejection; callers still observe their own failure.
    mutationQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * Applies a host mutation result, then reloads so derived counts match the document.
   * A failure also refreshes the document: `readOnly` / `warning` are only otherwise written
   * on a successful load, so a store that turned read-only mid-session would keep offering
   * edits and never show the banner.
   */
  /**
   * Service errors the panel can phrase itself. Everything else falls back to the host text —
   * the alternative was printing raw Chinese store messages in an English UI.
   */
  const ERROR_TEXT = {
    'store-locked': 'error.storeLocked',
    'store-write-failed': 'error.storeWriteFailed',
    'store-read-only': 'error.storeReadOnly',
    'store-unreadable': 'error.storeUnreadable',
    'store-future-version': 'error.storeFutureVersion',
  };

  function describe(error) {
    if (error instanceof ApiError && ERROR_TEXT[error.code]) return t(ERROR_TEXT[error.code]);
    return error instanceof ApiError ? error.message : String(error);
  }

  function runMutation(invoker) {
    return enqueue(async () => {
      patch({ busy: 'saving' });
      try {
        // Every write carries a timeout (see `api.request`). A timeout is *not* treated as a
        // definite failure: the request may have landed, so the call rejects, the queue is
        // released, and the banner asks the user to reload instead of silently claiming a
        // result the panel cannot know.
        const outcome = await invoker(state.revision, { timeoutMs: requestTimeoutMs });
        patch({ busy: null, revision: outcome.revision });
        await load();
        return outcome;
      } catch (error) {
        patch({ busy: null });
        // Only a revision mismatch is "another window changed this". A lock timeout is also a
        // 409 but means "the store is busy" — reporting it as a foreign edit sent users looking
        // for a window that did not exist.
        const conflict = error instanceof ApiError && error.code === 'revision-conflict';
        // A read-only / storage failure is a *state* change, not just a message: reload so the
        // banner reflects it. Conflicts reload too (another window moved the document on).
        if (conflict || isStateFailure(error)) await load().catch(() => {});
        patch({ error: conflict ? 'conflict' : describe(error) });
        if (conflict) throw Object.assign(error, { reloadHint: true });
        throw error;
      }
    });
  }

  /** Errors that mean "the document itself is unusable", so the panel must re-read it. */
  function isStateFailure(error) {
    const code = error instanceof ApiError ? error.code : '';
    return code === 'store-read-only'
      || code === 'store-unreadable'
      || code === 'store-write-failed'
      || code === 'store-locked'
      || code === 'store-future-version'
      || error?.status === 503;
  }

  const createTopic = (input) => runMutation((revision, options) => api.createTopic({ ...input, expectedRevision: revision }, options));
  const updateTopic = (input) => runMutation((revision, options) => api.updateTopic({ ...input, expectedRevision: revision }, options));
  const reorderTopics = (input) => runMutation((revision, options) => api.reorderTopics({ ...input, expectedRevision: revision }, options));
  const deleteTopic = (input) => runMutation((revision, options) => api.deleteTopic({ ...input, expectedRevision: revision }, options));
  const assign = (input) => runMutation((revision, options) => api.assign({ ...input, expectedRevision: revision }, options));

  /**
   * Asks the host to re-attach sessions whose `cwd` matches a workspace path but which the
   * host never accounted. This is workspace membership (host data), not the topic sidecar, so
   * it does not touch the revision and must not be serialized behind the sidecar queue.
   *
   * Deliberately silent: a host without the repair services answers `available: false` and the
   * panel carries on. When something *was* adopted the session/workspace snapshots are refreshed
   * so the rows move into their workspace immediately. `moved` is the subset this call changed
   * (a second window can see `adopted` non-empty for a write it did not make), and `failed`
   * carries the refusals the host reported so the caller can surface them instead of them
   * vanishing into a log.
   */
  async function adoptSessions() {
    try {
      const result = await api.adoptSessions({ timeoutMs: requestTimeoutMs ?? 60_000 });
      const adopted = Array.isArray(result?.adopted) ? result.adopted : [];
      const moved = Array.isArray(result?.moved) ? result.moved : adopted;
      const failed = Array.isArray(result?.failed) ? result.failed : [];
      if (adopted.length > 0) await load().catch(() => {});
      return { ...result, adopted, moved, failed };
    } catch (error) {
      // Best effort: a repair that fails is not a state change worth a banner.
      return { available: false, adopted: [], moved: [], failed: [], error: error instanceof ApiError ? error.message : String(error) };
    }
  }

  function dismissError() {
    patch({ error: null });
  }

  /** Page teardown: a pending retry must not fire against a replaced document. */
  function dispose() {
    disposed = true;
    generation += 1;
    cancelRetry();
    for (const controller of activeControllers) {
      try { controller.abort(); } catch { /* already settled */ }
    }
    activeControllers.clear();
    listeners.clear();
  }

  /**
   * Drops filters whose target disappeared (workspace closed, topic deleted).
   *
   * `topicExists(topicId, workspaceId)` answers for the paired workspace when the prefs carry
   * one. Topic ids are only unique inside a workspace — `tp_default` exists in every one — so
   * an id-only check kept a filter alive after the group it named was deleted elsewhere.
   */
  function reconcile({ workspaceExists, topicExists }) {
    const { workspaceFilter, topicFilter, topicFilterWorkspace } = state.prefs;
    if (workspaceFilter && !workspaceExists(workspaceFilter)) {
      setPrefs({ workspaceFilter: null, topicFilter: null, topicFilterWorkspace: null });
      return;
    }
    if (!topicFilter) return;
    // A document written before the pairing existed has no owner: fall back to the old
    // "does any workspace still have this id" question.
    if (!topicExists(topicFilter, topicFilterWorkspace ?? null)) {
      setPrefs({ topicFilter: null, topicFilterWorkspace: null });
    }
  }

  return {
    subscribe,
    getState,
    load,
    setPrefs,
    toggleInList,
    setSelection,
    toggleSelection,
    clearSelection,
    topicsOf,
    assignmentsOf,
    createTopic,
    updateTopic,
    reorderTopics,
    deleteTopic,
    assign,
    adoptSessions,
    dismissError,
    dispose,
    reconcile,
  };
}
