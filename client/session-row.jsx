/**
 * One session row: title, pin marker, relative time, and the hover strip the stock list
 * uses — a "⋯" menu trigger followed by archive and pin, in that order. The menu itself is
 * owned by the panel so only one popover exists at a time.
 */
import * as React from 'react';
import { cx, Checkbox, Icon, IconButton } from './widgets.jsx';
import { formatRelative } from './time.js';
import { endDrag } from './dnd.js';
import { t } from './i18n.js';

function highlight(title, query) {
  const needle = String(query ?? '').trim();
  if (!needle) return title;
  const index = title.toLowerCase().indexOf(needle.toLowerCase());
  if (index < 0) return title;
  return (
    <>
      {title.slice(0, index)}
      <mark className="dts-mark">{title.slice(index, index + needle.length)}</mark>
      {title.slice(index + needle.length)}
    </>
  );
}

/**
 * Marquee plan for a title wider than its box: the shift is the overflow, and the duration
 * keeps a constant reading speed so short titles do not crawl and long ones do not sprint.
 */
export function marqueePlan(element, { speed = 42 } = {}) {
  if (!element) return null;
  const overflow = element.scrollWidth - element.clientWidth;
  if (overflow <= 1) return null;
  return { shift: -overflow, duration: Math.min(12, Math.max(2.4, overflow / speed)) };
}

export const SessionRow = React.memo(function SessionRow({
  row,
  query = '',
  selectMode = false,
  selected = false,
  now,
  onOpen,
  onToggleSelect,
  onDragStart,
  onDropOnRow,
  reorder,
  onMenu,
  onArchive,
  onPin,
  onRename,
  onHint,
  onHintEnd,
  depth = 0,
}) {
  const hintTimer = React.useRef(null);
  const textRef = React.useRef(null);
  const [marquee, setMarquee] = React.useState(null);
  React.useEffect(() => () => clearTimeout(hintTimer.current), []);
  const startHint = (element) => {
    clearTimeout(hintTimer.current);
    // Native behaviour: hovering a clipped title scrolls it instead of hiding the tail.
    setMarquee(marqueePlan(textRef.current));
    if (!onHint) return;
    const rect = element.getBoundingClientRect();
    hintTimer.current = setTimeout(() => onHint({ row, rect }), 480);
  };
  const endHint = () => {
    clearTimeout(hintTimer.current);
    setMarquee(null);
    onHintEnd?.();
  };
  const hint = reorder?.hint;
  const dropBefore = hint?.level === 'session' && hint.id === row.id && hint.position === 'before';
  const dropAfter = hint?.level === 'session' && hint.id === row.id && hint.position === 'after';
  const scrollStyle = marquee
    ? { '--dts-marquee-shift': `${marquee.shift}px`, '--dts-marquee-time': `${marquee.duration}s` }
    : undefined;
  return (
    <div
      className={cx(
        'dts-row',
        'dts-row--session',
        row.isCurrent && 'is-current',
        row.archived && 'is-archived',
        row.running && 'is-running',
        selected && 'is-selected',
        dropBefore && 'is-dropbefore',
        dropAfter && 'is-dropafter',
      )}
      style={{ '--dts-indent': selectMode ? '8px' : `${42 + depth * 10}px` }}
      role="treeitem"
      aria-selected={row.isCurrent}
      tabIndex={0}
      draggable={!selectMode && !row.blank && !row.archived}
      onMouseEnter={(event) => startHint(event.currentTarget)}
      onMouseLeave={endHint}
      onDragStart={(event) => {
        event.currentTarget.setAttribute('data-dragging', 'true');
        onDragStart?.(row, event);
      }}
      onDragEnd={(event) => {
        endDrag();
        event.currentTarget.removeAttribute('data-dragging');
      }}
      onDragOver={(event) => reorder?.onHover?.(event, 'session', { id: row.id, workspaceId: row.workspaceId, topicId: row.topicId })}
      onDrop={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onDropOnRow?.(event, row);
      }}
      onClick={() => (selectMode ? onToggleSelect(row.id) : onOpen(row))}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          if (selectMode) onToggleSelect(row.id);
          else onOpen(row);
        }
      }}
      onDoubleClick={(event) => {
        // The desktop build renames on double-click instead of opening twice. A blank row is
        // the provisional New Session and has nothing to rename yet — same as the stock list.
        event.preventDefault();
        if (row.blank) return;
        onRename?.(row);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        if (row.blank) return;
        onMenu({ type: 'session', row, anchor: event.currentTarget.getBoundingClientRect() });
      }}
    >
      {selectMode ? (
        <span className="dts-row__check" onClick={(event) => event.stopPropagation()}>
          <Checkbox checked={selected} onChange={() => onToggleSelect(row.id)} label={row.title} />
        </span>
      ) : row.running ? (
        <span className="dts-dot dts-dot--ongoing" aria-hidden="true" />
      ) : null}

      <span className="dts-row__title">
        <span ref={textRef} className={cx('dts-row__text', marquee && 'is-marquee')}>
          <span className="dts-row__scroll" style={scrollStyle}>{highlight(row.title, query)}</span>
        </span>
      </span>

      {row.blank ? null : (
        <span className="dts-row__aside">
          <span className="dts-row__time">{formatRelative(row.updatedAt, now)}</span>
          {row.pinned ? (
            <span className="dts-row__pin" role="img" aria-label={t('session.pinned')} title={t('session.pinned')}>
              <Icon name="pinFilled" />
            </span>
          ) : null}
          <span className="dts-row__actions">
            <IconButton
              label={t('session.rowMenu')}
              title={t('session.rowMenu')}
              className="dts-row__act"
              onClick={(event) => onMenu({ type: 'session', row, anchor: event.currentTarget.getBoundingClientRect() })}
            >
              <Icon name="ellipsis" />
            </IconButton>
            <IconButton
              label={row.archived ? t('session.unarchive') : t('session.archive')}
              title={row.archived ? t('session.unarchive') : t('session.archive')}
              className="dts-row__act"
              onClick={(event) => {
                event.stopPropagation();
                onArchive?.(row);
              }}
            >
              <Icon name={row.archived ? 'unarchive' : 'archive'} />
            </IconButton>
            <IconButton
              label={row.pinned ? t('session.unpin') : t('session.pin')}
              title={row.pinned ? t('session.unpin') : t('session.pin')}
              className="dts-row__act"
              onClick={(event) => {
                event.stopPropagation();
                // Release focus: while the row has focus-within the marker would stay hidden.
                event.currentTarget.blur();
                onPin?.(row);
              }}
            >
              <Icon name={row.pinned ? 'pinFilled' : 'pin'} />
            </IconButton>
          </span>
        </span>
      )}
    </div>
  );
});
