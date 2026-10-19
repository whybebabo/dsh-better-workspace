/**
 * The workspace → topic → session tree.
 *
 * Row geometry follows the native list; grouping is the plugin's own: topics
 * are folders inside a workspace, unfiled sessions keep a trailing bucket, and archived
 * sessions collect in a bucket that preserves their topic membership. Long buckets render
 * progressively so a workspace with hundreds of sessions does not build rows nobody reached.
 */
import * as React from 'react';
import { cx, Icon, IconButton, Checkbox, IconCaret, IconFolderOpen, IconFolderClose, TopicMark } from './widgets.jsx';
import { SessionRow } from './session-row.jsx';
import { beginDrag, currentDrag, endDrag, evaluateDrop, readDragPayload, writeDragPayload } from './dnd.js';
import { t } from './i18n.js';

export const REVEAL_LIMIT = 60;

function sectionLabel(section) {
  if (section.kind === 'archived') return t('topic.archived');
  return section.name;
}

/** Where a drop on this row lands: a topic (default included) files in. */
function targetOf(section, group) {
  return { workspaceId: group.workspaceId, topicId: section.kind === 'topic' ? section.id : null };
}

function GroupHeader({ group, selectMode, selectionCount, groupIds, allSelected, onToggleGroup, onToggleCollapse, onMenu, onAddTopic, isActiveWorkspace, reorder }) {
  const hint = reorder?.hint;
  const dropBefore = hint?.level === 'workspace' && hint.id === group.workspaceId && hint.position === 'before';
  const dropAfter = hint?.level === 'workspace' && hint.id === group.workspaceId && hint.position === 'after';
  return (
    <div
      className={cx('dts-row', 'dts-row--group', group.collapsed && 'is-collapsed', dropBefore && 'is-dropbefore', dropAfter && 'is-dropafter')}
      role="treeitem"
      aria-expanded={!group.collapsed}
      tabIndex={0}
      draggable={!selectMode}
      onClick={onToggleCollapse}
      onDragStart={(event) => reorder?.onStart?.('workspace', { id: group.workspaceId, workspaceId: group.workspaceId }, event)}
      onDragEnd={reorder?.onEnd}
      onDragOver={(event) => reorder?.onHover?.(event, 'workspace', { id: group.workspaceId, workspaceId: group.workspaceId })}
      onDrop={(event) => reorder?.onDrop?.(event, 'workspace', { id: group.workspaceId, workspaceId: group.workspaceId })}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onToggleCollapse();
        }
      }}
      onContextMenu={(event) => {
        event.preventDefault();
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
              onChange={onToggleGroup}
              label={`${group.title} 全选`}
            />
          </span>
        ) : (
          <>
            <span className="dts-caret">
              <IconCaret className={cx('dts-caret__icon', !group.collapsed && 'is-open')} />
            </span>
            <span className={cx('dts-folder', isActiveWorkspace && 'is-active')}>
              {group.collapsed ? <IconFolderClose /> : <IconFolderOpen />}
            </span>
          </>
        )}
      </span>
      <span className="dts-row__title" title={group.path || group.title}>
        <span className="dts-row__text">{group.title}</span>
      </span>
      <span className="dts-row__aside">
        <span className="dts-row__count">{t('workspace.count', { n: group.liveCount })}</span>
        <span className="dts-row__actions">
          <IconButton
            label={t('action.addTopic')}
            title={t('action.addTopic')}
            onClick={(event) => {
              event.stopPropagation();
              onAddTopic(group.workspaceId, event.currentTarget.getBoundingClientRect());
            }}
          >
            <Icon name="plus" />
          </IconButton>
          <IconButton
            label={t('action.menu')}
            title={t('action.menu')}
            onClick={(event) => {
              event.stopPropagation();
              onMenu({ type: 'workspace', group, anchor: event.currentTarget.getBoundingClientRect() });
            }}
          >
            <Icon name="ellipsis" />
          </IconButton>
        </span>
      </span>
    </div>
  );
}

function SectionHeader({ section, group, selectMode, selectedIds, pending, onToggleCollapse, onToggleSection, onMenu, onFilter, onDropSessions, onRename, reorder }) {
  const ids = section.rows.map((row) => row.id);
  const selectedCount = ids.filter((id) => selectedIds.has(id)).length;
  const [dropState, setDropState] = React.useState('idle');
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(section.name ?? '');
  const droppable = section.kind !== 'archived';
  // The default group is a system group — it cannot be renamed or deleted — but the user can
  // still file it wherever they want, so it drags like any other topic.
  const draggable = section.kind === 'topic' && !selectMode;
  const label = sectionLabel(section);
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
      aria-label={label}
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
        if (section.kind === 'topic') onMenu({ type: 'topic', section, group, anchor: event.currentTarget.getBoundingClientRect() });
      }}
      onDragStart={(event) => {
        if (!draggable) return;
        reorder?.onStart?.('topic', { id: section.id, workspaceId: group.workspaceId }, event);
      }}
      onDragEnd={reorder?.onEnd}
      onDragOver={(event) => {
        // Row reordering and session filing share this row, so the active drag decides.
        if (currentDrag()?.kind === 'reorder') {
          reorder?.onHover?.(event, 'topic', { id: section.id, workspaceId: group.workspaceId });
          return;
        }
        if (!droppable) return;
        const verdict = evaluateDrop(currentDrag(), targetOf(section, group));
        // A cross-workspace hover is not a target at all: no preventDefault, no drop cursor.
        if (!verdict.ok && verdict.reason === 'cross-workspace') return;
        event.preventDefault();
        event.dataTransfer.dropEffect = verdict.ok ? 'move' : 'none';
        setDropState(verdict.ok ? 'ok' : 'no');
      }}
      onDragLeave={() => setDropState('idle')}
      onDrop={(event) => {
        setDropState('idle');
        if (currentDrag()?.kind === 'reorder') {
          reorder?.onDrop?.(event, 'topic', { id: section.id, workspaceId: group.workspaceId });
          return;
        }
        if (!droppable) return;
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
      {selectMode && ids.length > 0 ? (
        <span className="dts-row__check" onClick={(event) => event.stopPropagation()}>
          <Checkbox
            checked={ids.length > 0 && selectedCount === ids.length}
            indeterminate={selectedCount > 0 && selectedCount < ids.length}
            onChange={() => onToggleSection(ids, selectedCount === ids.length)}
            label={`${label} 全选`}
          />
        </span>
      ) : (
        <span className="dts-row__slot" aria-hidden="true">
          <span className="dts-caret">
            <IconCaret className={cx('dts-caret__icon', !section.collapsed && 'is-open')} />
          </span>
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
        <span className="dts-row__count">{section.total}</span>
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
      </span>
    </div>
  );
}

const Section = React.memo(function Section({ section, group, selectMode, selectedIds, now, query, pendingTopicId, onOpenSession, onToggleSelection, onMenu, onArchive, onPin, onRenameSession, onHint, onHintEnd, onToggleCollapse, onToggleSection, onFilter, onDropSessions, onRename, onDropOnRow, reorder }) {
  const [revealed, setRevealed] = React.useState(false);
  const overflow = section.rows.length > REVEAL_LIMIT;
  const visible = overflow && !revealed ? section.rows.slice(0, REVEAL_LIMIT) : section.rows;
  return (
    <div className={cx('dts-section', `dts-section--${section.kind}`)}>
      <SectionHeader
        section={section}
        group={group}
        selectMode={selectMode}
        selectedIds={selectedIds}
        pending={section.kind === 'topic' && pendingTopicId === section.id}
        onToggleCollapse={onToggleCollapse}
        onToggleSection={onToggleSection}
        onMenu={onMenu}
        onFilter={onFilter}
        onDropSessions={onDropSessions}
        onRename={onRename}
        reorder={reorder}
      />
      {!section.collapsed
        ? visible.map((row) => (
            <SessionRow
              key={row.id}
              row={row}
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
              depth={1}
            />
          ))
        : null}
      {overflow && !section.collapsed ? (
        <button type="button" className="dts-reveal" onClick={() => setRevealed((value) => !value)}>
          {revealed ? t('action.collapse') : t('action.showAll', { n: section.rows.length })}
        </button>
      ) : null}
    </div>
  );
});

export function TopicTree({
  tree,
  prefs,
  selection,
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
  onAddTopic,
  onDropSessions,
  onRenameTopic,
  onDropOnRow,
  reorder,
  pendingTopicId,
  currentWorkspaceId,
}) {
  const selectedIds = React.useMemo(() => new Set(selection), [selection]);
  const selectMode = Boolean(prefs.selectMode);

  if (tree.groups.length === 0) {
    return (
      <div className="dts-empty">
        {tree.search ? t('state.noMatch') : t('state.emptyTopic')}
        {tree.truncated ? <span className="dts-note">{t('search.limit', { n: tree.matched })}</span> : null}
      </div>
    );
  }

  return (
    <div className="dts-tree" role="tree" aria-label={t('section.workspaces')}>
      {tree.truncated ? <div className="dts-note">{t('search.limit', { n: tree.matched })}</div> : null}
      {tree.groups.map((group) => {
        const groupIds = group.sections.flatMap((section) => section.rows.map((row) => row.id));
        const groupSelected = groupIds.filter((id) => selectedIds.has(id)).length;
        return (
          <div key={group.workspaceId} className={cx('dts-group', group.collapsed && 'is-collapsed')}>
            <GroupHeader
              group={group}
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
              onAddTopic={onAddTopic}
              onMenu={onMenu}
              reorder={reorder}
            />
            {!group.collapsed ? (
              <div className="dts-group__body">
                {group.sections.map((section) => (
                  <Section
                    key={`${section.kind}:${section.id ?? 'ungrouped'}`}
                    section={section}
                    group={group}
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
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
