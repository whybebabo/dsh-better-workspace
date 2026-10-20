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
import { pendingStatusLabel } from './model.js';
import { t } from './i18n.js';

export const REVEAL_LIMIT = 60;

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
 * Bodies stay mounted so expand/collapse can animate; the CSS grid row (1fr → 0fr) gives the
 * height transition and clips the overflow. `aria-hidden` keeps collapsed content out of the
 * accessibility tree while it is still in the DOM.
 */
function Collapse({ open, children }) {
  return (
    <div className={cx('dts-collapse', !open && 'is-collapsed')} aria-hidden={open ? undefined : 'true'} inert={open ? undefined : ''}>
      <div className="dts-collapse__inner">{children}</div>
    </div>
  );
}

/** Where a drop on this row lands: a topic (default included) files in. */
function targetOf(section, group) {
  return { workspaceId: group.workspaceId, topicId: section.kind === 'topic' ? section.id : null };
}

function GroupHeader({ group, selectMode, selectionCount, groupIds, allSelected, onToggleGroup, onToggleCollapse, onMenu, onNewSession, isActiveWorkspace, reorder }) {
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
        reorder?.onStart?.('workspace', { id: group.workspaceId, workspaceId: group.workspaceId }, event);
      }}
      onDragEnd={reorder?.onEnd}
      onDragOver={(event) => {
        if (virtual) return;
        reorder?.onHover?.(event, 'workspace', { id: group.workspaceId, workspaceId: group.workspaceId });
      }}
      onDrop={(event) => {
        if (virtual) return;
        reorder?.onDrop?.(event, 'workspace', { id: group.workspaceId, workspaceId: group.workspaceId });
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onToggleCollapse();
        }
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        if (virtual) return;
        onMenu({ type: 'workspace', group, anchor: event.currentTarget.getBoundingClientRect() });
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
              label={`${group.title} 全选`}
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
              onClick={(event) => onMenu({ type: 'workspace', group, anchor: event.currentTarget.getBoundingClientRect() })}
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

function SectionHeader({ section, group, selectMode, selectedIds, pending, onToggleCollapse, onToggleSection, onMenu, onFilter, onDropSessions, onRename, reorder, selectableIds }) {
  // Only rows the user can actually see may be selected by the header checkbox. Using the
  // full `section.rows` here meant "select all" on an over-REVEAL_LIMIT group silently
  // grabbed rows that were never rendered — and a batch delete then targeted them.
  const ids = selectableIds ?? section.rows.filter((row) => !row.blank).map((row) => row.id);
  const selectedCount = ids.filter((id) => selectedIds.has(id)).length;
  const hidden = Math.max(0, section.rows.filter((row) => !row.blank).length - ids.length);
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
  const dropBefore = hint?.level === 'topic' && hint.id === section.id && hint.position === 'before';
  const dropAfter = hint?.level === 'topic' && hint.id === section.id && hint.position === 'after';

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
        pending && 'is-pending',
        dropBefore && 'is-dropbefore',
        dropAfter && 'is-dropafter',
      )}
      role="treeitem"
      aria-expanded={!section.collapsed}
      aria-label={statusLabel ? `${label} · ${statusLabel}` : label}
      style={{ '--dts-indent': selectMode ? '8px' : '10px' }}
      tabIndex={0}
      draggable={draggable}
      title={section.kind === 'topic' && !section.system ? t('topic.renameHint') : undefined}
      onClick={onToggleCollapse}
      onDoubleClick={(event) => {
        if (section.kind !== 'topic' || section.system) return;
        event.stopPropagation();
        setEditing(true);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onToggleCollapse();
        }
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        if (virtual) return;
        if (section.kind === 'topic') onMenu({ type: 'topic', section, group, anchor: event.currentTarget.getBoundingClientRect() });
      }}
      onDragStart={(event) => {
        if (!draggable) return;
        reorder?.onStart?.('topic', { id: section.id, workspaceId: group.workspaceId }, event);
      }}
      onDragEnd={reorder?.onEnd}
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
            label={hidden > 0 ? `${label} 全选(仅已显示的 ${ids.length} 条,另有 ${hidden} 条未展开)` : `${label} 全选`}
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
        <span className="dts-row__title"><span className="dts-row__text">{label}</span></span>
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
                  onMenu({ type: 'topic', section, group, anchor: event.currentTarget.getBoundingClientRect() });
                }}
              >
                <Icon name="ellipsis" />
              </IconButton>
            ) : null}
          </span>
        )}
      </span>
    </div>
  );
}

const Section = React.memo(function Section({ section, group, schedules, selectMode, selectedIds, now, query, pendingTopicId, onOpenSession, onToggleSelection, onMenu, onArchive, onPin, onRenameSession, onHint, onHintEnd, onToggleCollapse, onToggleSection, onFilter, onDropSessions, onRename, onDropOnRow, reorder }) {
  const [revealed, setRevealed] = React.useState(false);
  // Selecting is about existing records; hide the provisional New Session placeholder while
  // the batch toolbar is active instead of offering a checkbox that cannot do anything.
  const rows = selectMode ? section.rows.filter((row) => !row.blank) : section.rows;
  const overflow = rows.length > REVEAL_LIMIT;
  const visible = overflow && !revealed ? rows.slice(0, REVEAL_LIMIT) : rows;
  const body = (
    <>
      {visible.map((row) => (
        <SessionRow
          key={row.id}
          row={row}
          schedule={schedules?.get?.(row.id) ?? null}
          now={now}
          query={query}
          selectMode={selectMode}
          selected={selectedIds.has(row.id)}
          onOpen={onOpenSession}
          onToggleSelect={onToggleSelection}
          onDragStart={(row, event) => {
            beginDrag({ ids: [row.id], workspaceId: row.workspaceId, fromTopicId: row.topicId });
            writeDragPayload(event.dataTransfer, [row.id]);
            event.dataTransfer.effectAllowed = 'move';
          }}
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
        <button type="button" className="dts-reveal" onClick={() => setRevealed((value) => !value)}>
          {revealed ? t('action.collapse') : t('action.showAll', { n: section.rows.length })}
        </button>
      ) : null}
    </>
  );
  // A bare bucket (the virtual 未分组 workspace) has no grouping of its own, so it renders
  // its rows directly under the workspace header — no topic row to collapse or file into.
  if (section.bare) {
    return <div className="dts-section dts-section--bare">{body}</div>;
  }
  return (
    <div className={cx('dts-section', `dts-section--${section.kind}`)}>
      <SectionHeader
        section={section}
        group={group}
        selectMode={selectMode}
        selectedIds={selectedIds}
        selectableIds={visible.filter((row) => !row.blank).map((row) => row.id)}
        pending={section.kind === 'topic' && pendingTopicId === section.id}
        onToggleCollapse={onToggleCollapse}
        onToggleSection={onToggleSection}
        onMenu={onMenu}
        onFilter={onFilter}
        onDropSessions={onDropSessions}
        onRename={onRename}
        reorder={reorder}
      />
      <Collapse open={!section.collapsed}>{body}</Collapse>
    </div>
  );
});

export function TopicTree({
  tree,
  prefs,
  selection,
  schedules,
  now,
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
  onDropSessions,
  onRenameTopic,
  onDropOnRow,
  reorder,
  pendingTopicId,
  currentWorkspaceId,
}) {
  const selectedIds = React.useMemo(() => new Set(selection), [selection]);
  const selectMode = Boolean(prefs.selectMode);
  /** During a reorder drag, everything at the same level except the dragged row collapses. */
  const focus = reorder?.focus ?? null;
  const lastRealWorkspace = [...tree.groups].reverse().find((group) => !group.virtual) ?? null;
  // With the virtual 未分组 group trailing the list, a workspace drag grows the end target
  // with a strip directly above it: that is the native "drop just before 未分组" position.
  const workspaceTail = focus?.level === 'workspace'
    && tree.groups.some((group) => group.virtual)
    && lastRealWorkspace
    && lastRealWorkspace.workspaceId !== focus.id;

  if (tree.groups.length === 0) {
    return (
      <div className="dts-empty">
        {tree.search ? t('state.noMatch') : t('state.emptyTopic')}
        {tree.truncated ? <span className="dts-note">{t('search.limit', { n: tree.matched })}</span> : null}
      </div>
    );
  }

  return (
    <div
      className={cx('dts-tree', selectMode && 'dts-tree--selecting')}
      role="tree"
      aria-label={t('section.workspaces')}
      aria-multiselectable={selectMode ? true : undefined}
    >
      {tree.truncated ? <div className="dts-note">{t('search.limit', { n: tree.matched })}</div> : null}
      {tree.groups.map((group) => {
        const groupIds = group.sections.flatMap((section) => section.rows.filter((row) => !row.blank).map((row) => row.id));
        const groupSelected = groupIds.filter((id) => selectedIds.has(id)).length;
        const groupCollapsed = focus?.level === 'workspace' && group.workspaceId !== focus.id ? true : group.collapsed;
        const shownGroup = groupCollapsed === group.collapsed ? group : { ...group, collapsed: groupCollapsed };
        const topics = group.sections.filter((section) => section.kind === 'topic');
        const lastTopic = topics[topics.length - 1] ?? null;
        // Dragging a topic leaves a taller append strip under the last group, so "move to the
        // end" does not depend on hitting a 28px header's lower half.
        const appendTail = focus?.level === 'topic'
          && group.workspaceId === focus.workspaceId
          && lastTopic
          && lastTopic.id !== focus.id;
        return (
          <React.Fragment key={group.workspaceId}>
            <div className={cx('dts-group', groupCollapsed && 'is-collapsed')}>
              <GroupHeader
              group={shownGroup}
              isActiveWorkspace={group.workspaceId === currentWorkspaceId}
              selectMode={selectMode}
              selectionCount={groupSelected}
              groupIds={groupIds}
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
            <Collapse open={!groupCollapsed}>
              <div className="dts-group__body">
                {group.sections.map((section) => {
                  const sibling = focus?.level === 'topic'
                    && group.workspaceId === focus.workspaceId
                    && section.kind === 'topic'
                    && section.id !== focus.id;
                  const sectionCollapsed = sibling ? true : section.collapsed;
                  const shownSection = sectionCollapsed === section.collapsed ? section : { ...section, collapsed: sectionCollapsed };
                  return (
                    <React.Fragment key={`${section.kind}:${section.id ?? 'ungrouped'}`}>
                      <Section
                        section={shownSection}
                        group={group}
                        schedules={schedules}
                        selectMode={selectMode}
                        selectedIds={selectedIds}
                        now={now}
                        query={tree.search}
                        pendingTopicId={pendingTopicId}
                        onOpenSession={onOpenSession}
                        onToggleSelection={onToggleSelection}
                        onMenu={onMenu}
                        onArchive={onArchive}
                        onPin={onPin}
                        onRenameSession={onRenameSession}
                        onHint={onHint}
                        onHintEnd={onHintEnd}
                        onToggleCollapse={() =>
                          section.kind === 'topic'
                            ? onToggleTopicCollapse(`${group.workspaceId}:${section.id}`)
                            : onToggleWorkspaceCollapse(`${group.workspaceId}:archived`)
                        }
                        onToggleSection={(ids, deselect) => onSelectMany(ids, !deselect)}
                        onFilter={onFilterTopic}
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
                          onDragLeave={() => reorder?.onLeave?.('topic', lastTopic.id)}
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
                onDragLeave={() => reorder?.onLeave?.('workspace', lastRealWorkspace.workspaceId)}
                onDrop={(event) => reorder?.onDrop?.(event, 'workspace', { id: lastRealWorkspace.workspaceId, workspaceId: lastRealWorkspace.workspaceId }, 'after')}
              />
            ) : null}
          </React.Fragment>
        );
      })}
    </div>
  );
}
