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
import { buildTree, buildWorkspaceOptions, DEFAULT_TOPIC_ID, mainSessionId, newestTopic, topicLabel } from './model.js';
import { createPanelStore } from './store.js';
import { runSessionAction, mergeOutcomes, BATCH_LIMIT } from './batch.js';
import { cx, Popover, MenuItem, Icon, useLanguage, TopicMark } from './widgets.jsx';
import { Header } from './header.jsx';
import { TopicTree } from './topic-tree.jsx';
import { BatchBar } from './batch-bar.jsx';
import { CreateTopicDialog, EditTopicDialog, DeleteTopicDialog, MoveToTopicDialog, RenameSessionDialog } from './dialogs.jsx';
import { BatchResultDialog, DeleteSessionsDialog } from './results.jsx';
import { t } from './i18n.js';
import { formatRelative } from './time.js';
import { shortcutHint } from './shortcut-hints.js';

function useSnapshot(source) {
  const [value, setValue] = React.useState(() => (typeof source?.getSnapshot === 'function' ? source.getSnapshot() : undefined));
  React.useEffect(() => {
    if (!source || typeof source.subscribe !== 'function') return undefined;
    setValue(typeof source.getSnapshot === 'function' ? source.getSnapshot() : undefined);
    const unsubscribe = source.subscribe((next) => setValue(typeof next === 'function' ? next() : next ?? source.getSnapshot?.()));
    return () => {
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, [source]);
  return value;
}

export function OverlayPanel({ actions }) {
  useLanguage();
  const store = React.useMemo(() => createPanelStore(), []);
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
  const [now, setNow] = React.useState(() => Date.now());
  const [pendingTopic, setPendingTopic] = React.useState(null);
  const pendingRef = React.useRef(null);
  /** Blank-session watcher: the first ready snapshot primes the set, so reloads never re-file. */
  const autoFileRef = React.useRef({ primed: false, seen: new Set(), busy: new Set() });
  /** Panel-owned timers. Both must die with the overlay, or they outlive it and keep firing. */
  const timersRef = React.useRef({ toast: null, arm: null });

  const sessionSnapshot = useSnapshot(actions.sessionStore);
  const workspaceSnapshot = useSnapshot(actions.workspaceStore);

  React.useEffect(() => store.subscribe(() => setState(store.getState())), [store]);
  React.useEffect(() => {
    store.load();
  }, [store]);
  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
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
        archivedIds,
        pinnedIds,
        topicsOf: store.topicsOf,
        assignmentsOf: store.assignmentsOf,
        prefs,
        query: prefs.searchOpen ? prefs.search : '',
      }),
    [items, list, archivedIds, pinnedIds, prefs, state.workspaces, store],
  );

  // A filter pointing at a closed workspace or a deleted topic must not strand the panel —
  // but only once the workspace list has actually arrived, or the first empty snapshot would
  // wipe the persisted filter on every load.
  React.useEffect(() => {
    if (options.length === 0) return;
    const known = new Set(options.map((option) => option.workspaceId));
    for (const bucket of Object.values(state.workspaces)) (bucket.topics ?? []).forEach((topic) => known.add(topic.id));
    store.reconcile((id) => known.has(id));
  }, [options, state.workspaces, store]);

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
        .then(() => flash(t('session.movedTo', { name: topic.name })))
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
      if (!topic) {
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
  });

  const activeTopic = React.useMemo(() => {
    if (!prefs.topicFilter) return null;
    for (const workspaceId of Object.keys(state.workspaces)) {
      const found = (state.workspaces[workspaceId].topics ?? []).find((topic) => topic.id === prefs.topicFilter);
      if (found) return found;
    }
    return null;
  }, [prefs.topicFilter, state.workspaces]);

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

  if (!state.ready || !state.reachable) return null;
  if (!geom.visible) return null;

  const style = geom.rect ? { left: geom.rect.left, top: geom.rect.top, width: geom.rect.width, height: geom.rect.height } : undefined;

  const setPrefs = (changes) => {
    // Leaving selection mode always drops the selection — a stale highlight must not survive.
    if (changes?.selectMode === false) store.clearSelection();
    return store.setPrefs(changes);
  };
  const pickWorkspace = (workspaceId) => setPrefs({ workspaceFilter: workspaceId, topicFilter: null });
  const pickTopic = (topicId) => setPrefs({ topicFilter: topicId });

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

  /** A drop files the dragged session(s) into the target topic (the default group included). */
  const dropSessions = ({ ids, workspaceId, topicId }) => {
    if (!ids?.length || !workspaceId) return;
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
    if (!row.archived) {
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
      <MenuItem key="filter" icon={<Icon name="filter" />} onSelect={() => { setMenu(null); pickTopic(prefs.topicFilter === section.id ? null : section.id); }}>
        {t('topic.filter')}
      </MenuItem>,
      <MenuItem key="select" icon={<Icon name="check" />} onSelect={() => { setMenu(null); setPrefs({ selectMode: true }); store.setSelection(section.rows.map((row) => row.id)); }}>
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
        store.setSelection(group.sections.flatMap((section) => section.rows.map((row) => row.id)));
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

  return (
    <div className={cx('dts-overlay', menu || dialog ? 'has-floating' : null)} style={style} data-reason={geom.reason}>
      <div className="dts-panel">
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

        {state.readOnly ? <div className="dts-banner dts-banner--warn">{t('state.readonly')}</div> : null}
        {state.error === 'conflict' ? (
          <div className="dts-banner dts-banner--warn">
            {t('state.conflict')}
            <button type="button" className="dts-banner__close" onClick={store.dismissError}>
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
            now={now}
            onOpenSession={openSession}
            onMenu={handleMenu}
            onArchive={(row) => runBatch(row.archived ? 'unarchive' : 'archive', [row.id])}
            onPin={(row) => runBatch(row.pinned ? 'unpin' : 'pin', [row.id])}
            onRenameSession={(row) => setDialog({ type: 'renameSession', row })}
            onHint={setHint}
            onHintEnd={() => setHint(null)}
            onToggleWorkspaceCollapse={(key) => store.toggleInList('collapsedWorkspaces', key)}
            onToggleTopicCollapse={(key) => store.toggleInList('collapsedTopics', key)}
            onToggleSelection={store.toggleSelection}
            onSelectMany={(ids, on) => {
              const current = new Set(store.getState().selection);
              for (const id of ids) {
                if (on) current.add(id);
                else current.delete(id);
              }
              store.setSelection([...current]);
            }}
            onFilterTopic={(topicId) => pickTopic(prefs.topicFilter === topicId ? null : topicId)}
            onAddTopic={(workspaceId) => setDialog({ type: 'create', workspaceId })}
            onDropSessions={dropSessions}
            onRenameTopic={renameTopic}
            pendingTopicId={pendingTopic}
            currentWorkspaceId={tree.currentWorkspaceId}
          />
        </div>

        {prefs.selectMode ? (
          <BatchBar
            count={selectedIds.length}
            busy={state.busy !== null || progress !== null}
            progress={progress}
            hasArchived={selectedRows().some((row) => row.archived)}
            hasUnarchived={selectedRows().some((row) => !row.archived)}
            deleteAvailable={state.deleteAvailable}
            onArchive={() => runBatch('archive', selectedIds)}
            onUnarchive={() => runBatch('unarchive', selectedIds)}
            onMove={() => setDialog({ type: 'move', ids: selectedIds, workspaceId: workspaceOfIds() })}
            onDelete={() => setDialog({ type: 'delete', ids: selectedIds })}
            onClear={() => {
              setPrefs({ selectMode: false });
              store.clearSelection();
            }}
          />
        ) : null}
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
          onDone={() => store.load()}
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
          className="dts-tip"
          style={{
            // Stock placement: flush to the right of the row, top-aligned with it.
            top: Math.round(Math.max(8, Math.min(hint.rect.top - 2, window.innerHeight - 170))),
            left: Math.round(Math.min(hint.rect.right + 8, window.innerWidth - 252)),
          }}
          role="tooltip"
        >
          <div className="dts-tip__title">{hint.row.title}</div>
          {hint.row.blank ? null : <div className="dts-tip__meta">{formatRelative(hint.row.updatedAt, now)}</div>}
          {hint.row.archived ? (
            <div className="dts-tip__meta dts-tip__badge">
              <Icon name="archive" size={14} />
              {t('topic.archived')}
            </div>
          ) : (
            <div className="dts-tip__meta dts-tip__badge">
              <span className="dts-tip__dot" aria-hidden="true" />
              {hint.row.running ? t('session.state.running') : t('session.state.idle')}
            </div>
          )}
        </div>
      ) : null}
      {toast ? <div className={cx('dts-toast', `is-${toast.tone}`)}>{toast.message}</div> : null}
      {state.busy ? <div className="dts-busy" aria-live="polite">{t('state.loading')}</div> : null}
    </div>
  );
}
