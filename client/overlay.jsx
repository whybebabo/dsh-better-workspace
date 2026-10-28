/**
 * The overlay panel.
 *
 * Owns geometry (cover the native workspace region, inert what it covers), the topic
 * document mirrored from the host, the session/workspace snapshots from DSH, and every
 * action the panel exposes. If the region cannot be measured or the host half is missing,
 * the panel renders nothing and releases the native region — the stock sidebar always wins.
 */
import * as React from 'react';
import { createPortal } from 'react-dom';
import { observeComposerSlot, resolveComposerWorkspace } from './composer.js';
import { observeWorkspaceRegion, setRegionCovered, setRegionInert, watchRegionModals } from './geometry.js';
import { buildTree, buildWorkspaceOptions, DEFAULT_TOPIC_ID, mainSessionId, moveWithin, orderByManual, pendingStatusLabel, samePath, selectableIds, topicLabel, ungroupedSessionIds, UNGROUPED_WORKSPACE_ID, workspaceSessionIds } from './model.js';
import { createPanelStore } from './store.js';
import { beginReorder, currentDrag, endDrag, readDragPayload, reorderVerdict, sessionReorderVerdict, writeReorderPayload } from './dnd.js';
import { runSessionAction, mergeOutcomes, BATCH_LIMIT } from './batch.js';
import { cx, Popover, MenuItem, Icon, StateMark, useLanguage, TopicMark } from './widgets.jsx';
import { Header } from './header.jsx';
import { sectionKey, TopicTree } from './topic-tree.jsx';
import { BatchBar } from './batch-bar.jsx';
import { CreateTopicDialog, EditTopicDialog, DeleteTopicDialog, MoveToTopicDialog, RenameSessionDialog, RenameWorkspaceDialog, DeleteWorkspaceDialog } from './dialogs.jsx';
import { BatchResultDialog, DeleteSessionsDialog } from './results.jsx';
import { t } from './i18n.js';
import { formatRelative } from './time.js';
import { scheduleHover, schedulesOf } from './schedule.js';
import { shortcutHint } from './shortcut-hints.js';

/**
 * How long a freshly created topic keeps its landing highlight. The overlay publishes it to the
 * stylesheet as `--dts-reveal-ms`, so the fade and the class removal share one clock.
 */
const REVEAL_HIGHLIGHT_MS = 1600;

/**
 * Mirrors a host snapshot store into React state.
 *
 * `enabled: false` releases the subscription without unmounting the hook. A hidden overlay
 * must not re-render on every host list publish — the session controller republishes the
 * whole list for each wire-visible projection change, so a rail-collapsed panel would have
 * been re-rendering (to `null`) several times per turn for nothing. Re-enabling re-reads the
 * current snapshot in the same effect, so nothing is missed while suspended.
 */
function useSnapshot(source, enabled = true) {
  const [value, setValue] = React.useState(() => (typeof source?.getSnapshot === 'function' ? source.getSnapshot() : undefined));
  React.useEffect(() => {
    if (!source || typeof source.subscribe !== 'function') return undefined;
    if (!enabled) return undefined;
    setValue(typeof source.getSnapshot === 'function' ? source.getSnapshot() : undefined);
    const unsubscribe = source.subscribe((next) => setValue(typeof next === 'function' ? next() : next ?? source.getSnapshot?.()));
    return () => {
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, [source, enabled]);
  return value;
}

/**
 * The host's own "add workspace" control, still mounted under the cover.
 *
 * The panel's menu delegates to it instead of running a picker command itself: the host
 * composes the directory interaction per deployment (the OS chooser on Desktop, the in-app
 * browser when the server is reached over a tunnel or a non-loopback bind), and only its own
 * flow knows which one is mounted. `uiWorkspace.pickDirectory` exists only for the native
 * composition; the host refuses it with "the composed picker serves browse" everywhere else.
 */
function findNativeAddWorkspace(regionEl) {
  if (!regionEl) return null;
  return [...regionEl.querySelectorAll('button')].find((button) => {
    const label = (button.getAttribute('aria-label') || button.getAttribute('title') || '').trim();
    if (/^(添加工作区|add workspace|open folder)(…|\.\.\.)?$/i.test(label)) return true;
    // The shortcut is locale-independent, and only the workspace header binds ⌘/Ctrl+O.
    return /(^|\+)O$/i.test(button.getAttribute('aria-keyshortcuts') || '');
  }) ?? null;
}

/**
 * Stable-identity dispatch for the tree's callback props.
 *
 * `Section` and `SessionRow` are memoized, so every callback they receive has to keep its
 * identity across renders or the memo never matches — a fresh arrow per render re-authored
 * every mounted row for a hover, a status flip or the minute tick (measured on a 1500-session
 * tree: 55–63ms per trigger, DOM unchanged afterwards). Each handler is still written as a
 * plain closure over the current render and registered through `publish` at the end of that
 * render, so the frozen dispatcher always forwards to the newest closure and nothing can
 * capture stale state.
 */
const TREE_HANDLER_KEYS = [
  'onOpenSession', 'onMenu', 'onArchive', 'onPin', 'onRenameSession', 'onHint', 'onHintEnd',
  'onToggleWorkspaceCollapse', 'onToggleTopicCollapse', 'onToggleSelection', 'onSelectMany',
  'onFilterTopic', 'onNewSession', 'onNewSessionInTopic', 'onDropSessions', 'onRenameTopic', 'onDropOnRow', 'onToggleReveal',
];

function useStableDispatch(keys) {
  const latest = React.useRef(null);
  const frozen = React.useRef(null);
  if (frozen.current === null) {
    const dispatchers = {};
    for (const key of keys) {
      // `latest.current` is always the handlers object registered by the most recent render.
      dispatchers[key] = (...args) => latest.current?.[key]?.(...args);
    }
    frozen.current = dispatchers;
  }
  const publish = React.useCallback((handlers) => { latest.current = handlers; }, []);
  return [frozen.current, publish];
}

export function OverlayPanel({ actions, schedules }) {
  const language = useLanguage();
  const store = React.useMemo(() => createPanelStore(), []);
  // Identity-stable callbacks for the memoized tree; the closures themselves are re-registered
  // on every render (see `useStableDispatch`).
  const [treeHandlers, publishTreeHandlers] = useStableDispatch(TREE_HANDLER_KEYS);
  const [state, setState] = React.useState(() => store.getState());
  const [geom, setGeom] = React.useState({ visible: false, rect: null, reason: 'init', regionEl: null });
  const [menu, setMenu] = React.useState(null);
  const [dialog, setDialog] = React.useState(null);
  const [outcome, setOutcome] = React.useState(null);
  const [progress, setProgress] = React.useState(null);
  const [toast, setToast] = React.useState(null);
  const [composer, setComposer] = React.useState({ container: null, workspaceTitle: null });
  const [composerMenu, setComposerMenu] = React.useState(null);
  const [hint, setHint] = React.useState(null);
  const [tipTop, setTipTop] = React.useState(null);
  /** Opening a card clears the last measurement so the first paint cannot inherit it. */
  const openHint = React.useCallback((next) => {
    setTipTop(null);
    setHint(next);
  }, []);
  const [now, setNow] = React.useState(() => Date.now());
  /**
   * Bumped whenever a topic is armed so the blank-session watcher evaluates immediately.
   * A host that reuses an already-current blank may publish no new session list, and the
   * claim must not wait for an unrelated publish (or the 90s window) to run.
   */
  const [pendingEpoch, setPendingEpoch] = React.useState(0);
  const [dropHint, setDropHint] = React.useState(null);
  /**
   * The topic a create just added, kept only long enough to expand its workspace, scroll its
   * row into view and fade a highlight. Never persisted: it is a one-shot landing aid, not a
   * selection.
   */
  const [revealedTopic, setRevealedTopic] = React.useState(null);
  /** Transient collapse focus while a workspace/topic is dragged; never persisted. */
  const [dragFocus, setDragFocus] = React.useState(null);
  const tipRef = React.useRef(null);
  const pendingRef = React.useRef(null);
  /** Blank-session watcher: the first ready snapshot primes the set, so reloads never re-file. */
  const autoFileRef = React.useRef({ primed: false, seen: new Set(), busy: new Set() });
  /** Panel-owned timers. All must die with the overlay, or they outlive it and keep firing. */
  const timersRef = React.useRef({ toast: null, arm: null });

  /**
   * "On screen" is the one condition every resident subscription and timer below hangs off.
   * This is deliberately computed from `geom.visible` alone — not from `state.ready` —
   * because the geometry observer is what brings the panel back; gating it on readiness
   * would deadlock the first paint.
   *
   * The composing chip is the one exception: it is portaled into the host composer rather
   * than painted inside the covered region, so it stays on screen when the sidebar collapses
   * to the rail. Its store subscription therefore follows the seat, not the panel.
   */
  const onScreen = Boolean(geom.visible);
  const composerSeated = Boolean(composer.container);

  // The composer chip stays mounted while the sidebar is collapsed, so the open-session id it
  // renders must keep following the host list. Statuses are only needed by the tree, which is
  // unmounted while hidden, so that subscription still follows the panel alone.
  const sessionSnapshot = useSnapshot(actions.sessionStore, onScreen || composerSeated);
  const sessionStatuses = useSnapshot(actions.sessionStatusStore, onScreen);
  /**
   * The workspace list stays subscribed while hidden: the rail bridge uses it as its input.
   * "添加工作区" from the collapsed rail keeps the host's picker in the rail and expands the
   * sidebar once the new workspace lands — that transition is detected right here, so
   * suspending this one would silently break the rail (caught by
   * `the collapsed rail routes its new session and search through the panel`).
   */
  const workspaceSnapshot = useSnapshot(actions.workspaceStore);
  const scheduleSnapshot = useSnapshot(schedules, onScreen);
  const schedulesById = scheduleSnapshot?.bySession ?? null;

  React.useEffect(() => {
    if (!onScreen && !composerSeated) return undefined;
    return store.subscribe(() => setState(store.getState()));
  }, [store, onScreen, composerSeated]);
  React.useEffect(() => {
    // The catalog is read only once the panel is on screen; the store coalesces refreshes.
    // Suspending it releases the two host invalidations, so a hidden rail costs nothing.
    if (!onScreen) {
      schedules?.pause?.();
      return undefined;
    }
    schedules?.resume?.();
    schedules?.start?.();
    return undefined;
  }, [schedules, onScreen]);
  React.useEffect(() => {
    // A hidden panel does not need the sidecar document; `store.load()` on resume refreshes it,
    // so a rail-collapsed window stops issuing this GET entirely. The composer chip is the
    // exception: it is portaled outside the covered region, so a page that *starts* collapsed
    // still has to read the document once to know which topic the open session belongs to.
    if (!onScreen && !composerSeated) return undefined;
    store.load();
    return undefined;
  }, [store, onScreen, composerSeated]);
  /**
   * Workspace membership repair, once per page load.
   *
   * The host decides a session's workspace from its artifact `cwd`. A session whose cwd matches
   * a workspace but which was never accounted (a workspace re-created after deletion, a crash
   * between the header write and `attachSession`, a session resumed through a non-create path)
   * is shown by the native list — and by this panel — in the trailing 未分组 bucket. It reads
   * as "the session moved/disappeared" even though the log is intact, and removing the plugin
   * leaves it there. The host route re-attaches exactly those sessions through the official
   * `attachSession`, which re-validates the path and prepends (so the row leads its workspace,
   * like a freshly started one). Runs once, silently, and only on the first on-screen pass.
   */
  const adoptedRef = React.useRef(false);
  /**
   * One shared reporter for both call sites (first paint and the manual reload): a moved row is
   * announced, and a refused one is surfaced too — the host refuses when the session directory
   * is gone or was moved, which is exactly the case the user can still act on.
   */
  const reportAdopt = React.useCallback((result) => {
    if (!result) return;
    const moved = result.moved ?? result.adopted ?? [];
    if (moved.length > 0) {
      // The host's own list is what the tree is built from; re-read it so the rows move now.
      try {
        actions.refreshSessions();
      } catch { /* optional */ }
      flash(t('session.adopted', { n: moved.length }));
    }
    const failed = Array.isArray(result.failed) ? result.failed : [];
    if (failed.length > 0) flash(t('session.adoptRefused', { n: failed.length }), 'bad');
  }, [actions]);
  React.useEffect(() => {
    if (!onScreen || adoptedRef.current) return;
    adoptedRef.current = true;
    store.adoptSessions().then(reportAdopt);
  }, [onScreen, reportAdopt, store]);
  React.useEffect(() => {
    if (!onScreen) return undefined;
    // Aligned to the next minute boundary instead of a free-running 30s tick: `now` only feeds
    // minute-precision labels, so polling twice a minute re-rendered the whole tree for a
    // string that could not change. Setting state to the same minute is dropped by React.
    let timer = null;
    const arm = () => {
      const delay = 60_000 - (Date.now() % 60_000) + 20;
      timer = setTimeout(() => {
        setNow(Date.now());
        arm();
      }, delay);
    };
    // Re-arm on every resume so a panel that was hidden across a minute boundary is repainted
    // immediately rather than after up to a minute of stale labels.
    setNow(Date.now());
    arm();
    return () => clearTimeout(timer);
  }, [onScreen]);
  /**
   * The tree only reads `now` through minute-precision labels, so a 30s tick inside the same
   * minute must not re-render anything. Quantizing here (instead of inside the row) is what
   * makes the row fingerprints stable across those ticks.
   */
  const minuteNow = Math.floor(now / 60_000) * 60_000;
  // A scheduled-task card is taller than the old three-line tooltip; measure it once laid out
  // and keep the bottom edge on screen (the inline style only carries the unmeasured guess).
  React.useLayoutEffect(() => {
    if (!hint) {
      if (tipTop !== null) setTipTop(null);
      return;
    }
    const node = tipRef.current;
    if (!node) return;
    const maxTop = window.innerHeight - node.offsetHeight - 8;
    const next = Math.round(Math.max(8, Math.min(hint.rect.top - 2, maxTop)));
    if (next !== tipTop) setTipTop(next);
  }, [hint, now, scheduleSnapshot, tipTop]);
  React.useEffect(() => () => {
    clearTimeout(timersRef.current.toast);
    clearTimeout(timersRef.current.arm);
  }, []);

  React.useEffect(() => {
    let alive = true;
    const unsubscribe = observeComposerSlot((next) => {
      if (alive) setComposer(next);
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);

  React.useEffect(() => {
    let alive = true;
    const unsubscribe = observeWorkspaceRegion((next) => {
      if (alive) setGeom(next);
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);

  // Keep the covered native region out of the tab order while the panel is up, and hand the
  // region back whenever a native dialog opens inside it. The same toggle marks the region as
  // covered for the stylesheet, which hides it on macOS desktop (the cover there is clear).
  React.useEffect(() => {
    const region = geom.regionEl;
    if (!region) return undefined;
    const covered = geom.visible && state.ready && state.reachable;
    let modalOpen = false;
    const apply = () => {
      const own = covered && !modalOpen;
      setRegionInert(region, own);
      setRegionCovered(region, own);
    };
    apply();
    const stopWatching = covered ? watchRegionModals(region, (open) => { modalOpen = open; apply(); }) : () => {};
    return () => {
      stopWatching();
      setRegionInert(region, false);
      setRegionCovered(region, false);
    };
  }, [geom.visible, geom.regionEl, state.ready, state.reachable]);

  const prefs = state.prefs;
  const list = sessionSnapshot ?? { ids: [], byId: {} };
  const items = workspaceSnapshot?.items ?? [];
  const archivedIds = workspaceSnapshot?.archivedSessionIds ?? [];
  const pinnedIds = workspaceSnapshot?.pinnedSessionIds ?? [];

  const options = React.useMemo(() => buildWorkspaceOptions({ items, list, archivedIds }), [items, list, archivedIds]);
  const tree = React.useMemo(
    () =>
      buildTree({
        items,
        list,
        statuses: sessionStatuses,
        archivedIds,
        pinnedIds,
        topicsOf: store.topicsOf,
        assignmentsOf: store.assignmentsOf,
        prefs,
        query: prefs.searchOpen ? prefs.search : '',
        now: minuteNow,
      }),
    [items, list, sessionStatuses, archivedIds, pinnedIds, prefs, state.workspaces, store, language, minuteNow],
  );

  /**
   * The rows the current selection can still act on.
   *
   * Memoized once per render and shared by every consumer (toolbar flags, the move target, the
   * batch runner): the previous version rebuilt it 5-7 times per render with an `includes()` on
   * an array, which was O(n·m) and, worse, let the toolbar describe a different selection than
   * the one the batch actually sent. Declared above the early returns because hooks cannot
   * follow them.
   */
  const selectionSet = React.useMemo(() => new Set(state.selection), [state.selection]);
  const selectedRows = React.useMemo(
    () => tree.groups.flatMap((group) => group.sections.flatMap((section) => section.rows)).filter((row) => selectionSet.has(row.id)),
    [tree, selectionSet],
  );
  /** Ids of the selected rows that still exist in the tree — what a batch may be sent. */
  const liveSelection = React.useMemo(() => selectedRows.map((row) => row.id), [selectedRows]);

  // A filter pointing at a closed workspace or a deleted topic must not strand the panel —
  // but only once the workspace list has actually arrived, or the first empty snapshot would
  // wipe the persisted filter on every load.
  React.useEffect(() => {
    const workspacePhase = workspaceSnapshot?.phase ?? null;
    if (options.length === 0 && workspacePhase !== 'ready') return;
    // Only groups that still belong to a live workspace keep a filter alive; a deleted
    // workspace (or a topic of it) must not strand the view. `topicsOf` also carries the
    // virtual default group of workspaces that have no sidecar document yet.
    const live = new Map();
    for (const option of options) {
      live.set(option.workspaceId, new Set((store.topicsOf(option.workspaceId) ?? []).map((topic) => topic.id)));
    }
    store.reconcile({
      workspaceExists: (workspaceId) => live.has(workspaceId),
      // With a paired owner the question is answered inside that one workspace; without it (a
      // preference document from an older build) any workspace that still has the id will do.
      topicExists: (topicId, workspaceId) => (workspaceId
        ? live.get(workspaceId)?.has(topicId) === true
        : [...live.values()].some((ids) => ids.has(topicId))),
    });
  }, [options, state.workspaces, store, workspaceSnapshot?.phase]);

  /**
   * New-session filing. Two paths share one watcher so a blank is claimed exactly once:
   *
   * - an explicit "new session in this topic" arms `pendingRef`, and that topic wins;
   * - otherwise the blank stays in the workspace's **default group** unless the panel is
   *   filtered to a topic, in which case it joins the topic being looked at.
   *
   * This used to file every implicit blank into the workspace's most recently *created* topic:
   * clicking 新会话 dropped the row into a group the user was not looking at (and, before new
   * topics led the list, often at the bottom of the workspace), while the stock list puts a new
   * session first in its workspace. The default group is the
   * first bucket of every workspace and the blank sorts first inside a bucket, so leaving the
   * row unfiled reproduces the stock placement. Nothing is written to the sidecar for it.
   *
   * The first ready snapshot primes the seen set, so a blank that already existed when the
   * panel mounted (a reload with an unsaved New Session) is never re-filed.
   */
  React.useEffect(() => {
    const byId = list.byId ?? {};
    const ids = Object.keys(byId);
    const auto = autoFileRef.current;
    if (!auto.primed) {
      if (list.phase !== 'ready' && ids.length === 0) return;
      auto.primed = true;
      for (const id of ids) auto.seen.add(id);
      return;
    }

    const pending = pendingRef.current;
    if (pending && Date.now() > pending.until) {
      pendingRef.current = null;
      clearTimeout(timersRef.current.arm);
      timersRef.current.arm = null;
    }

    const active = pendingRef.current;
    if (active) {
      const workspaceForSession = (id) => {
        const session = byId[id];
        const recorded = options.find((option) => option.sessionIds.includes(id));
        if (recorded) return recorded;
        if (!session?.cwd) return null;
        return options.find((option) => samePath(option.path, session.cwd)) ?? null;
      };
      // Only a blank session is the one we just asked the host to start. Without this
      // restriction, opening an existing session right afterwards would file it by mistake.
      // It must also belong to the workspace the user clicked in: a blank created by another
      // window in a different workspace is not ours to file, and assigning it here would
      // persist a cross-workspace assignment.
      const inScope = (id) => Boolean(byId[id]?.blank
        && !byId[id]?.parentId
        && workspaceForSession(id)?.workspaceId === active.workspaceId);
      const freshBlank = ids.filter((id) => !active.seen.has(id) && inScope(id));
      // The host *reuses* an existing blank in the workspace instead of minting a new id
      // (`UiWorkspaceService.createInWorkspace`), so a claim keyed only on new ids would
      // leave the reused blank unfiled. The reused blank becomes the main view; claim it too.
      const currentId = mainSessionId(list);
      const reusedBlank = currentId && inScope(currentId) ? currentId : null;
      const target = freshBlank.includes(currentId) ? currentId : (freshBlank[0] ?? reusedBlank);
      if (!target) return;
      pendingRef.current = null;
      clearTimeout(timersRef.current.arm);
      timersRef.current.arm = null;
      auto.seen.add(target);
      // `topicId: null` is the explicit "default group" choice: start the session, but keep
      // the topic-filter auto-filing below out of it.
      if (active.topicId === null) return;
      const topic = (store.topicsOf(active.workspaceId) ?? []).find((entry) => entry.id === active.topicId);
      if (!topic) return;
      auto.busy.add(target);
      store
        .assign({ workspaceId: active.workspaceId, sessionIds: [target], topicId: active.topicId })
        .then(() => flash(t('session.movedTo', { name: topicLabel(topic) })))
        .catch(() => { /* the session stays unfiled; the row menu can still move it */ })
        .finally(() => auto.busy.delete(target));
      return;
    }

    const fresh = ids.filter((id) => !auto.seen.has(id));
    const blanks = fresh.filter((id) => byId[id]?.blank && !byId[id]?.parentId && !auto.busy.has(id));
    for (const id of fresh) if (!byId[id]?.blank || byId[id]?.parentId) auto.seen.add(id);
    // Only an active topic filter gives the implicit path a target. Without one the blank stays
    // unfiled, which is the default group (first bucket) — the stock list's placement.
    const filteredWorkspace = prefs.topicFilter
      ? options.find((option) => (store.topicsOf(option.workspaceId) ?? []).some((entry) => entry.id === prefs.topicFilter)) ?? null
      : null;
    const filteredTopic = filteredWorkspace
      ? (store.topicsOf(filteredWorkspace.workspaceId) ?? []).find((entry) => entry.id === prefs.topicFilter) ?? null
      : null;
    for (const id of blanks) {
      auto.seen.add(id);
      // The virtual default group is where unfiled sessions already live; filing into it
      // would only materialize the sidecar document for no visible change.
      if (!filteredTopic || filteredTopic.system) continue;
      // A blank can arrive before the Workspace record accounts for it; `cwd` is the same
      // fallback the tree uses, and an unmatched id simply waits for the next snapshot.
      const workspace = options.find((option) => option.sessionIds.includes(id))
        ?? options.find((option) => samePath(option.path, byId[id]?.cwd));
      // The filter names one workspace: a blank started somewhere else must not be written
      // into the filtered topic. That would be a cross-workspace assignment — exactly what
      // the drag guard refuses — and it would make the row vanish from the view it was started
      // in. Such a blank simply stays unfiled.
      if (!workspace || workspace.workspaceId !== filteredWorkspace.workspaceId) continue;
      auto.busy.add(id);
      store
        .assign({ workspaceId: workspace.workspaceId, sessionIds: [id], topicId: filteredTopic.id })
        .catch(() => { /* stays in the default bucket; the row menu can still move it */ })
        .finally(() => auto.busy.delete(id));
    }
    // Only a new session list (or workspace list) can introduce a blank to file, and arming a
    // pending topic is the one moment where a *reused* blank already sits in the current list.
    // Without this dependency array the whole scan ran on every render — each hover, toast and
    // keystroke. `pendingRef` is a ref, so the arm itself is replayed through the ref check
    // below when the list next publishes.
  }, [list, options, store, state.workspaces, pendingEpoch]);

  /**
   * Lands a just-created topic in view.
   *
   * Creating a group from the workspace ⋯ menu used to leave it wherever the tree happened to
   * be: a collapsed workspace hid it outright, and in a long list the new row could sit above
   * the scroll position. Expanding is done through the same preference the chevron writes, so
   * it survives a reload like any other expand; the scroll/highlight is transient.
   *
   * The row can reach the tree one render after this effect first runs (the create response is
   * followed by a store reload), so a bounded run of frames retries. Filters are deliberately
   * untouched: a search or "only this topic" hides other rows by the user's own choice, and
   * revealing a new group must not silently rewrite that choice.
   */
  React.useEffect(() => {
    if (!revealedTopic) return undefined;
    const rowOf = () => {
      const scope = typeof document === 'undefined' ? null : document.querySelector('.dts-overlay');
      if (!scope) return null;
      return [...scope.querySelectorAll('[data-dts-topic]')].find(
        (node) => node.dataset.dtsTopic === revealedTopic.topicId && node.dataset.dtsWorkspace === revealedTopic.workspaceId,
      ) ?? null;
    };
    const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (callback) => setTimeout(callback, 16);
    const stop = typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : clearTimeout;
    let frame = null;
    let tries = 0;
    const settle = () => {
      const row = rowOf();
      if (row) {
        if (typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'nearest' });
        return;
      }
      if (tries++ < 30) frame = raf(settle);
    };
    settle();
    const timer = setTimeout(() => setRevealedTopic(null), REVEAL_HIGHLIGHT_MS);
    return () => {
      if (frame !== null) stop(frame);
      clearTimeout(timer);
    };
  }, [revealedTopic]);

  /**
   * Expands a workspace/topic and arms the one-shot landing aid. Only collapsed entries are
   * removed, and only when something was actually collapsed: `setPrefs` persists, so an
   * unconditional write would touch localStorage and repaint the tree for nothing. The archived
   * bucket is deliberately left alone — it has nothing to do with a freshly created group.
   */
  const revealTopic = (workspaceId, topicId) => {
    const { prefs } = store.getState();
    const collapsedWorkspaces = (prefs.collapsedWorkspaces ?? []).filter((key) => key !== workspaceId);
    const collapsedTopics = (prefs.collapsedTopics ?? []).filter((key) => key !== `${workspaceId}:${topicId}`);
    if (collapsedWorkspaces.length !== (prefs.collapsedWorkspaces ?? []).length || collapsedTopics.length !== (prefs.collapsedTopics ?? []).length) {
      store.setPrefs({ collapsedWorkspaces, collapsedTopics });
    }
    setRevealedTopic({ workspaceId, topicId });
  };

  const activeTopic = React.useMemo(() => {
    if (!prefs.topicFilter) return null;
    // Ask the paired workspace first: `tp_default` exists in every workspace, so scanning the
    // whole list returned whichever one happened to come first (and its emoji).
    const scope = prefs.topicFilterWorkspace
      ? [prefs.topicFilterWorkspace, ...options.map((option) => option.workspaceId)]
      : options.map((option) => option.workspaceId);
    for (const workspaceId of scope) {
      const found = (store.topicsOf(workspaceId) ?? []).find((topic) => topic.id === prefs.topicFilter);
      if (found) return { ...found, name: topicLabel(found) };
    }
    return null;
    // `topicLabel` reads the module-level language; the memo has to recompute on a switch.
  }, [prefs.topicFilter, prefs.topicFilterWorkspace, options, state.workspaces, store, language]);

  const titles = React.useMemo(() => {
    const map = {};
    for (const id of Object.keys(list.byId ?? {})) map[id] = list.byId[id].displayTitle || list.byId[id].title || id;
    return map;
  }, [list]);

  const flash = (message, tone = 'info') => {
    // A second toast must not be cut short by the first one's timer.
    clearTimeout(timersRef.current.toast);
    setToast({ message, tone });
    timersRef.current.toast = setTimeout(() => setToast(null), 3200);
  };

  const setPrefs = (changes) => {
    // Leaving selection mode always drops the selection — a stale highlight must not survive.
    if (changes?.selectMode === false) store.clearSelection();
    return store.setPrefs(changes);
  };

  /** Stable handlers need stable leaves too: these read the store, never the render closure. */
  const toggleWorkspaceCollapse = (key) => store.toggleInList('collapsedWorkspaces', key);
  const toggleTopicCollapse = (key) => store.toggleInList('collapsedTopics', key);
  const toggleReveal = (key) => store.toggleInList('revealedBuckets', key);
  const closeHint = () => setHint(null);
  /**
   * Adds/removes a whole bucket. Reading the selection from the store instead of the render
   * closure means a stale `selectedIds` can never resurrect an id the user just removed.
   */
  const selectMany = (ids, on) => {
    const current = new Set(store.getState().selection);
    for (const id of ids) {
      if (on) current.add(id);
      else current.delete(id);
    }
    store.setSelection([...current]);
  };

  /**
   * The ids a bucket-level "select all" may take.
   *
   * One derivation (`model.selectableIds`) feeds the section header, the topic menu and the
   * workspace menu. They used to each read `section.rows`, so a bucket over the reveal limit
   * gave 60 / 69 / 70 for the same group and a batch permanent delete could target rows the
   * user had never seen. Anything held back is reported instead of silently selected.
   */
  const scopeOf = (group, section) => selectableIds(section, { revealed: (prefs.revealedBuckets ?? []).includes(sectionKey(group, section)) });
  /** Selects a bucket's visible rows, and says so when the bucket still hides some. */
  const selectBucket = (group, section) => {
    const scope = scopeOf(group, section);
    setPrefs({ selectMode: true });
    store.setSelection(scope.visible);
    if (scope.hidden.length > 0) {
      flash(t('topic.selectHidden', { shown: scope.visible.length, hidden: scope.hidden.length }), 'bad');
    }
  };

  const positionOf = (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return rect.height > 0 && event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
  };

  /**
   * `reorder` is a prop of both memoized components, so it may only change when a drag does.
   * `options` is rebuilt on every list publish, and depending on it here made the whole tree
   * re-render for a workspace-drop that could not have moved anything — read it through a ref
   * that the render keeps current instead.
   */
  const optionsRef = React.useRef(options);
  optionsRef.current = options;
  /**
   * `reorder` is memoized so the tree's memoized rows keep their props, but a drop must read the
   * *current* manual orders. A ref (not a dependency) keeps the callbacks stable and the values
   * fresh; capturing `prefs` in the memo made the second drag compute from the first drag's
   * snapshot.
   */
  const prefsRef = React.useRef(prefs);
  prefsRef.current = prefs;
  const reorder = React.useMemo(() => ({
    hint: dropHint,
    focus: dragFocus,
    onStart: (level, payload, event) => {
      beginReorder({ level, ...payload });
      setDragFocus({ level, id: payload.id, workspaceId: payload.workspaceId });
      writeReorderPayload(event.dataTransfer, { level, ...payload });
      event.dataTransfer.effectAllowed = 'move';
    },
    onHover: (event, level, target, forcedPosition) => {
      const drag = currentDrag();
      // Session drags are file drags; only a sibling row of the same topic is a reorder.
      const verdict = drag?.kind === 'file'
        ? sessionReorderVerdict(drag, target)
        : reorderVerdict(drag, { level, ...target });
      if (!verdict.ok) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      const position = forcedPosition ?? positionOf(event);
      // Topic ids are only unique inside a workspace (`tp_default` exists in every one), so
      // the hint has to carry the owner: rendering it back by id alone drew the insertion
      // line beside every workspace's default group.
      setDropHint((current) =>
        current && current.level === level && current.id === target.id
          && current.workspaceId === (target.workspaceId ?? null) && current.position === position
          ? current
          : { level, id: target.id, workspaceId: target.workspaceId ?? null, position },
      );
    },
    onLeave: (level, id, workspaceId) => {
      setDropHint((current) => (current?.level === level && current.id === id
        && (workspaceId === undefined || current.workspaceId === workspaceId)
        ? null
        : current));
    },
    onDrop: (event, level, target, forcedPosition) => {
      const drag = currentDrag();
      const verdict = reorderVerdict(drag, { level, ...target });
      setDropHint(null);
      setDragFocus(null);
      if (!verdict.ok) return;
      event.preventDefault();
      event.stopPropagation();
      endDrag();
      const position = forcedPosition ?? positionOf(event);
      if (level === 'workspace') {
        // Translate the drop against what is on screen. `workspaceOrder` is a permutation of the
        // displayed list (`orderByManual`), so anchoring on the host's raw order made the second
        // drag of a workspace land somewhere other than the insertion line promised.
        const base = orderByManual(
          optionsRef.current.map((option) => option.workspaceId),
          prefsRef.current.workspaceOrder ?? [],
        );
        setPrefs({ workspaceOrder: moveWithin(base, drag.id, target.id, position) });
        return;
      }
      const ids = (store.topicsOf(drag.workspaceId) ?? []).map((topic) => topic.id);
      store
        .reorderTopics({ workspaceId: drag.workspaceId, topicIds: moveWithin(ids, drag.id, target.id, position) })
        .catch((error) => flash(error?.message ?? String(error), 'bad'));
    },
    onEnd: () => {
      endDrag();
      setDropHint(null);
      setDragFocus(null);
    },
  }), [dropHint, dragFocus, store]);

  /**
   * Collapsed sidebar (the rail). The host keeps its own 新建会话 / 添加工作区 / 搜索会话
   * buttons there and they still run the stock flows, so the rail is bridged to the panel:
   * a new session first reopens the sidebar and then runs the very same host command the
   * expanded button runs (no workspace hint, so both land on the same page); adding a
   * workspace keeps the host's own picker in the rail, then reopens the sidebar as soon as
   * the new workspace lands (expanding earlier would cover the picker); search reopens the
   * sidebar on the panel's own search field.
   */
  /** Search is the only rail action that needs a follow-up inside the panel once it re-mounts. */
  const [railSearchPending, setRailSearchPending] = React.useState(false);
  const railAddRef = React.useRef(null);
  React.useEffect(() => {
    if (geom.visible || geom.reason !== 'rail') return undefined;
    const onCapture = (event) => {
      const button = event.target?.closest?.('button,[role="button"]');
      if (!button) return;
      // Only the collapsed sidebar's own rail. Judging by label alone hijacked any "Search"
      // button elsewhere in the app (settings, other plugin panels) into expanding the sidebar
      // and opening this panel's search.
      if (!geom.frameEl?.contains(button)) return;
      const label = (button.getAttribute('aria-label') || button.getAttribute('title') || '').trim();
      const className = String(button.className ?? '');
      const isNewSession = /newSession/i.test(className) || /^(新建会话|new session|new chat)$/i.test(label);
      const isSearch = /searchButton/i.test(className) || /^(搜索会话|搜索|search sessions|search)$/i.test(label);
      const isAddWorkspace = /^(添加工作区|add workspace|open folder)(…|\.\.\.)?$/i.test(label);
      if (isAddWorkspace) {
        // Do not cancel the event: the host's picker must stay in the rail, where the panel
        // does not cover it. Expansion waits until the workspace actually lands.
        railAddRef.current = {
          known: new Set(options.map((option) => option.workspaceId)),
          until: Date.now() + 600_000,
        };
        return;
      }
      if (!isNewSession && !isSearch) return;
      // An explicit rail action supersedes any add-workspace flow the user abandoned.
      railAddRef.current = null;
      event.preventDefault();
      event.stopPropagation();
      if (isSearch) {
        try {
          actions.toggleSidebar();
        } catch (error) {
          flash(error?.message ?? String(error), 'bad');
        }
        setRailSearchPending(true);
        return;
      }
      try {
        // Expand first, then start exactly like the host's expanded 新会话 button (which calls
        // `startSession()` without a workspace). The blank is still auto-filed by the panel.
        actions.toggleSidebar();
        Promise.resolve(actions.startSession()).catch((error) => flash(error?.message ?? String(error), 'bad'));
      } catch (error) {
        flash(error?.message ?? String(error), 'bad');
      }
    };
    document.addEventListener('click', onCapture, true);
    return () => document.removeEventListener('click', onCapture, true);
  }, [geom.visible, geom.reason, geom.frameEl, options]);

  // The rail's add-workspace flow finishes by creating the workspace; expand when that
  // workspace actually lands. A new session alone is not proof: the user may have cancelled
  // the picker and started a session another way.
  React.useEffect(() => {
    const pending = railAddRef.current;
    if (!pending) return;
    if (Date.now() > pending.until) {
      railAddRef.current = null;
      return;
    }
    if (geom.visible) {
      railAddRef.current = null;
      return;
    }
    const added = options.some((option) => !pending.known.has(option.workspaceId));
    if (!added) return;
    railAddRef.current = null;
    try {
      actions.toggleSidebar();
    } catch (error) {
      flash(error?.message ?? String(error), 'bad');
    }
  }, [options, geom.visible]);

  React.useEffect(() => {
    if (!geom.visible || !railSearchPending) return undefined;
    // The panel has just re-mounted; give it a frame before focusing its own search field.
    const timer = setTimeout(() => {
      setRailSearchPending(false);
      setPrefs({ searchOpen: true });
    }, 90);
    return () => clearTimeout(timer);
  }, [geom.visible, railSearchPending]);

  // An unusable sidecar owns nothing to paint, including the composer chip: it has no topics
  // to offer and its writes cannot land.
  if (!state.ready || !state.reachable) return null;

  // The landing highlight's clock lives in one place: the CSS animation reads this variable,
  // so the class-removal timer and the fade can never drift apart.
  const style = geom.rect
    ? { left: geom.rect.left, top: geom.rect.top, width: geom.rect.width, height: geom.rect.height, '--dts-reveal-ms': `${REVEAL_HIGHLIGHT_MS}ms` }
    : undefined;
  const pickWorkspace = (workspaceId) => setPrefs({ workspaceFilter: workspaceId, topicFilter: null, topicFilterWorkspace: null });
  /**
   * A topic id is only unique inside its workspace (`tp_default` is shared by every one), so
   * "only this topic" records the owner next to the filter. The workspace lock is written too,
   * because the tree's other consumers still read it.
   */
  const pickTopic = (topicId, workspaceId) => {
    if (!topicId) {
      // Applying a topic filter also locks its workspace; release both together.
      setPrefs({ topicFilter: null, topicFilterWorkspace: null, workspaceFilter: null });
      return;
    }
    const owner = workspaceId ?? prefs.workspaceFilter ?? null;
    setPrefs({ topicFilter: topicId, topicFilterWorkspace: owner, workspaceFilter: owner });
  };

  const openSession = (row) => {
    try {
      actions.openSession(row.id);
    } catch (error) {
      flash(error?.message ?? String(error), 'bad');
    }
  };

  /**
   * Every session id the workspace owns, independent of the current search/topic/archived
   * filters. Manual order is persisted against this set so reordering while filtered cannot
   * demote the rows the user cannot see.
   *
   * The derivation is `model.workspaceSessionIds` / `model.ungroupedSessionIds` — the same
   * functions the tree renders from. A second, slightly different copy here (insertion order,
   * subagents included, a strict path compare) is what made a drop land somewhere other than
   * the row it was dropped on.
   */
  const allSessionIdsInWorkspace = (workspaceId) => {
    const byId = list.byId ?? {};
    const selectable = (id) => !byId[id]?.blank;
    if (workspaceId === UNGROUPED_WORKSPACE_ID) {
      return ungroupedSessionIds({ workspaces: options, byId, archived: new Set(archivedIds) }).filter(selectable);
    }
    const option = options.find((entry) => entry.workspaceId === workspaceId);
    if (!option) return [];
    return workspaceSessionIds({ workspace: option, byId }).filter(selectable);
  };

  /**
   * Rows the create dialog may attach: every visible session the workspace owns, independent of
   * the panel's search, topic and archived filters. It used to read the *tree*, which is a view
   * of those filters — so with "only workspace A" applied, choosing workspace B in the dialog
   * reported B as having no history at all.
   */
  const attachableRowsInWorkspace = (workspaceId) => {
    const option = options.find((entry) => entry.workspaceId === workspaceId);
    if (!option) return [];
    const byId = list.byId ?? {};
    const topics = (store.topicsOf(workspaceId) ?? []).map((topic) => ({ id: topic.id, name: topicLabel(topic) }));
    const names = new Map(topics.map((topic) => [topic.id, topic.name]));
    const assignments = store.assignmentsOf(workspaceId) ?? {};
    const known = new Set(topics.map((topic) => topic.id));
    const buckets = new Map(topics.map((topic) => [topic.id, []]));
    for (const id of allSessionIdsInWorkspace(workspaceId)) {
      const session = byId[id];
      if (!session || session.origin === 'subagent') continue;
      // A stale assignment (the group was deleted in another window) belongs to the default
      // bucket, exactly like the tree treats it, instead of vanishing from this list.
      const assigned = assignments[id] ?? DEFAULT_TOPIC_ID;
      const topicId = known.has(assigned) ? assigned : DEFAULT_TOPIC_ID;
      buckets.get(topicId)?.push({
        id,
        title: session.displayTitle || session.title || id,
        // The picker labels each row with the group it currently sits in — the one fact that
        // differs inside the list and that attaching will change.
        topicName: names.get(topicId) ?? topicLabel({ system: true }),
        workspaceTitle: option.title,
      });
    }
    // Bucket order, the way the tree reads: a flat list with groups interleaved is noise.
    return topics.flatMap((topic) => buckets.get(topic.id) ?? []);
  };

  const finishBatch = (next) => {
    const merged = mergeOutcomes(outcome, next);
    if (merged.failed.length === 0 && merged.needsStop.length === 0) {
      setOutcome(null);
      store.clearSelection();
      setPrefs({ selectMode: false });
      flash(next.summary ?? t('result.ok', { n: next.ok.length }));
      return;
    }
    setOutcome(merged);
  };

  const runBatch = async (action, ids, options2) => {
    const targets = [...new Set(ids)];
    if (targets.length === 0) return;
    if (targets.length > BATCH_LIMIT) {
      flash(t('batch.limit'), 'bad');
      return;
    }
    try {
      const next = await runSessionAction({
        action,
        ids: targets,
        actions,
        options: options2,
        onProgress: (p) => setProgress(t('batch.progress', { done: p.done, total: p.total })),
      });
      setProgress(null);
      finishBatch(next);
    } catch (error) {
      setProgress(null);
      flash(error?.message ?? String(error), 'bad');
    }
  };

  const selectedIds = state.selection;

  /** A session dropped on another session reorders it, or files it when the topics differ. */
  const dropOnRow = (event, row) => {
    const drag = currentDrag();
    const dropped = readDragPayload(event.dataTransfer);
    const position = positionOf(event);
    setDropHint(null);
    if (!drag || drag.kind === 'reorder' || dropped.length === 0) {
      endDrag();
      return;
    }
    endDrag();
    if (drag.workspaceId !== row.workspaceId) {
      flash(t('session.crossWorkspace'), 'bad');
      return;
    }
    // The trailing 未分组 group has no sidecar document, so a drop there can never assign a
    // topic; only the same-topic reorder path below applies.
    if (row.workspaceId === UNGROUPED_WORKSPACE_ID && (drag.fromTopicId !== row.topicId || dropped.length > 1)) {
      return;
    }
    if (drag.fromTopicId !== row.topicId || dropped.length > 1) {
      const topic = (store.topicsOf(row.workspaceId) ?? []).find((entry) => entry.id === row.topicId);
      store
        .assign({ workspaceId: row.workspaceId, sessionIds: dropped, topicId: row.topicId })
        .then(() => flash(t('session.movedTo', { name: topicLabel(topic) })))
        .catch((error) => flash(error?.message ?? String(error), 'bad'));
      return;
    }
    // The reorder baseline must be the workspace's *whole* session set (not just the rows the
    // current search/filter shows) **and** in the order those rows are displayed: the manual
    // list is a permutation of the displayed order, so moving within the host order put the row
    // somewhere else as soon as a manual order already existed.
    const ids = orderByManual(
      allSessionIdsInWorkspace(row.workspaceId),
      prefs.sessionOrder?.[row.workspaceId] ?? [],
    );
    setPrefs({ sessionOrder: { ...(prefs.sessionOrder ?? {}), [row.workspaceId]: moveWithin(ids, dropped[0], row.id, position) } });
  };

  /** A drop files the dragged session(s) into the target topic (the default group included). */
  const dropSessions = ({ ids, workspaceId, topicId }) => {
    if (!ids?.length || !workspaceId || workspaceId === UNGROUPED_WORKSPACE_ID) return;
    const topic = (store.topicsOf(workspaceId) ?? []).find((entry) => entry.id === topicId);
    store
      .assign({ workspaceId, sessionIds: ids, topicId })
      .then(() => flash(t('session.movedTo', { name: topicLabel(topic) })))
      .catch((error) => flash(error?.message ?? String(error), 'bad'));
  };

  const renameTopic = ({ workspaceId, topicId, name }) => {
    store
      .updateTopic({ workspaceId, topicId, name })
      .catch((error) => flash(error?.code === 'topic-name-taken' ? t('topic.nameTaken') : error?.message ?? String(error), 'bad'));
  };

  /** Rejected drops surface as a toast instead of a popover (they carry no anchor). */
  const handleMenu = (next) => {
    if (next?.type === 'drop-rejected') {
      flash(next.reason === 'cross-workspace' ? t('session.crossWorkspace') : t('session.dragHint'), 'bad');
      return;
    }
    setMenu((current) => {
      if (!current || !next) return next;
      // Every menu keeps its trigger element (not a snapshot rect), so clicking the same
      // trigger can toggle the menu closed. The Popover excludes that element from the
      // outside-pointer test, which is what lets this click arrive instead of being closed
      // and immediately reopened on pointerdown.
      const same = current.type === next.type
        && current.anchor === next.anchor
        && (next.type !== 'session' || current.row?.id === next.row?.id)
        && (next.type !== 'topic' || current.section?.id === next.section?.id)
        && (next.type !== 'workspace' || current.group?.workspaceId === next.group?.workspaceId);
      return same ? null : next;
    });
  };
  /**
   * The workspace a batch "move to topic" applies to: the one holding most of the selection,
   * falling back to the active filter. Rows from another workspace are excluded by the caller,
   * which is what keeps a cross-workspace write from being assembled here.
   */
  const workspaceOfIds = () => {
    const counts = new Map();
    for (const row of selectedRows) counts.set(row.workspaceId, (counts.get(row.workspaceId) ?? 0) + 1);
    return [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? prefs.workspaceFilter ?? null;
  };

  /**
   * Groups with their session counts, in one pass over the assignment map. This runs on every
   * header render and inside two dialogs; counting per group made it O(groups x sessions).
   */
  function topicsWithCounts(workspaceId) {
    const counts = new Map();
    for (const topicId of Object.values(store.assignmentsOf(workspaceId) ?? {})) {
      counts.set(topicId, (counts.get(topicId) ?? 0) + 1);
    }
    return (store.topicsOf(workspaceId) ?? []).map((topic) => ({ ...topic, name: topicLabel(topic), count: counts.get(topic.id) ?? 0 }));
  }

  /**
   * How many sessions a group actually holds, read from the document rather than from the rows
   * on screen: a search or an active filter hides rows, but deleting the group still releases
   * every session in it, and the confirmation must not understate that.
   */
  const topicSessionCount = (workspaceId, topicId) => {
    let total = 0;
    for (const assigned of Object.values(store.assignmentsOf(workspaceId) ?? {})) if (assigned === topicId) total += 1;
    return total;
  };

  /**
   * Same order, wording, icons and shortcut hints as the stock session menu, with the two
   * topic commands appended after a separator. Archived rows follow the stock menu even more
   * closely: no pin (an archived session cannot be pinned), no "move to topic" — only the
   * host's own entries plus the plugin's permanent delete.
   */
  const sessionMenu = (row) => {
    const items = [];
    if (!row.archived) {
      items.push(
        <MenuItem
          key="pin"
          icon={<Icon name={row.pinned ? 'pinFilled' : 'pin'} />}
          onSelect={() => {
            setMenu(null);
            runBatch(row.pinned ? 'unpin' : 'pin', [row.id]);
          }}
        >
          {row.pinned ? t('session.unpin') : t('session.pin')}
        </MenuItem>,
      );
    }
    items.push(
      <MenuItem
        key="rename"
        icon={<Icon name="edit" />}
        hint={shortcutHint('rename')}
        onSelect={() => {
          setMenu(null);
          setDialog({ type: 'renameSession', row });
        }}
      >
        {t('action.rename')}
      </MenuItem>,
      <MenuItem
        key="fork"
        icon={<Icon name="fork" />}
        hint={shortcutHint('fork')}
        onSelect={async () => {
          setMenu(null);
          try {
            const childId = await actions.forkSession(row.id);
            if (childId) actions.openSession(childId);
          } catch (error) {
            flash(error?.message ?? String(error), 'bad');
          }
        }}
      >
        {t('session.fork')}
      </MenuItem>,
      <MenuItem
        key="archive"
        icon={<Icon name={row.archived ? 'unarchive' : 'archive'} />}
        hint={shortcutHint('archive')}
        onSelect={() => {
          setMenu(null);
          runBatch(row.archived ? 'unarchive' : 'archive', [row.id]);
        }}
      >
        {row.archived ? t('session.unarchive') : t('session.archive')}
      </MenuItem>,
      <MenuItem
        key="copy"
        icon={<Icon name="copy" />}
        onSelect={async () => {
          setMenu(null);
          try {
            await navigator.clipboard.writeText(row.id);
            flash(t('session.copied'));
          } catch {
            flash(t('session.copyFailed'), 'bad');
          }
        }}
      >
        {t('session.copyId')}
      </MenuItem>,
    );
    if (!row.archived && row.workspaceId !== UNGROUPED_WORKSPACE_ID) {
      items.push(
        <div key="sep" className="dts-menu__sep" role="separator" />,
        <MenuItem
          key="move"
          icon={<Icon name="topic" />}
          onSelect={() => {
            setMenu(null);
            setDialog({ type: 'move', ids: [row.id], workspaceId: row.workspaceId });
          }}
        >
          {t('session.moveToTopic')}
        </MenuItem>,
      );
    }
    if (state.deleteAvailable) {
      items.push(
        <MenuItem
          key="delete"
          danger
          icon={<Icon name="trash" />}
          onSelect={() => {
            setMenu(null);
            setDialog({ type: 'delete', ids: [row.id] });
          }}
        >
          {t('session.delete')}
        </MenuItem>,
      );
    }
    return items;
  };

  const topicMenu = ({ section, group }) => {
    const items = [
      <MenuItem key="filter" icon={<Icon name="filter" />} onSelect={() => { setMenu(null); pickTopic(prefs.topicFilter === section.id ? null : section.id, group.workspaceId); }}>
        {t('topic.filter')}
      </MenuItem>,
      <MenuItem key="select" icon={<Icon name="check" />} onSelect={() => { setMenu(null); selectBucket(group, section); }}>
        {t('topic.batchSelect')}
      </MenuItem>,
    ];
    // The default group is system-owned: it can be filtered, filled and selected, but not
    // renamed or deleted.
    if (section.system) return items;
    items.push(
      <MenuItem
        key="edit"
        icon={<Icon name="edit" />}
        onSelect={() => {
          const topic = (store.topicsOf(group.workspaceId) ?? []).find((entry) => entry.id === section.id);
          setMenu(null);
          if (topic) setDialog({ type: 'edit', topic, workspaceId: group.workspaceId });
        }}
      >
        {t('topic.rename')}
      </MenuItem>,
      <MenuItem
        key="delete"
        danger
        icon={<Icon name="trash" />}
        onSelect={() => {
          const topic = (store.topicsOf(group.workspaceId) ?? []).find((entry) => entry.id === section.id);
          setMenu(null);
          if (topic) setDialog({ type: 'deleteTopic', topic, workspaceId: group.workspaceId, count: topicSessionCount(group.workspaceId, section.id) });
        }}
      >
        {t('topic.delete')}
      </MenuItem>,
    );
    return items;
  };

  const workspaceMenu = (group) => [
    <MenuItem key="only" icon={<Icon name="folder" />} onSelect={() => { setMenu(null); pickWorkspace(group.workspaceId); }}>
      {t('chip.workspace', { name: group.title })}
    </MenuItem>,
    <MenuItem
      key="select"
      icon={<Icon name="check" />}
      onSelect={() => {
        setMenu(null);
        // Every bucket contributes only what it currently renders; `selectBucket` reports the
        // buckets that still hide rows instead of widening the selection behind the user's back.
        const scopes = group.sections.map((section) => scopeOf(group, section));
        setPrefs({ selectMode: true });
        store.setSelection(scopes.flatMap((scope) => scope.visible));
        const hidden = scopes.reduce((total, scope) => total + scope.hidden.length, 0);
        const shown = scopes.reduce((total, scope) => total + scope.visible.length, 0);
        if (hidden > 0) flash(t('topic.selectHidden', { shown, hidden }), 'bad');
      }}
    >
      {t('topic.batchSelect')}
    </MenuItem>,
    <MenuItem key="add" icon={<Icon name="plus" />} onSelect={() => { setMenu(null); setDialog({ type: 'create', workspaceId: group.workspaceId, reveal: true }); }}>
      {t('action.addTopic')}
    </MenuItem>,
    <div key="sep" className="dts-menu__sep" role="separator" />,
    <MenuItem
      key="rename"
      icon={<Icon name="edit" />}
      onSelect={() => { setMenu(null); setDialog({ type: 'renameWorkspace', group }); }}
    >
      {t('action.rename')}
    </MenuItem>,
    <MenuItem
      key="delete"
      danger
      icon={<Icon name="trash" />}
      onSelect={() => { setMenu(null); setDialog({ type: 'deleteWorkspace', group }); }}
    >
      {t('workspace.deleteTitle')}
    </MenuItem>,
  ];

  const headerMenu = [
    <MenuItem key="archived" icon={<Icon name="archive" />} onSelect={() => { setMenu(null); setPrefs({ showArchived: !prefs.showArchived }); }} hint={prefs.showArchived ? '✓' : ''}>
      {t('menu.showArchived')}
    </MenuItem>,
    <MenuItem
      key="collapse"
      icon={<Icon name="chevronRight" />}
      onSelect={() => {
        setMenu(null);
        setPrefs({
          collapsedWorkspaces: tree.groups.flatMap((group) => [group.workspaceId, `${group.workspaceId}:archived`]),
          collapsedTopics: tree.groups.flatMap((group) => group.sections.filter((section) => section.kind === 'topic').map((section) => `${group.workspaceId}:${section.id}`)),
        });
      }}
    >
      {t('menu.collapseAll')}
    </MenuItem>,
    <MenuItem
      key="expand"
      icon={<Icon name="chevronDown" />}
      onSelect={() => {
        setMenu(null);
        setPrefs({ collapsedWorkspaces: [], collapsedTopics: [] });
      }}
    >
      {t('menu.expandAll')}
    </MenuItem>,
    <MenuItem
      key="reload"
      icon={<Icon name="refresh" />}
      onSelect={() => {
        setMenu(null);
        store.load();
        // The manual refresh is also where a user retries the membership repair after moving a
        // directory back into place, so it is not limited to the once-per-page-load call.
        store.adoptSessions().then(reportAdopt);
        try {
          actions.refreshSessions();
        } catch { /* optional */ }
      }}
    >
      {t('menu.reload')}
    </MenuItem>,
  ];

  function newSession(workspaceId) {
    try {
      const started = actions.startSession(workspaceId ?? undefined);
      // Host commands may be async; a rejected create must not become an unhandled rejection.
      Promise.resolve(started).catch((error) => flash(error?.message ?? String(error), 'bad'));
    } catch (error) {
      flash(error?.message ?? String(error), 'bad');
    }
  }

  /**
   * "New session in this topic": DSH creates the session, so the plugin cannot know its id
   * up front. It remembers what existed before the request and files the first new blank
   * session (or the one that became the main view) into the topic, then forgets the promise.
   */
  function armTopic(workspaceId, topicId) {
    clearTimeout(timersRef.current.arm);
    pendingRef.current = { workspaceId, topicId, seen: new Set(Object.keys(list.byId ?? {})), until: Date.now() + 90_000 };
    setPendingEpoch((epoch) => epoch + 1);
    timersRef.current.arm = setTimeout(() => {
      timersRef.current.arm = null;
      const pending = pendingRef.current;
      if (pending && pending.topicId === topicId && pending.workspaceId === workspaceId && pending.until <= Date.now()) {
        pendingRef.current = null;
      }
    }, 90_000);
  }

  function startSessionUnderTopic(workspaceId, topicId) {
    armTopic(workspaceId, topicId);
    const abandon = (error) => {
      // Only this arm may be cleared: a newer + click owns `pendingRef` now.
      const pending = pendingRef.current;
      if (pending && pending.topicId === topicId && pending.workspaceId === workspaceId) {
        pendingRef.current = null;
        clearTimeout(timersRef.current.arm);
        timersRef.current.arm = null;
      }
      flash(error?.message ?? String(error), 'bad');
    };
    try {
      const started = actions.startSession(workspaceId);
      // Without this, a rejected async create left the arm alive for 90s and the next blank in
      // the workspace was filed into a topic the user never successfully started.
      Promise.resolve(started).catch(abandon);
    } catch (error) {
      abandon(error);
    }
  }

  const addWorkspace = async () => {
    // Delegate to the host's own add-workspace flow: it renders whichever directory
    // interaction this deployment composed and starts the session the stock flow starts.
    // A programmatic click still reaches the covered (inert) control, whose own handler
    // runs the host flow above the panel.
    const nativeAdd = findNativeAddWorkspace(geom.regionEl);
    if (nativeAdd) {
      // Disabled means the host's flow is already busy with a pick; opening our own
      // fallback picker on top would be a second chooser, so leave the host alone.
      if (!nativeAdd.disabled) nativeAdd.click();
      return;
    }
    try {
      const path = await actions.createWorkspace();
      if (path) flash(path);
    } catch (error) {
      flash(error?.message ?? String(error), 'bad');
    }
  };

  const menuItems = menu ? { session: () => sessionMenu(menu.row), topic: () => topicMenu(menu), workspace: () => workspaceMenu(menu.group), header: () => headerMenu }[menu.type]?.() : null;

  /**
   * Topic chip in the composer row: shows which topic the open session belongs to and lets
   * the user file it (or move it out) without leaving the input. Rendered into the seat the
   * composer module keeps right after the native workspace picker.
   */
  const composerSessionId = tree.currentSessionId ?? null;
  const composerSession = composerSessionId ? (list.byId ?? {})[composerSessionId] ?? null : null;
  /**
   * The composer's picker exposes a *title*, never an id, and titles are not unique (two
   * folders named "app"). The session itself is the authority: its workspace record or `cwd`
   * identifies the sidecar bucket the chip may write to. Only a blank session that the host
   * has not accounted yet falls back to the visible title.
   */
  const composerSessionWorkspace = composerSession
    ? options.find((option) => option.sessionIds.includes(composerSessionId))
      ?? options.find((option) => samePath(option.path, composerSession.cwd))
      ?? null
    : null;
  const composerWorkspaceId = composerSessionWorkspace?.workspaceId
    ?? resolveComposerWorkspace(composer.workspaceTitle, options);
  const composerTopics = composerWorkspaceId ? store.topicsOf(composerWorkspaceId) ?? [] : [];
  const composerAssignedId = composerWorkspaceId && composerSessionId
    ? (store.assignmentsOf(composerWorkspaceId) ?? {})[composerSessionId] ?? DEFAULT_TOPIC_ID
    : null;
  // A stale assignment (topic deleted in another window) falls back to the default group,
  // matching what the tree does with the same document.
  const composerTopic = composerAssignedId === null
    ? null
    : composerTopics.find((entry) => entry.id === composerAssignedId)
      ?? composerTopics.find((entry) => entry.id === DEFAULT_TOPIC_ID)
      ?? null;

  const assignCurrent = async (topicId) => {
    setComposerMenu(null);
    if (!composerWorkspaceId || !composerSessionId) return;
    try {
      await store.assign({ workspaceId: composerWorkspaceId, sessionIds: [composerSessionId], topicId });
      const topic = (store.topicsOf(composerWorkspaceId) ?? []).find((entry) => entry.id === topicId);
      flash(t('session.movedTo', { name: topicLabel(topic) }));
    } catch (error) {
      flash(error?.message ?? String(error), 'bad');
    }
  };

  const composerChip = composer.container && composerSessionId ? createPortal(
    // The chip controls a dialog, not a menu.
    <button
      type="button"
      className={cx('dts-composer-topic', composerTopic && 'is-set')}
      aria-haspopup="dialog"
      aria-expanded={Boolean(composerMenu)}
      title={t('composer.pickTopic')}
      onClick={(event) => setComposerMenu(
        composerMenu ? null : { el: event.currentTarget, rect: event.currentTarget.getBoundingClientRect() },
      )}
    >
      {composerTopic ? <TopicMark emoji={composerTopic.emoji} /> : <Icon name="topic" />}
      <span className="dts-composer-topic__label">{composerTopic ? topicLabel(composerTopic) : t('composer.pickTopic')}</span>
      <Icon name="chevronDown" className="dts-composer-topic__caret" />
    </button>,
    composer.container,
  ) : null;

  const composerPopover = composerMenu ? createPortal(
    <Popover anchor={composerMenu.rect} anchorEl={composerMenu.el} onClose={() => setComposerMenu(null)} width={240} align="left" className="dts-pop--composer">
      <div className="dts-pop__head">{t('composer.pickTopic')}</div>
      <div className="dts-pop__list">
        {(composerWorkspaceId ? topicsWithCounts(composerWorkspaceId) : []).map((topic) => (
          <MenuItem
            key={topic.id}
            icon={<TopicMark emoji={topic.emoji} />}
            hint={String(topic.count ?? '')}
            onSelect={() => assignCurrent(topic.id)}
          >
            {topic.name}
          </MenuItem>
        ))}
      </div>
      <div className="dts-pop__foot">
        <MenuItem
          icon={<Icon name="plus" />}
          onSelect={() => {
            setComposerMenu(null);
            // The chip is bound to the open session, so "create a group here" has to end with
            // that session filed into it — otherwise the bar would keep naming the old group.
            setDialog({
              type: 'create',
              workspaceId: composerWorkspaceId,
              composerSession: { sessionId: composerSessionId, workspaceId: composerWorkspaceId },
            });
          }}
        >
          {t('action.addTopic')}
        </MenuItem>
      </div>
    </Popover>,
    document.body,
  ) : null;

  /**
   * A hidden panel owns only the composer chip. That seat lives in the host composer, so it
   * must outlive a collision with the rail; the tree, dialogs and hover cards all belong to
   * the covered region and stay unmounted.
   */
  if (!geom.visible) {
    return (
      <>
        {composerChip}
        {composerPopover}
      </>
    );
  }

  const hintStatus = hint && !hint.row.archived
    ? hint.row.pendingKind
      ? { tone: 'warning', label: pendingStatusLabel(hint.row.pendingKind) }
      : hint.row.running
        ? { tone: 'ongoing', label: t('session.state.running') }
        : hint.row.completed
          ? { tone: 'done', label: t('session.state.completed') }
          : { tone: 'idle', label: t('session.state.idle') }
    : null;

  // Stock hover order: title, relative time, this Session's scheduled tasks, then status.
  const hintSchedule = hint ? schedulesOf(scheduleSnapshot, hint.row.id) : null;
  const hintTasks = hintSchedule?.length ? scheduleHover(hintSchedule, now) : null;

  // Registered during render (not in an effect) so the frozen dispatcher is already current
  // when the tree below renders with it on this very pass.
  publishTreeHandlers({
    onOpenSession: openSession,
    onMenu: handleMenu,
    onArchive: (row) => runBatch(row.archived ? 'unarchive' : 'archive', [row.id]),
    onPin: (row) => runBatch(row.pinned ? 'unpin' : 'pin', [row.id]),
    onRenameSession: (row) => setDialog({ type: 'renameSession', row }),
    onHint: openHint,
    onHintEnd: closeHint,
    onToggleWorkspaceCollapse: toggleWorkspaceCollapse,
    onToggleTopicCollapse: toggleTopicCollapse,
    onToggleSelection: store.toggleSelection,
    onSelectMany: selectMany,
    onFilterTopic: (topicId, workspaceId) => pickTopic(prefs.topicFilter === topicId ? null : topicId, workspaceId),
    onNewSession: newSession,
    onNewSessionInTopic: startSessionUnderTopic,
    onDropSessions: dropSessions,
    onRenameTopic: renameTopic,
    onDropOnRow: dropOnRow,
    onToggleReveal: toggleReveal,
  });

  return (
    <div className={cx('dts-overlay', menu || dialog ? 'has-floating' : null)} style={style} data-reason={geom.reason}>
      <div className="dts-panel">
        {prefs.selectMode ? (
          <BatchBar
            count={liveSelection.length}
            busy={state.busy !== null || progress !== null}
            progress={progress}
            hasArchived={selectedRows.some((row) => row.archived)}
            hasUnarchived={selectedRows.some((row) => !row.archived)}
            hasUngrouped={selectedRows.some((row) => row.workspaceId === UNGROUPED_WORKSPACE_ID)}
            deleteAvailable={state.deleteAvailable}
            onArchive={() => runBatch('archive', liveSelection)}
            onUnarchive={() => runBatch('unarchive', liveSelection)}
            onMove={() => {
              const workspaceId = workspaceOfIds();
              const movable = selectedRows.filter((row) => row.workspaceId === workspaceId);
              if (!workspaceId || workspaceId === UNGROUPED_WORKSPACE_ID || movable.length === 0) {
                flash(t('session.crossWorkspace'), 'bad');
                return;
              }
              setDialog({ type: 'move', ids: movable.map((row) => row.id), workspaceId });
            }}
            onDelete={() => setDialog({ type: 'delete', ids: liveSelection })}
            onExit={() => setPrefs({ selectMode: false })}
          />
        ) : (
          <Header
            prefs={prefs}
            options={options}
            topicsFor={topicsWithCounts}
            activeTopic={activeTopic}
            onSetPrefs={setPrefs}
            onPickWorkspace={pickWorkspace}
            onPickTopic={pickTopic}
            onAddTopic={(workspaceId, extra) => setDialog({ type: 'create', workspaceId: workspaceId ?? null, ...extra })}
            onAddWorkspace={addWorkspace}
            onCreateSession={(workspaceId, topicId) => {
              // `null` means the user explicitly picked 默认分组 — still arm the claim so the
              // newest-topic auto-file does not move the blank out of it.
              startSessionUnderTopic(workspaceId, topicId);
            }}
            onNewSession={newSession}
            onOpenHeaderMenu={(anchor) => handleMenu({ type: 'header', anchor })}
          />
        )}

        {/* One banner for "the document is not healthy": read-only only when nothing readable
            could be recovered, otherwise the reason a recovered read is still writable. The raw
            server text stays in `title` for support; the visible line is localized by code. */}
        {state.readOnly || state.warning ? (
          <div className="dts-banner dts-banner--warn" title={state.warning ?? undefined}>
            {state.warningCode
              ? t(`warning.${state.warningCode}`)
              : state.readOnly ? t('state.readonly') : state.warning}
          </div>
        ) : null}
        {state.error ? (
          <div className="dts-banner dts-banner--warn">
            {/* Every failure gets a visible line: a write rejected as read-only, a 5xx, an
                unparsable response. Before this, only `conflict` rendered and the rest were
                invisible — the user just saw "nothing happened". */}
            {state.error === 'conflict' ? t('state.conflict') : state.error}
            <button type="button" className="dts-banner__close" onClick={store.dismissError} aria-label={t('action.close')}>
              <Icon name="close" />
            </button>
          </div>
        ) : null}

        <div className="dts-scroll">
          <TopicTree
            tree={tree}
            prefs={prefs}
            reveal={revealedTopic}
            selection={selectedIds}
            schedules={schedulesById}
            onOpenSession={treeHandlers.onOpenSession}
            onMenu={treeHandlers.onMenu}
            onArchive={treeHandlers.onArchive}
            onPin={treeHandlers.onPin}
            onRenameSession={treeHandlers.onRenameSession}
            onHint={treeHandlers.onHint}
            onHintEnd={treeHandlers.onHintEnd}
            onToggleWorkspaceCollapse={treeHandlers.onToggleWorkspaceCollapse}
            onToggleTopicCollapse={treeHandlers.onToggleTopicCollapse}
            onToggleSelection={treeHandlers.onToggleSelection}
            onSelectMany={treeHandlers.onSelectMany}
            onFilterTopic={treeHandlers.onFilterTopic}
            onNewSession={treeHandlers.onNewSession}
            onNewSessionInTopic={treeHandlers.onNewSessionInTopic}
            onDropSessions={treeHandlers.onDropSessions}
            onRenameTopic={treeHandlers.onRenameTopic}
            onDropOnRow={treeHandlers.onDropOnRow}
            onToggleReveal={treeHandlers.onToggleReveal}
            reorder={reorder}
            currentWorkspaceId={tree.currentWorkspaceId}
          />
        </div>

      </div>

      {menu && menuItems ? (
        <Popover anchor={menu.anchor} onClose={() => setMenu(null)} width={menu.type === 'header' ? 220 : 240} align="right" className="dts-pop--menu">
          {menuItems}
        </Popover>
      ) : null}

      {dialog?.type === 'create' ? (
        <CreateTopicDialog
          emojis={state.emojis}
          workspaces={options}
          workspaceId={dialog.workspaceId}
          rowsFor={(workspaceId) => attachableRowsInWorkspace(workspaceId)}
          topicsFor={topicsWithCounts}
          onClose={() => setDialog(null)}
          onSubmit={async (input) => {
            const created = await store.createTopic(input);
            flash(`✓ ${created.result.topic.name}`);
            if (dialog.thenStartSession) startSessionUnderTopic(input.workspaceId, created.result.topic.id);
            if (dialog.reveal) revealTopic(input.workspaceId, created.result.topic.id);
            // The composer bar follows the open session, so a group created from the chip has to
            // end with that session filed into it — otherwise the bar keeps naming the old one.
            const target = dialog.composerSession;
            if (target?.sessionId) {
              if (target.workspaceId === input.workspaceId) {
                try {
                  await store.assign({ workspaceId: input.workspaceId, sessionIds: [target.sessionId], topicId: created.result.topic.id });
                } catch (error) {
                  // The group exists either way: a failed re-file is reported on its own instead
                  // of leaving the dialog open as if the create had failed.
                  flash(error?.message ?? String(error), 'bad');
                }
              } else {
                // The chip is bound to one session in a known workspace; a group created in
                // another one cannot own it (the panel refuses cross-workspace filing
                // everywhere). Saying so beats a chip that silently keeps its old label.
                flash(t('session.composerNotFiled'), 'bad');
              }
            }
          }}
        />
      ) : null}

      {dialog?.type === 'edit' ? (
        <EditTopicDialog
          topic={dialog.topic}
          workspaceId={dialog.workspaceId}
          topicsFor={topicsWithCounts}
          emojis={state.emojis}
          onClose={() => setDialog(null)}
          onSubmit={async (input) => {
            await store.updateTopic({ workspaceId: dialog.workspaceId, topicId: dialog.topic.id, ...input });
          }}
          onDelete={(topic) => setDialog({ type: 'deleteTopic', topic, workspaceId: dialog.workspaceId, count: topicSessionCount(dialog.workspaceId, topic.id) })}
        />
      ) : null}

      {dialog?.type === 'deleteTopic' ? (
        <DeleteTopicDialog
          topic={dialog.topic}
          count={dialog.count}
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            await store.deleteTopic({ workspaceId: dialog.workspaceId, topicId: dialog.topic.id });
            if (prefs.topicFilter === dialog.topic.id) pickTopic(null);
          }}
        />
      ) : null}

      {dialog?.type === 'move' ? (
        <MoveToTopicDialog
          count={dialog.ids.length}
          emojis={state.emojis}
          topics={topicsWithCounts(dialog.workspaceId)}
          onClose={() => setDialog(null)}
          onMove={async (topicId) => {
            const result = await store.assign({ workspaceId: dialog.workspaceId, sessionIds: dialog.ids, topicId });
            flash(`✓ ${result.result.changed}`);
          }}
          onCreate={async (input) => {
            const created = await store.createTopic({ workspaceId: dialog.workspaceId, ...input });
            return created.result.topic;
          }}
        />
      ) : null}

      {dialog?.type === 'renameSession' ? (
        <RenameSessionDialog
          row={dialog.row}
          onClose={() => setDialog(null)}
          onSubmit={async (title) => {
            await actions.renameSession(dialog.row.id, title);
            flash(t('session.renamed', { name: title }));
          }}
        />
      ) : null}

      {dialog?.type === 'renameWorkspace' ? (
        <RenameWorkspaceDialog
          workspace={dialog.group}
          workspaces={options}
          onClose={() => setDialog(null)}
          onSubmit={async (title) => {
            await actions.renameWorkspace(dialog.group.workspaceId, title);
            flash(t('workspace.renamed', { name: title }));
          }}
        />
      ) : null}

      {dialog?.type === 'deleteWorkspace' ? (
        <DeleteWorkspaceDialog
          workspace={dialog.group}
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            await actions.deleteWorkspace(dialog.group.workspaceId);
            flash(t('workspace.deleted', { name: dialog.group.title }));
          }}
        />
      ) : null}

      {dialog?.type === 'delete' ? (
        <DeleteSessionsDialog
          ids={dialog.ids}
          titles={titles}
          onClose={() => {
            setDialog(null);
            store.clearSelection();
            setPrefs({ selectMode: false });
            store.load();
          }}
          onDone={async (result) => {
            store.load();
            // Deleting rewrites session artifacts behind the host's back, so its session list
            // does not emit on its own — re-read it or the row lingers until a manual F5.
            try {
              await actions.refreshSessions();
            } catch { /* optional */ }
            // Keep the shell off a conversation whose log no longer exists.
            // `partial` means the session's own artifact is already gone (only some children
            // survived), so the shell must be moved off it exactly like a clean delete.
            if ((result?.items ?? []).some((item) => (item.status === 'deleted' || item.status === 'partial') && item.sessionId === tree.currentSessionId)) {
              try {
                actions.startSession();
              } catch { /* the host may already have moved */ }
            }
          }}
        />
      ) : null}

      {outcome ? (
        <BatchResultDialog
          outcome={{ ...outcome, titles }}
          busy={progress !== null}
          progress={progress}
          onClose={() => {
            setOutcome(null);
            store.clearSelection();
            setPrefs({ selectMode: false });
          }}
          onRetryFailed={() => runBatch(outcome.action, outcome.failed.map((entry) => entry.id))}
          onStopRunning={() => runBatch(outcome.action, outcome.needsStop, { stopActivity: true })}
        />
      ) : null}

      {composerChip}
      {composerPopover}
      {hint ? (
        <div
          ref={tipRef}
          className="dts-tip"
          style={{
            // Stock placement: flush to the right of the row, top-aligned with it.
            top: tipTop ?? Math.round(Math.max(8, Math.min(hint.rect.top - 2, window.innerHeight - 170))),
            left: Math.round(Math.min(hint.rect.right + 8, window.innerWidth - 252)),
          }}
          role="tooltip"
        >
          <div className="dts-tip__title">{hint.row.title}</div>
          {hint.row.blank ? null : <div className="dts-tip__time">{formatRelative(hint.row.updatedAt, now)}</div>}
          {hintTasks ? (
            <div className="dts-tip__tasks">
              {hintTasks.tasks.map((task) => (
                <div className="dts-tip__task" key={task.id}>
                  <span className="dts-tip__taskIcon" aria-hidden="true">
                    <Icon name="clock" size={12} />
                  </span>
                  <span className="dts-tip__taskBody">
                    <span className="dts-tip__taskName">{task.name}</span>
                    <span className="dts-tip__taskTiming">
                      {`${task.frequency} · `}
                      <time dateTime={task.scheduledAt}>{task.absolute}</time>
                      {' '}
                      <span className="dts-tip__taskRelative">{task.relative}</span>
                    </span>
                  </span>
                </div>
              ))}
              {hintTasks.omitted > 0 ? (
                <div className="dts-tip__omitted">{t('schedule.more', { count: hintTasks.omitted })}</div>
              ) : null}
            </div>
          ) : null}
          {hint.row.archived ? (
            <div className="dts-tip__status">
              <Icon name="archive" size={14} />
              {t('topic.archived')}
            </div>
          ) : (
            <div className="dts-tip__status">
              {hintStatus ? <StateMark state={hintStatus.tone} className="dts-tip__state" /> : null}
              {hintStatus?.label}
            </div>
          )}
        </div>
      ) : null}
      {toast ? <div className={cx('dts-toast', `is-${toast.tone}`)}>{toast.message}</div> : null}
      {state.busy ? <div className="dts-busy" aria-live="polite">{t('state.loading')}</div> : null}
    </div>
  );
}
