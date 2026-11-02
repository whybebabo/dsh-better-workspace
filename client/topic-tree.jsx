/**
 * The workspace → topic → session tree.
 *
 * Row geometry follows the native list; grouping is the plugin's own: topics
 * are folders inside a workspace, unfiled sessions keep a trailing bucket, and archived
 * sessions collect in a bucket that preserves their topic membership. Long buckets render
 * progressively so a workspace with hundreds of sessions does not build rows nobody reached.
 */
import * as React from 'react';
import { cx, Icon, IconButton, Checkbox, IconCaret, IconFolderOpen, IconFolderClose, StateMark, TopicMark } from './widgets.jsx';
import { SessionRow } from './session-row.jsx';
import { beginDrag, currentDrag, endDrag, evaluateDrop, readDragPayload, writeDragPayload } from './dnd.js';
import { RowMotion } from './row-motion.jsx';
import { pendingStatusLabel, REVEAL_LIMIT, selectableIds } from './model.js';
import { t } from './i18n.js';

export { REVEAL_LIMIT };

/** The key a bucket's reveal state is filed under (`collapse` uses the same composite key). */
export function sectionKey(group, section) {
  return section.kind === 'archived' ? `${group.workspaceId}:archived` : `${group.workspaceId}:${section.id}`;
}

function sectionLabel(section) {
  if (section.kind === 'archived') return t('topic.archived');
  return section.name;
}

/** Screen-reader text for an aggregate marker; the dot/spinner itself is decorative. */
function statusText(status, kind) {
  if (status === 'warning') return pendingStatusLabel(kind);
  if (status === 'done') return t('session.state.completed');
  if (status === 'ongoing') return t('session.state.running');
  return null;
}

function sectionStatusLabel(section) {
  return statusText(section.status, section.statusKind);
}

/**
 * Bodies stay mounted while the height transition runs, then leave the DOM. The CSS grid row
 * (1fr → 0fr) is what animates; keeping the subtree mounted afterwards meant a collapsed
 * workspace with a thousand sessions still held every row (and its layout) in the document, and
 * `content-visibility` cannot help a box that is on screen with zero height. `aria-hidden` and
 * `inert` keep the collapsed content out of the accessibility tree for the moment it is there.
 */
const COLLAPSE_MS = 220; // matches the 0.2s grid-row transition in styles.css
/** The drag focus fold is slower and staggered; the timer has to outlive both. */
const FOCUS_COLLAPSE_MS = 340; // matches the 0.3s transition in styles.css plus a frame
/** A fold that starts at the pointer and travels outwards, so the list settles as a wave. */
const FOCUS_STAGGER_BASE_MS = 40;
const FOCUS_STAGGER_STEP_MS = 20;
const FOCUS_STAGGER_STEPS = 4;

/** Milliseconds a focus fold waits before it starts: the pointer's own row folds first. */
function focusDelay(distance) {
  if (!Number.isFinite(distance) || distance < 0) return FOCUS_STAGGER_BASE_MS;
  return FOCUS_STAGGER_BASE_MS + Math.min(distance, FOCUS_STAGGER_STEPS) * FOCUS_STAGGER_STEP_MS;
}

function Collapse({ open, children, delay = 0, focusing = false }) {
  const [retained, setRetained] = React.useState(open);
  // Mount in the same commit as `open` so the opening transition has content to grow into.
  if (open && !retained) setRetained(true);
  React.useEffect(() => {
    if (open) return undefined;
    const timer = setTimeout(() => setRetained(false), (focusing ? FOCUS_COLLAPSE_MS : COLLAPSE_MS) + delay);
    return () => clearTimeout(timer);
  }, [open, delay, focusing]);
  return (
    <div
      className={cx('dts-collapse', !open && 'is-collapsed', focusing && 'is-focusing')}
      // Read by styles.css: a focused fold starts later the farther it sits from the drag.
      style={{ '--dts-collapse-delay': `${delay}ms` }}
      aria-hidden={open ? undefined : 'true'}
      inert={open ? undefined : ''}
    >
      <div className="dts-collapse__inner">{retained ? children : null}</div>
    </div>
  );
}

/** Where a drop on this row lands: a topic (default included) files in. */
function targetOf(section, group) {
  return { workspaceId: group.workspaceId, topicId: section.kind === 'topic' ? section.id : null };
}

/**
 * The identity `row-motion.jsx` files a row under. Topic ids are only unique inside their
 * workspace (`tp_default` exists in every one), so the owner is part of the key.
 */
function sectionMotionKey(group, section) {
  return `${group.workspaceId}:${section.kind}:${section.id ?? ''}`;
}

function GroupHeader({ group, selectMode, selectionCount, groupIds, groupHidden = 0, allSelected, onToggleGroup, onToggleCollapse, onMenu, onNewSession, isActiveWorkspace, reorder }) {
  const hint = reorder?.hint;
  const virtual = Boolean(group.virtual);
  const statusLabel = statusText(group.status, group.statusKind);
  const activeStatus = isActiveWorkspace && !group.collapsed && Boolean(group.status);
  // While selecting, count the rows a checkbox can actually reach (blanks are hidden).
  const visibleCount = selectMode ? groupIds.length : group.liveCount;
  const dropBefore = hint?.level === 'workspace' && hint.id === group.workspaceId && hint.position === 'before';
  const dropAfter = hint?.level === 'workspace' && hint.id === group.workspaceId && hint.position === 'after';
  return (
    <div
      className={cx('dts-row', 'dts-row--group', group.collapsed && 'is-collapsed', virtual && 'is-virtual', group.status && 'has-status', activeStatus && 'is-active-workspace', dropBefore && 'is-dropbefore', dropAfter && 'is-dropafter')}
      role="treeitem"
      aria-expanded={!group.collapsed}
      aria-label={statusLabel ? `${group.title} · ${statusLabel} · ${t('workspace.count', { n: visibleCount })}` : undefined}
      tabIndex={0}
      draggable={!selectMode && !virtual}
      onClick={onToggleCollapse}
      onDragStart={(event) => {
        if (virtual) return;
        // The whole workspace block is lifted, matching the topic section above: fading only
        // the 34px header left the body at full opacity while the drag said "out of the list".
        event.currentTarget.closest('.dts-group')?.setAttribute('data-dragging', 'true');
        reorder?.onStart?.('workspace', { id: group.workspaceId, workspaceId: group.workspaceId }, event);
      }}
      onDragEnd={(event) => {
        event.currentTarget.closest('.dts-group')?.removeAttribute('data-dragging');
        reorder?.onEnd?.();
      }}
      onDragOver={(event) => {
        if (virtual) return;
        reorder?.onHover?.(event, 'workspace', { id: group.workspaceId, workspaceId: group.workspaceId });
      }}
      onDrop={(event) => {
        if (virtual) return;
        reorder?.onDrop?.(event, 'workspace', { id: group.workspaceId, workspaceId: group.workspaceId });
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onToggleCollapse();
        }
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        if (virtual) return;
        onMenu({ type: 'workspace', group, anchor: event.currentTarget });
      }}
    >
      {/* Native pattern: the folder is shown at rest, the caret only while hovering. */}
      <span className="dts-row__slot" aria-hidden="true">
        {selectMode ? (
          <span onClick={(event) => event.stopPropagation()}>
            <Checkbox
              checked={groupIds.length > 0 && allSelected}
              indeterminate={selectionCount > 0 && !allSelected}
              disabled={groupIds.length === 0}
              onChange={onToggleGroup}
              label={groupHidden > 0
                ? t('topic.selectAllShown', { name: group.title, shown: groupIds.length, hidden: groupHidden })
                : t('topic.selectAll', { name: group.title })}
            />
          </span>
        ) : (
          <>
            <span className="dts-caret">
              <IconCaret className={cx('dts-caret__icon', !group.collapsed && 'is-open')} />
            </span>
            {group.status ? <StateMark state={group.status} className="dts-workspace-status" /> : null}
            <span className={cx('dts-folder', isActiveWorkspace && !group.collapsed && 'is-active')}>
              {group.collapsed ? <IconFolderClose /> : <IconFolderOpen />}
            </span>
          </>
        )}
      </span>
      <span className="dts-row__title" title={group.path || group.title}>
        <span className="dts-row__text">{group.title}</span>
      </span>
      <span className="dts-row__aside">
        <span className="dts-row__count">{t('workspace.count', { n: visibleCount })}</span>
        {virtual ? null : (
          <span className="dts-row__actions">
            <IconButton
              label={t('action.menu')}
              title={t('action.menu')}
              onClick={(event) => onMenu({ type: 'workspace', group, anchor: event.currentTarget })}
            >
              <Icon name="ellipsis" />
            </IconButton>
            <IconButton
              label={t('workspace.newSessionAria', { name: group.title })}
              title={t('workspace.newSession')}
              onClick={() => onNewSession?.(group.workspaceId)}
            >
              <Icon name="newChat" />
            </IconButton>
          </span>
        )}
      </span>
    </div>
  );
}

function SectionHeader({ section, group, selectMode, selectedIds, onToggleCollapse, onToggleSection, onMenu, onFilter, onNewSession, onDropSessions, onRename, reorder, selectableIds = [], hidden = 0, highlighted = false }) {
  // `selectableIds` is the section's visible scope (model.selectableIds — the same derivation
  // every "select all" entry point uses). A fallback to `section.rows` here is exactly the bug:
  // it meant "select all" on an over-REVEAL_LIMIT group silently grabbed rows that were never
  // rendered, and a batch delete then targeted them. An empty default keeps a mis-wired call
  // site harmless instead of dangerous.
  const ids = selectableIds;
  const selectedCount = ids.filter((id) => selectedIds.has(id)).length;
  const [dropState, setDropState] = React.useState('idle');
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(section.name ?? '');
  const virtual = Boolean(group.virtual);
  const droppable = section.kind !== 'archived' && !virtual;
  // The default group is a system group — it cannot be renamed or deleted — but the user can
  // still file it wherever they want, so it drags like any other topic.
  const draggable = section.kind === 'topic' && !selectMode && !virtual;
  const label = sectionLabel(section);
  const statusLabel = sectionStatusLabel(section);
  const hint = reorder?.hint;
  // `tp_default` is shared by every workspace, so an id-only match marked the default
  // group of every workspace while a topic was dragged over one of them.
  const dropBefore = hint?.level === 'topic' && hint.workspaceId === group.workspaceId && hint.id === section.id && hint.position === 'before';
  const dropAfter = hint?.level === 'topic' && hint.workspaceId === group.workspaceId && hint.id === section.id && hint.position === 'after';

  React.useEffect(() => {
    if (!editing) setDraft(section.name ?? '');
  }, [section.name, editing]);

  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (!next || next === section.name) return;
    onRename?.({ workspaceId: group.workspaceId, topicId: section.id, name: next });
  };

  return (
    <div
      className={cx(
        'dts-row',
        'dts-row--topic',
        section.collapsed && 'is-collapsed',
        section.kind !== 'topic' && 'is-bucket',
        dropState === 'ok' && 'is-drop-ok',
        dropState === 'no' && 'is-drop-no',
        dropBefore && 'is-dropbefore',
        dropAfter && 'is-dropafter',
        highlighted && 'is-revealed',
      )}
      role="treeitem"
      aria-expanded={!section.collapsed}
      aria-label={statusLabel ? `${label} · ${statusLabel}` : label}
      // The panel's landing aid looks a created topic up by identity: ids are unique per
      // workspace (`tp_default` is shared), so both halves of the key are written.
      data-dts-workspace={group.workspaceId}
      data-dts-topic={section.kind === 'topic' ? section.id : undefined}
      style={{ '--dts-indent': selectMode ? '8px' : '10px' }}
      tabIndex={0}
      draggable={draggable}
      onClick={onToggleCollapse}
      onDoubleClick={(event) => {
        if (section.kind !== 'topic' || section.system) return;
        // Buttons in the row action strip stop their own dblclick, but keep this guard for
        // any future control that does not.
        if (event.target?.closest?.('button, input, label, a, [role="button"]')) return;
        event.stopPropagation();
        setEditing(true);
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onToggleCollapse();
        }
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        if (virtual) return;
        if (section.kind === 'topic') onMenu({ type: 'topic', section, group, anchor: event.currentTarget });
      }}
      onDragStart={(event) => {
        if (!draggable) return;
        // The whole section is lifted, not just its 34px header: the body would otherwise
        // stay at full opacity while the row is supposedly out of the list.
        event.currentTarget.closest('.dts-section')?.setAttribute('data-dragging', 'true');
        reorder?.onStart?.('topic', { id: section.id, workspaceId: group.workspaceId }, event);
      }}
      onDragEnd={(event) => {
        event.currentTarget.closest('.dts-section')?.removeAttribute('data-dragging');
        reorder?.onEnd?.();
      }}
      onDragOver={(event) => {
        if (virtual) return;
        // Row reordering and session filing share this row, so the active drag decides.
        if (currentDrag()?.kind === 'reorder') {
          if (section.kind === 'topic') reorder?.onHover?.(event, 'topic', { id: section.id, workspaceId: group.workspaceId });
          return;
        }
        if (!droppable) return;
        const verdict = evaluateDrop(currentDrag(), targetOf(section, group));
        // Only an accepted drop opens the channel. Accepting every drag (including foreign
        // files from the desktop) is what would let an unrelated payload through.
        if (!verdict.ok) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        setDropState('ok');
      }}
      onDragLeave={() => setDropState('idle')}
      onDrop={(event) => {
        setDropState('idle');
        if (virtual) return;
        if (currentDrag()?.kind === 'reorder') {
          if (section.kind === 'topic') reorder?.onDrop?.(event, 'topic', { id: section.id, workspaceId: group.workspaceId });
          return;
        }
        if (!droppable) return;
        // No drag context means this drop did not start in this panel: ignore it entirely
        // rather than inventing a workspace scope for it.
        const drag = currentDrag();
        if (!drag) return;
        event.preventDefault();
        const dropped = readDragPayload(event.dataTransfer);
        const verdict = evaluateDrop({ ids: dropped, workspaceId: currentDrag()?.workspaceId }, targetOf(section, group));
        endDrag();
        if (!verdict.ok) {
          onMenu?.({ type: 'drop-rejected', reason: verdict.reason });
          return;
        }
        onDropSessions?.({ ids: dropped, ...targetOf(section, group) });
      }}
    >
      {selectMode ? (
        <span className="dts-row__check" onClick={(event) => event.stopPropagation()}>
          <Checkbox
            checked={ids.length > 0 && selectedCount === ids.length}
            indeterminate={selectedCount > 0 && selectedCount < ids.length}
            disabled={ids.length === 0}
            onChange={() => onToggleSection(ids, selectedCount === ids.length)}
            label={hidden > 0
              ? t('topic.selectAllShown', { name: label, shown: ids.length, hidden })
              : t('topic.selectAll', { name: label })}
          />
        </span>
      ) : (
        <span className="dts-row__slot" aria-hidden="true">
          <span className="dts-caret">
            <IconCaret className={cx('dts-caret__icon', !section.collapsed && 'is-open')} />
          </span>
          {section.status ? <StateMark state={section.status} className="dts-section-status" /> : null}
        </span>
      )}
      <TopicMark emoji={section.emoji} />
      {editing ? (
        <input
          className="dts-input dts-input--inline"
          autoFocus
          value={draft}
          maxLength={40}
          aria-label={t('topic.rename')}
          onClick={(event) => event.stopPropagation()}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === 'Enter') {
              event.preventDefault();
              commit();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              setEditing(false);
              setDraft(section.name ?? '');
            }
          }}
        />
      ) : (
        // The hover text is the name itself: the label ellipsizes in a narrow sidebar, and a
        // "double-click to rename" tip answered a question nobody asked while hiding the one
        // thing the row could not show — the full name. Renaming is still discoverable from
        // the ⋯ menu and the README.
        <span className="dts-row__title" title={section.kind === 'topic' ? label : undefined}>
          <span className="dts-row__text">{label}</span>
        </span>
      )}
      <span className="dts-row__aside">
        <span className="dts-row__count">{selectMode ? ids.length : section.total}</span>
        {virtual ? null : (
          <span className="dts-row__actions">
            {section.kind === 'topic' ? (
              <IconButton
                label={t('topic.filter')}
                title={t('topic.filter')}
                onClick={(event) => {
                  event.stopPropagation();
                  onFilter(section.id, group.workspaceId);
                }}
              >
                <Icon name="filter" />
              </IconButton>
            ) : null}
            {section.kind === 'topic' ? (
              <IconButton
                label={t('action.menu')}
                title={t('action.menu')}
                onClick={(event) => {
                  event.stopPropagation();
                  onMenu({ type: 'topic', section, group, anchor: event.currentTarget });
                }}
              >
                <Icon name="ellipsis" />
              </IconButton>
            ) : null}
            {section.kind === 'topic' ? (
              <IconButton
                label={t('topic.newSessionAria', { name: label })}
                title={t('topic.newSession')}
                onClick={() => onNewSession?.()}
              >
                <Icon name="newChat" />
              </IconButton>
            ) : null}
          </span>
        )}
      </span>
    </div>
  );
}

const Section = React.memo(function Section({ section, group, schedules, selectMode, selectedIds, query, revealed, highlighted, onToggleReveal, onOpenSession, onToggleSelection, onMenu, onArchive, onPin, onRenameSession, onHint, onHintEnd, onToggleWorkspaceCollapse, onToggleTopicCollapse, onSelectMany, onFilter, onNewSessionInTopic, onDropSessions, onRename, onDropOnRow, reorder, focusing = false, collapseDelay = 0 }) {
  // Selecting is about existing records; hide the provisional New Session placeholder while
  // the batch toolbar is active instead of offering a checkbox that cannot do anything.
  const rows = selectMode ? section.rows.filter((row) => !row.blank) : section.rows;
  const overflow = rows.length > REVEAL_LIMIT;
  const visible = overflow && !revealed ? rows.slice(0, REVEAL_LIMIT) : rows;
  // The row identity `collapse` / `select-many` label is a function of the section, so it is
  // derived here rather than passed down as a fresh closure from the tree: a new callback
  // prop on every render is exactly what kept this component's memo from ever matching.
  const collapseKey = sectionKey(group, section);
  const onToggleCollapse = React.useCallback(() => {
    if (section.kind === 'topic') onToggleTopicCollapse(collapseKey);
    else onToggleWorkspaceCollapse(collapseKey);
  }, [section.kind, collapseKey, onToggleTopicCollapse, onToggleWorkspaceCollapse]);
  // The same derivation the panel's menus and toolbar use (model.selectableIds), so the
  // header checkbox can never select a different set than "select all" in the ⋯ menu.
  const scope = React.useMemo(() => selectableIds(section, { revealed }), [section, revealed]);
  const onToggleSection = React.useCallback(
    (ids, deselect) => onSelectMany(ids, !deselect),
    [onSelectMany],
  );
  const onNewSession = React.useCallback(
    () => onNewSessionInTopic?.(group.workspaceId, section.id),
    [onNewSessionInTopic, group.workspaceId, section.id],
  );
  // One stable handler for every row instead of a fresh arrow inside the map: `SessionRow`
  // is memoized, and an inline `onDragStart` made each row's props new on every render.
  const onRowDragStart = React.useCallback((row, event) => {
    beginDrag({ ids: [row.id], workspaceId: row.workspaceId, fromTopicId: row.topicId });
    writeDragPayload(event.dataTransfer, [row.id]);
    event.dataTransfer.effectAllowed = 'move';
    reorder?.onSessionStart?.({ id: row.id, workspaceId: row.workspaceId, topicId: row.topicId });
  }, [reorder]);
  const body = (
    <>
      {visible.map((row) => (
        <SessionRow
          key={row.id}
          row={row}
          schedule={schedules?.get?.(row.id) ?? null}
          query={query}
          selectMode={selectMode}
          selected={selectedIds.has(row.id)}
          onOpen={onOpenSession}
          onToggleSelect={onToggleSelection}
          onDragStart={onRowDragStart}
          onDropOnRow={onDropOnRow}
          reorder={reorder}
          onMenu={onMenu}
          onArchive={onArchive}
          onPin={onPin}
          onRename={onRenameSession}
          onHint={onHint}
          onHintEnd={onHintEnd}
        />
      ))}
      {overflow ? (
        <button type="button" className="dts-reveal" onClick={() => onToggleReveal?.(collapseKey)}>
          {revealed ? t('action.collapse') : t('action.showAll', { n: rows.length })}
        </button>
      ) : null}
    </>
  );
  // A bare bucket (the virtual 未分组 workspace) has no grouping of its own, so it renders
  // its rows directly under the workspace header — no topic row to collapse or file into.
  if (section.bare) {
    return (
      <div className="dts-section dts-section--bare" data-dts-motion="topic" data-dts-key={sectionMotionKey(group, section)}>
        {body}
      </div>
    );
  }
  return (
    <div
      className={cx('dts-section', `dts-section--${section.kind}`)}
      // A topic travels with its header and its body: the whole section is the moving unit.
      data-dts-motion="topic"
      data-dts-key={sectionMotionKey(group, section)}
    >
      <SectionHeader
        section={section}
        group={group}
        selectMode={selectMode}
        selectedIds={selectedIds}
        selectableIds={scope.visible}
        hidden={scope.hidden.length}
        highlighted={highlighted}
        onToggleCollapse={onToggleCollapse}
        onToggleSection={onToggleSection}
        onMenu={onMenu}
        onFilter={onFilter}
        onNewSession={onNewSession}
        onDropSessions={onDropSessions}
        onRename={onRename}
        reorder={reorder}
      />
      <Collapse open={!section.collapsed} delay={collapseDelay} focusing={focusing}>{body}</Collapse>
    </div>
  );
});

export function TopicTree({
  tree,
  prefs,
  reveal,
  selection,
  schedules,
  onOpenSession,
  onMenu,
  onArchive,
  onPin,
  onRenameSession,
  onHint,
  onHintEnd,
  onToggleWorkspaceCollapse,
  onToggleTopicCollapse,
  onToggleSelection,
  onSelectMany,
  onFilterTopic,
  onNewSession,
  onNewSessionInTopic,
  onDropSessions,
  onRenameTopic,
  onDropOnRow,
  onToggleReveal,
  reorder,
  currentWorkspaceId,
}) {
  const selectedIds = React.useMemo(() => new Set(selection), [selection]);
  const selectMode = Boolean(prefs.selectMode);
  /**
   * Buckets the user expanded past `REVEAL_LIMIT`.
   *
   * Reveal lives in preferences rather than component state because selection depends on it:
   * the grouping menus in the panel must derive the same selectable set the tree rendered, and
   * a set stored inside `Section` was invisible to them (that is how the three entry points
   * came to disagree). Keyed by `sectionKey`, the same composite key collapse uses.
   */
  const revealedBuckets = React.useMemo(() => new Set(prefs.revealedBuckets ?? []), [prefs.revealedBuckets]);
  /**
   * The row being dragged, if any.
   *
   * A drag folds the rest of its level away — that is what makes "move this workspace past
   * the other seven" or "file this session into a far group" a usable drag — but the fold is
   * a slow, staggered wave instead of a single 200 ms snap: the rows nearest the pointer
   * start folding first, everything further out follows, and each body eases shut over
   * 300 ms. It also drives the taller append strips at the end of the list.
   *
   * The dragged workspace/topic folds too (carrying its open body left every target header
   * hidden behind it). A session drag folds only the *other* topics of its workspace: its own
   * topic keeps its rows, because those rows are where the session is reordered.
   */
  const focus = reorder?.dragging ?? null;
  const focusLevel = focus?.level ?? null;
  const focusTopicId = focusLevel === 'topic'
    ? focus.id
    : focusLevel === 'session'
      ? focus.topicId ?? null
      : null;
  // Index of the dragged workspace, so the fold can radiate outwards from it.
  const focusGroupIndex = focusLevel === 'workspace'
    ? tree.groups.findIndex((group) => group.workspaceId === focus.id)
    : -1;
  const lastRealWorkspace = [...tree.groups].reverse().find((group) => !group.virtual) ?? null;
  // With the virtual 未分组 group trailing the list, a workspace drag grows the end target
  // with a strip directly above it: that is the native "drop just before 未分组" position.
  const workspaceTail = focus?.level === 'workspace'
    && tree.groups.some((group) => group.virtual)
    && lastRealWorkspace
    && lastRealWorkspace.workspaceId !== focus.id;
  /**
   * The rendered order of every level, for `RowMotion`. React already knows this; handing it
   * over lets the glide skip its layout reads on every ordinary render.
   */
  const motionKeys = React.useMemo(() => {
    const keys = { workspace: [], topic: [], session: [] };
    for (const group of tree.groups) {
      keys.workspace.push(group.workspaceId);
      for (const section of group.sections) {
        keys.topic.push(sectionMotionKey(group, section));
        for (const row of section.rows) keys.session.push(row.id);
      }
    }
    return keys;
  }, [tree]);

  if (tree.groups.length === 0) {
    return (
      <div className="dts-empty">
        {tree.search ? t('state.noMatch') : t('state.emptyTopic')}
        {tree.truncated ? <span className="dts-note">{t('search.limit', { n: tree.matched })}</span> : null}
      </div>
    );
  }

  return (
    <RowMotion
      className={cx('dts-tree', selectMode && 'dts-tree--selecting')}
      label={t('section.workspaces')}
      multiselectable={selectMode}
      keys={motionKeys}
    >
      {tree.truncated ? <div className="dts-note">{t('search.limit', { n: tree.matched })}</div> : null}
      {tree.groups.map((group, groupIndex) => {
        // The same scope the section headers and the panel menus use: a workspace-level
        // "select all" can no longer reach rows the tree never mounted.
        const groupScope = group.sections.map((section) => selectableIds(section, { revealed: revealedBuckets.has(sectionKey(group, section)) }));
        const groupIds = groupScope.flatMap((scope) => scope.visible);
        const groupHidden = groupScope.reduce((total, scope) => total + scope.hidden.length, 0);
        const groupSelected = groupIds.filter((id) => selectedIds.has(id)).length;
        const topics = group.sections.filter((section) => section.kind === 'topic');
        const lastTopic = topics[topics.length - 1] ?? null;
        // Where the dragged row sits in this group, so the fold can start next to it.
        const focusTopicIndex = focusTopicId && group.workspaceId === focus.workspaceId
          ? topics.findIndex((topic) => topic.id === focusTopicId)
          : -1;
        // While a workspace is dragged, every workspace folds away — the dragged one included,
        // so its open body cannot hide the headers the pointer is aiming at. The fold is paced
        // as a wave: the source folds first, the farther groups follow, and each body eases
        // shut over 300 ms.
        const focusGroup = focusLevel === 'workspace';
        const groupCollapsed = focusGroup ? true : group.collapsed;
        const shownGroup = groupCollapsed === group.collapsed ? group : { ...group, collapsed: groupCollapsed };
        const groupDelay = focusGroup ? focusDelay(Math.abs(groupIndex - focusGroupIndex)) : 0;
        // Dragging a topic leaves a taller append strip under the last group, so "move to the
        // end" does not depend on hitting a 28px header's lower half.
        const appendTail = focusLevel === 'topic'
          && group.workspaceId === focus.workspaceId
          && lastTopic
          && lastTopic.id !== focus.id;
        return (
          <React.Fragment key={group.workspaceId}>
            {/* The group, not its header, is the moving unit: a workspace drop slides the
                whole block (header + every topic and session inside it). `RowMotion` reads
                this attribute, so putting it on the header animated 34px while the body
                jumped — the header travelled across the list on its own. */}
            <div
              className={cx('dts-group', groupCollapsed && 'is-collapsed')}
              data-dts-motion="workspace"
              data-dts-key={group.workspaceId}
            >
              {/* GroupHeader is not memoized, so its inline handlers cost one element each
                  rather than one subtree: rebuilding them here is cheaper than threading
                  stable callbacks through the group map. */}
              <GroupHeader
              group={shownGroup}
              isActiveWorkspace={group.workspaceId === currentWorkspaceId}
              selectMode={selectMode}
              selectionCount={groupSelected}
              groupIds={groupIds}
              groupHidden={groupHidden}
              allSelected={groupIds.length > 0 && groupSelected === groupIds.length}
              onToggleGroup={() => {
                if (groupSelected === groupIds.length) onSelectMany(groupIds, false);
                else onSelectMany(groupIds, true);
              }}
              onToggleCollapse={() => onToggleWorkspaceCollapse(group.workspaceId)}
              onNewSession={onNewSession}
              onMenu={onMenu}
              reorder={reorder}
            />
            <Collapse open={!groupCollapsed} delay={groupDelay} focusing={focusGroup}>
              <div className="dts-group__body">
                {group.sections.map((section) => {
                  // A topic drag folds the topics of its own workspace — the dragged one too, so
                  // its body stops covering the headers it is aimed at. A session drag folds the
                  // other topics so a far group stays reachable, while the source topic keeps the
                  // rows that make up the reorder area.
                  const focusSection = (focusLevel === 'topic' || focusLevel === 'session')
                    && group.workspaceId === focus.workspaceId
                    && section.kind === 'topic'
                    && (focusLevel === 'topic' || section.id !== focusTopicId);
                  const sectionCollapsed = focusSection ? true : section.collapsed;
                  const shownSection = sectionCollapsed === section.collapsed ? section : { ...section, collapsed: sectionCollapsed };
                  const sectionDelay = focusSection && focusTopicIndex >= 0
                    ? focusDelay(Math.abs(topics.indexOf(section) - focusTopicIndex))
                    : 0;
                  // Landing aid for a topic the user just created: `reveal` names one row, and
                  // only that row gets the fade-out highlight.
                  const highlighted = Boolean(reveal) && reveal.workspaceId === group.workspaceId && reveal.topicId === section.id;
                  return (
                    <React.Fragment key={`${section.kind}:${section.id ?? 'ungrouped'}`}>
                      <Section
                        section={shownSection}
                        group={group}
                        schedules={schedules}
                        selectMode={selectMode}
                        selectedIds={selectedIds}
                        revealed={revealedBuckets.has(sectionKey(group, section))}
                        highlighted={highlighted}
                        focusing={focusSection}
                        collapseDelay={sectionDelay}
                        onToggleReveal={onToggleReveal}
                        query={tree.search}
                        onOpenSession={onOpenSession}
                        onToggleSelection={onToggleSelection}
                        onMenu={onMenu}
                        onArchive={onArchive}
                        onPin={onPin}
                        onRenameSession={onRenameSession}
                        onHint={onHint}
                        onHintEnd={onHintEnd}
                        onToggleWorkspaceCollapse={onToggleWorkspaceCollapse}
                        onToggleTopicCollapse={onToggleTopicCollapse}
                        onSelectMany={onSelectMany}
                        onFilter={onFilterTopic}
                        onNewSessionInTopic={onNewSessionInTopic}
                        onDropSessions={onDropSessions}
                        onRename={onRenameTopic}
                        onDropOnRow={onDropOnRow}
                        reorder={reorder}
                      />
                      {appendTail && section.id === lastTopic.id ? (
                        <div
                          className="dts-drop-tail"
                          aria-hidden="true"
                          onDragOver={(event) => reorder?.onHover?.(event, 'topic', { id: lastTopic.id, workspaceId: group.workspaceId }, 'after')}
                          onDragLeave={() => reorder?.onLeave?.('topic', lastTopic.id, group.workspaceId)}
                          onDrop={(event) => reorder?.onDrop?.(event, 'topic', { id: lastTopic.id, workspaceId: group.workspaceId }, 'after')}
                        />
                      ) : null}
                    </React.Fragment>
                  );
                })}
              </div>
            </Collapse>
            </div>
            {workspaceTail && !group.virtual && group.workspaceId === lastRealWorkspace.workspaceId ? (
              <div
                className="dts-drop-tail"
                aria-hidden="true"
                onDragOver={(event) => reorder?.onHover?.(event, 'workspace', { id: lastRealWorkspace.workspaceId, workspaceId: lastRealWorkspace.workspaceId }, 'after')}
                onDragLeave={() => reorder?.onLeave?.('workspace', lastRealWorkspace.workspaceId, lastRealWorkspace.workspaceId)}
                onDrop={(event) => reorder?.onDrop?.(event, 'workspace', { id: lastRealWorkspace.workspaceId, workspaceId: lastRealWorkspace.workspaceId }, 'after')}
              />
            ) : null}
          </React.Fragment>
        );
      })}
    </RowMotion>
  );
}
