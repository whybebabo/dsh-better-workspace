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
import { observeWorkspaceRegion, setRegionInert, watchRegionModals } from './geometry.js';
import { buildTree, buildWorkspaceOptions, DEFAULT_TOPIC_ID, mainSessionId, moveWithin, newestTopic, pendingStatusLabel, topicLabel, UNGROUPED_WORKSPACE_ID } from './model.js';
import { createPanelStore } from './store.js';
import { beginReorder, currentDrag, endDrag, readDragPayload, reorderVerdict, sessionReorderVerdict, writeReorderPayload } from './dnd.js';
import { runSessionAction, mergeOutcomes, BATCH_LIMIT } from './batch.js';
import { cx, Popover, MenuItem, Icon, StateMark, useLanguage, TopicMark } from './widgets.jsx';
import { Header } from './header.jsx';
import { TopicTree } from './topic-tree.jsx';
import { BatchBar } from './batch-bar.jsx';
import { CreateTopicDialog, EditTopicDialog, DeleteTopicDialog, MoveToTopicDialog, RenameSessionDialog, RenameWorkspaceDialog, DeleteWorkspaceDialog } from './dialogs.jsx';
import { BatchResultDialog, DeleteSessionsDialog } from './results.jsx';
import { t } from './i18n.js';
import { formatRelative } from './time.js';
import { scheduleHover, schedulesOf } from './schedule.js';
import { shortcutHint } from './shortcut-hints.js';

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
 * Stable-identity dispatch for the tree's callback props.
 *
 * `Section` and `SessionRow` are memoized, so every callback they receive has to keep its
 * identity across renders or the memo never matches — a fresh arrow per render re-authored
 * all 1500 rows for a hover, a status flip or the 30s tick (measured; see
 * review/perf/PERF-REVIEW.md). Each handler is still written as a plain closure over the
 * current render and registered through `publish` at the end of that render, so the frozen
 * dispatcher always forwards to the newest closure and nothing can capture stale state.
 */
const TREE_HANDLER_KEYS = [
  'onOpenSession', 'onMenu', 'onArchive', 'onPin', 'onRenameSession', 'onHint', 'onHintEnd',
  'onToggleWorkspaceCollapse', 'onToggleTopicCollapse', 'onToggleSelection', 'onSelectMany',
  'onFilterTopic', 'onNewSession', 'onDropSessions', 'onRenameTopic', 'onDropOnRow',
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
  const [pendingTopic, setPendingTopic] = React.useState(null);
  const [dropHint, setDropHint] = React.useState(null);
  /** Transient collapse focus while a workspace/topic is dragged; never persisted. */
  const [dragFocus, setDragFocus] = React.useState(null);
  const tipRef = React.useRef(null);
  const pendingRef = React.useRef(null);
  /** Blank-session watcher: the first ready snapshot primes the set, so reloads never re-file. */
  const autoFileRef = React.useRef({ primed: false, seen: new Set(), busy: new Set() });
  /** Panel-owned timers. Both must die with the overlay, or they outlive it and keep firing. */
  const timersRef = React.useRef({ toast: null, arm: null });

  /**
   * "On screen" is the one condition every resident subscription and timer below hangs off.
   *
   * The two `return null`s in this component sit *after* the hooks, so a rail-collapsed or
   * narrow-viewport panel still ran its store subscription, minute timer, catalog retries and
   * schedule invalidation while painting nothing. This is deliberately computed from
   * `geom.visible` alone — not from `state.ready` — because the geometry observer is what
   * brings the panel back; gating it on readiness would deadlock the first paint.
   */
  const onScreen = Boolean(geom.visible);

  const sessionSnapshot = useSnapshot(actions.sessionStore, onScreen);
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
    if (!onScreen) return undefined;
    return store.subscribe(() => setState(store.getState()));
  }, [store, onScreen]);
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
    // so a rail-collapsed window stops issuing this GET entirely.
    if (!onScreen) return undefined;
    store.load();
    return undefined;
  }, [store, onScreen]);
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
  // region back whenever a native dialog opens inside it.
  React.useEffect(() => {
    const region = geom.regionEl;
    if (!region) return undefined;
    const covered = geom.visible && state.ready && state.reachable;
    let modalOpen = false;
    const apply = () => setRegionInert(region, covered && !modalOpen);
    apply();
    const stopWatching = covered ? watchRegionModals(region, (open) => { modalOpen = open; apply(); }) : () => {};
    return () => {
      stopWatching();
      setRegionInert(region, false);
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

  // A filter pointing at a closed workspace or a deleted topic must not strand the panel —
  // but only once the workspace list has actually arrived, or the first empty snapshot would
  // wipe the persisted filter on every load.
  React.useEffect(() => {
    const workspacePhase = workspaceSnapshot?.phase ?? null;
    if (options.length === 0 && workspacePhase !== 'ready') return;
    // Only groups that still belong to a live workspace keep a filter alive; a deleted
    // workspace (or a topic of it) must not strand the view. `topicsOf` also carries the
    // virtual default group of workspaces that have no sidecar document yet.
    const known = new Set();
    for (const option of options) {
      known.add(option.workspaceId);
      for (const topic of store.topicsOf(option.workspaceId)) known.add(topic.id);
    }
    store.reconcile((id) => known.has(id));
  }, [options, state.workspaces, store, workspaceSnapshot?.phase]);

  /**
   * New-session filing. Two paths share one watcher so a blank is claimed exactly once:
   *
   * - an explicit "new session in this topic" arms `pendingRef`, and that topic wins;
   * - otherwise a blank the host just created (including the stock top-left 新会话 button)
   *   lands in the workspace's most recently created topic, which is what the panel shows
   *   as the current group. A workspace without topics keeps it in the default bucket.
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
      setPendingTopic(null);
      clearTimeout(timersRef.current.arm);
      timersRef.current.arm = null;
    }

    const active = pendingRef.current;
    if (active) {
      // Only a *new blank* session is the one we just asked the host to start. Without this
      // restriction, opening an existing session right afterwards would file it by mistake.
      const freshBlank = ids.filter((id) => !active.seen.has(id) && byId[id]?.blank && !byId[id]?.parentId);
      if (freshBlank.length === 0) return;
      const currentId = mainSessionId(list);
      const target = freshBlank.includes(currentId) ? currentId : freshBlank[0];
      pendingRef.current = null;
      setPendingTopic(null);
      clearTimeout(timersRef.current.arm);
      timersRef.current.arm = null;
      auto.seen.add(target);
      // `topicId: null` is the explicit "default group" choice: start the session, but keep
      // the newest-topic auto-filing below out of it.
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
    for (const id of blanks) {
      // A blank can arrive before the Workspace record accounts for it; `cwd` is the same
      // fallback the tree uses, and an unmatched id simply waits for the next snapshot.
      const workspace = options.find((option) => option.sessionIds.includes(id))
        ?? options.find((option) => option.path && byId[id]?.cwd === option.path);
      if (!workspace) continue;
      const topic = newestTopic(store.topicsOf(workspace.workspaceId));
      // The virtual default group is where unfiled sessions already live; filing into it
      // would only materialize the sidecar document.
      if (!topic || topic.system) {
        auto.seen.add(id);
        continue;
      }
      auto.seen.add(id);
      auto.busy.add(id);
      store
        .assign({ workspaceId: workspace.workspaceId, sessionIds: [id], topicId: topic.id })
        .catch(() => { /* stays in the default bucket; the row menu can still move it */ })
        .finally(() => auto.busy.delete(id));
    }
    // Only a new session list (or workspace list) can introduce a blank to file. Without this
    // dependency array the whole scan ran on every render — each hover, toast and keystroke.
  }, [list, options, store, state.workspaces]);

  const activeTopic = React.useMemo(() => {
    if (!prefs.topicFilter) return null;
    for (const option of options) {
      const found = store.topicsOf(option.workspaceId).find((topic) => topic.id === prefs.topicFilter);
      if (found) return { ...found, name: topicLabel(found) };
    }
    return null;
  }, [prefs.topicFilter, options, state.workspaces, store]);

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
   * Drag reordering, one level at a time. Workspace order and session order are UI state
   * (prefs), topic order is data (the sidecar), so all three survive a reload — but only the
   * topic one is shared with other windows.
   */
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
      setDropHint((current) =>
        current && current.level === level && current.id === target.id && current.position === position
          ? current
          : { level, id: target.id, position },
      );
    },
    onLeave: (level, id) => {
      setDropHint((current) => (current?.level === level && current.id === id ? null : current));
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
        setPrefs({ workspaceOrder: moveWithin(optionsRef.current.map((option) => option.workspaceId), drag.id, target.id, position) });
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
  const [railIntent, setRailIntent] = React.useState(null);
  const railAddRef = React.useRef(null);
  React.useEffect(() => {
    if (geom.visible || geom.reason !== 'rail') return undefined;
    const onCapture = (event) => {
      const button = event.target?.closest?.('button,[role="button"]');
      if (!button) return;
      const label = (button.getAttribute('aria-label') || button.getAttribute('title') || '').trim();
      const className = String(button.className ?? '');
      const isNewSession = /newSession/i.test(className) || /^(新建会话|new session|new chat)$/i.test(label);
      const isSearch = /searchButton/i.test(className) || /(搜索会话|搜索|search sessions|search)/i.test(label);
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
        setRailIntent('search');
        return;
      }
      try {
        // Expand first, then start exactly like the host's expanded 新会话 button (which calls
        // `startSession()` without a workspace). The blank is still auto-filed by the panel.
        actions.toggleSidebar();
        actions.startSession();
      } catch (error) {
        flash(error?.message ?? String(error), 'bad');
      }
    };
    document.addEventListener('click', onCapture, true);
    return () => document.removeEventListener('click', onCapture, true);
  }, [geom.visible, geom.reason, options]);

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
    if (!geom.visible || !railIntent) return undefined;
    // The panel has just re-mounted; give it a frame before driving its own controls.
    const timer = setTimeout(() => {
      setRailIntent(null);
      if (railIntent === 'search') {
        setPrefs({ searchOpen: true });
        return;
      }
      const plus = document.querySelector(`.dts-header .dts-iconbtn[aria-label="${t('action.create')}"]`);
      plus?.click();
    }, 90);
    return () => clearTimeout(timer);
  }, [geom.visible, railIntent]);

  if (!state.ready || !state.reachable) return null;
  if (!geom.visible) return null;

  const style = geom.rect ? { left: geom.rect.left, top: geom.rect.top, width: geom.rect.width, height: geom.rect.height } : undefined;
  const pickWorkspace = (workspaceId) => setPrefs({ workspaceFilter: workspaceId, topicFilter: null });
  // A topic id is only unique inside its workspace (`tp_default` is shared by every
  // workspace), so "only this topic" must carry its owner along with the filter.
  const pickTopic = (topicId, workspaceId) => {
    if (!topicId) {
      // Applying a topic filter also locks its workspace; release both together.
      setPrefs({ topicFilter: null, workspaceFilter: null });
      return;
    }
    setPrefs({ topicFilter: topicId, workspaceFilter: workspaceId ?? prefs.workspaceFilter ?? null });
  };

  const openSession = (row) => {
    try {
      actions.openSession(row.id);
    } catch (error) {
      flash(error?.message ?? String(error), 'bad');
    }
  };

  const rowsInWorkspace = (workspaceId) => {
    const group = tree.groups.find((entry) => entry.workspaceId === workspaceId);
    return group ? group.sections.filter((section) => section.kind !== 'archived').flatMap((section) => section.rows) : [];
  };

  /**
   * Every session id the workspace owns, independent of the current search/topic/archived
   * filters. Manual order is persisted against this set so reordering while filtered cannot
   * demote the rows the user cannot see.
   */
  const allSessionIdsInWorkspace = (workspaceId) => {
    const option = options.find((entry) => entry.workspaceId === workspaceId);
    const known = list.byId ?? {};
    const ids = [];
    const seen = new Set();
    for (const id of option?.sessionIds ?? []) {
      if (seen.has(id) || !known[id]) continue;
      seen.add(id);
      ids.push(id);
    }
    for (const session of Object.values(known)) {
      if (!session || seen.has(session.id)) continue;
      if (session.cwd !== option?.path) continue;
      seen.add(session.id);
      ids.push(session.id);
    }
    return ids.filter((id) => !known[id]?.blank);
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
    // The reorder baseline must be the workspace's *whole* session set, not the rows the
    // current search/filter happens to show: `orderBy` pushes ids it does not find to the
    // end, so reordering while filtered would permanently demote every hidden row.
    const ids = allSessionIdsInWorkspace(row.workspaceId);
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
    setMenu(next);
  };
  const selectedRows = () => tree.groups.flatMap((group) => group.sections.flatMap((section) => section.rows)).filter((row) => selectedIds.includes(row.id));
  const workspaceOfIds = () => {
    const rows = selectedRows();
    const counts = new Map();
    for (const row of rows) counts.set(row.workspaceId, (counts.get(row.workspaceId) ?? 0) + 1);
    return [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? prefs.workspaceFilter ?? null;
  };

  function topicsWithCounts(workspaceId) {
    return (store.topicsOf(workspaceId) ?? []).map((topic) => {
      const assignments = store.assignmentsOf(workspaceId) ?? {};
      return { ...topic, name: topicLabel(topic), count: Object.values(assignments).filter((id) => id === topic.id).length };
    });
  }

  /**
   * Same order, wording, icons and shortcut hints as the stock session menu, with the two
   * topic commands appended after a separator: the host owns "what a session is", the plugin
   * only adds "which topic it lives in".
   */
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
            flash(t('session.copied'), 'bad');
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
      <MenuItem key="select" icon={<Icon name="check" />} onSelect={() => { setMenu(null); setPrefs({ selectMode: true }); store.setSelection(section.rows.filter((row) => !row.blank).map((row) => row.id)); }}>
        {t('topic.batchSelect')}
      </MenuItem>,
      <MenuItem
        key="new"
        icon={<Icon name="plus" />}
        onSelect={() => {
          setMenu(null);
          startSessionUnderTopic(group.workspaceId, section.id);
        }}
      >
        {t('topic.newSession')}
      </MenuItem>,
    ];
    // The default group is system-owned: it can be filtered, filled and selected, but not
    // renamed or deleted.
    if (section.system) return items;    items.push(
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
          if (topic) setDialog({ type: 'deleteTopic', topic, workspaceId: group.workspaceId, count: section.rows.length });
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
        setPrefs({ selectMode: true });
        store.setSelection(group.sections.flatMap((section) => section.rows.filter((row) => !row.blank).map((row) => row.id)));
      }}
    >
      {t('topic.batchSelect')}
    </MenuItem>,
    <MenuItem key="add" icon={<Icon name="plus" />} onSelect={() => { setMenu(null); setDialog({ type: 'create', workspaceId: group.workspaceId }); }}>
      {t('action.addTopic')}
    </MenuItem>,
    <MenuItem key="new" icon={<Icon name="plus" />} onSelect={() => { setMenu(null); newSession(group.workspaceId); }}>
      {t('menu.newSession')}
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
        setPrefs({ collapsedWorkspaces: tree.groups.map((group) => group.workspaceId), collapsedTopics: tree.groups.flatMap((group) => group.sections.filter((section) => section.kind === 'topic').map((section) => `${group.workspaceId}:${section.id}`)) });
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
      actions.startSession(workspaceId ?? undefined);
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
    setPendingTopic(topicId);
    timersRef.current.arm = setTimeout(() => {
      timersRef.current.arm = null;
      const pending = pendingRef.current;
      if (pending && pending.topicId === topicId && pending.workspaceId === workspaceId && pending.until <= Date.now()) {
        pendingRef.current = null;
        setPendingTopic(null);
      }
    }, 90_000);
  }

  function startSessionUnderTopic(workspaceId, topicId) {
    armTopic(workspaceId, topicId);
    try {
      actions.startSession(workspaceId);
    } catch (error) {
      pendingRef.current = null;
      setPendingTopic(null);
      clearTimeout(timersRef.current.arm);
      timersRef.current.arm = null;
      flash(error?.message ?? String(error), 'bad');
    }
  }

  const addWorkspace = async () => {
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
  const composerWorkspaceId = resolveComposerWorkspace(composer.workspaceTitle, options);
  const composerSessionId = tree.currentSessionId ?? null;
  const composerTopic = composerWorkspaceId && composerSessionId
    ? (store.topicsOf(composerWorkspaceId) ?? []).find((entry) => entry.id === ((store.assignmentsOf(composerWorkspaceId) ?? {})[composerSessionId] ?? DEFAULT_TOPIC_ID)) ?? null
    : null;

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
    <button
      type="button"
      className={cx('dts-composer-topic', composerTopic && 'is-set')}
      aria-haspopup="menu"
      aria-expanded={Boolean(composerMenu)}
      title={t('composer.pickTopic')}
      onClick={(event) => setComposerMenu(composerMenu ? null : event.currentTarget.getBoundingClientRect())}
    >
      {composerTopic ? <TopicMark emoji={composerTopic.emoji} /> : <Icon name="topic" />}
      <span className="dts-composer-topic__label">{composerTopic ? topicLabel(composerTopic) : t('composer.pickTopic')}</span>
      <Icon name="chevronDown" className="dts-composer-topic__caret" />
    </button>,
    composer.container,
  ) : null;

  const composerPopover = composerMenu ? createPortal(
    <Popover anchor={composerMenu} onClose={() => setComposerMenu(null)} width={240} align="left" className="dts-pop--composer">
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
            setDialog({ type: 'create', workspaceId: composerWorkspaceId });
          }}
        >
          {t('action.addTopic')}
        </MenuItem>
      </div>
    </Popover>,
    document.body,
  ) : null;

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
    onDropSessions: dropSessions,
    onRenameTopic: renameTopic,
    onDropOnRow: dropOnRow,
  });

  return (
    <div className={cx('dts-overlay', menu || dialog ? 'has-floating' : null)} style={style} data-reason={geom.reason}>
      <div className="dts-panel">
        {prefs.selectMode ? (
          <BatchBar
            count={selectedIds.length}
            busy={state.busy !== null || progress !== null}
            progress={progress}
            hasArchived={selectedRows().some((row) => row.archived)}
            hasUnarchived={selectedRows().some((row) => !row.archived)}
            hasUngrouped={selectedRows().some((row) => row.workspaceId === UNGROUPED_WORKSPACE_ID)}
            deleteAvailable={state.deleteAvailable}
            onArchive={() => runBatch('archive', selectedIds)}
            onUnarchive={() => runBatch('unarchive', selectedIds)}
            onMove={() => {
              const workspaceId = workspaceOfIds();
              const movable = selectedRows().filter((row) => row.workspaceId === workspaceId);
              if (!workspaceId || workspaceId === UNGROUPED_WORKSPACE_ID || movable.length === 0) {
                flash(t('session.crossWorkspace'), 'bad');
                return;
              }
              setDialog({ type: 'move', ids: movable.map((row) => row.id), workspaceId });
            }}
            onDelete={() => setDialog({ type: 'delete', ids: selectedIds })}
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
            onOpenHeaderMenu={(anchor) => setMenu({ type: 'header', anchor })}
          />
        )}

        {state.readOnly ? <div className="dts-banner dts-banner--warn">{t('state.readonly')}</div> : null}
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
        {state.warning && !state.readOnly ? <div className="dts-banner dts-banner--warn">{state.warning}</div> : null}

        <div className="dts-scroll">
          <TopicTree
            tree={tree}
            prefs={prefs}
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
            onDropSessions={treeHandlers.onDropSessions}
            onRenameTopic={treeHandlers.onRenameTopic}
            onDropOnRow={treeHandlers.onDropOnRow}
            reorder={reorder}
            pendingTopicId={pendingTopic}
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
          rowsFor={(workspaceId) => rowsInWorkspace(workspaceId).filter((row) => !row.blank)}
          topicsFor={topicsWithCounts}
          onClose={() => setDialog(null)}
          onSubmit={async (input) => {
            const created = await store.createTopic(input);
            flash(`✓ ${created.result.topic.name}`);
            if (dialog.thenStartSession) startSessionUnderTopic(input.workspaceId, created.result.topic.id);
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
          onDelete={(topic) => setDialog({ type: 'deleteTopic', topic, workspaceId: dialog.workspaceId, count: (Object.values(store.assignmentsOf(dialog.workspaceId) ?? {}).filter((id) => id === topic.id)).length })}
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
            if ((result?.items ?? []).some((item) => item.status === 'deleted' && item.sessionId === tree.currentSessionId)) {
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
