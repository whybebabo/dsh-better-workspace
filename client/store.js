/**
 * Panel state: the topic document mirrored from the host, plus UI preferences that are
 * local-only (workspace filter, collapse sets, search, selection).
 *
 * Every mutation carries the last known revision; a 409 reloads the document and surfaces
 * a conflict instead of silently clobbering another window's write.
 */
import { api, ApiError } from './api.js';
import { withDefaultTopic } from './model.js';

const PREFS_KEY = 'dsh-better-workspace:prefs:v1';
const DEFAULT_PREFS = {
  workspaceFilter: null,
  topicFilter: null,
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

export function createPanelStore() {
  const listeners = new Set();
  let state = {
    ready: false,
    loading: true,
    reachable: true,
    error: null,
    readOnly: false,
    warning: null,
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
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  const getState = () => state;

  async function load() {
    try {
      const result = await api.state();
        patch({
          ready: true,
          loading: false,
          reachable: true,
          error: null,
          readOnly: Boolean(result.readOnly),
          warning: result.warning ?? null,
          deleteAvailable: Boolean(result.deleteAvailable),
          emojis: Array.isArray(result.emojis) ? result.emojis : [],
          revision: result.revision,
          workspaces: result.workspaces ?? {},
        });
      return true;
    } catch (error) {
      patch({
        ready: true,
        loading: false,
        reachable: !(error instanceof ApiError && error.code === 'network'),
        error: error instanceof ApiError ? error.message : String(error),
      });
      return false;
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

  const selected = () => state.selection;

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
  function runMutation(invoker) {
    return enqueue(async () => {
      patch({ busy: 'saving' });
      try {
        const outcome = await invoker(state.revision);
        patch({ busy: null, revision: outcome.revision });
        await load();
        return outcome;
      } catch (error) {
        patch({ busy: null });
        const conflict = error instanceof ApiError && (error.code === 'revision-conflict' || error.status === 409);
        // A read-only / storage failure is a *state* change, not just a message: reload so the
        // banner reflects it. Conflicts reload too (another window moved the document on).
        if (conflict || isStateFailure(error)) await load().catch(() => {});
        patch({ error: conflict ? 'conflict' : error instanceof ApiError ? error.message : String(error) });
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
      || error?.status === 503;
  }

  const createTopic = (input) => runMutation((revision) => api.createTopic({ ...input, expectedRevision: revision }));
  const updateTopic = (input) => runMutation((revision) => api.updateTopic({ ...input, expectedRevision: revision }));
  const reorderTopics = (input) => runMutation((revision) => api.reorderTopics({ ...input, expectedRevision: revision }));
  const deleteTopic = (input) => runMutation((revision) => api.deleteTopic({ ...input, expectedRevision: revision }));
  const assign = (input) => runMutation((revision) => api.assign({ ...input, expectedRevision: revision }));

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
      const result = await api.adoptSessions();
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

  /** Drops a filter whose target disappeared (workspace closed, topic deleted). */
  function reconcile(entityExists) {
    const { workspaceFilter, topicFilter } = state.prefs;
    if (workspaceFilter && !entityExists(workspaceFilter)) setPrefs({ workspaceFilter: null, topicFilter: null });
    else if (topicFilter && !entityExists(topicFilter)) setPrefs({ topicFilter: null });
  }

  return {
    subscribe,
    getState,
    load,
    setPrefs,
    toggleInList,
    selected,
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
    reconcile,
  };
}

export { DEFAULT_PREFS, PREFS_KEY };
