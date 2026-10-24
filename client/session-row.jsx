/**
 * One session row: title, pin marker, relative time, and the hover strip the stock list
 * uses — a "⋯" menu trigger followed by archive and pin, in that order. The menu itself is
 * owned by the panel so only one popover exists at a time.
 */
import * as React from 'react';
import { cx, Checkbox, Icon, IconButton, StateMark } from './widgets.jsx';
import { formatRelative } from './time.js';
import { marqueePlan } from './marquee.js';
import { pendingStatusLabel } from './model.js';
import { endDrag, currentDrag, sessionReorderVerdict } from './dnd.js';
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
 * One row. The title reveal is driven by `requestAnimationFrame` rather than a CSS keyframe
 * animation: the native list crawls to the far edge and *rests* there, while the old
 * `animation: … infinite alternate` bounced the title back and forth for as long as the
 * pointer stayed on the row. The math lives in `marquee.js`.
 */
export const SessionRow = React.memo(function SessionRow({
  row,
  schedule = null,
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
}) {
  const hintTimer = React.useRef(null);
  const textRef = React.useRef(null);
  const scrollRef = React.useRef(null);
  const frameRef = React.useRef(0);
  const [marquee, setMarquee] = React.useState(false);
  React.useEffect(() => () => {
    clearTimeout(hintTimer.current);
    cancelAnimationFrame(frameRef.current);
  }, []);
  /** Cancels the reveal and puts the title back at its start in one step. */
  const resetReveal = () => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    scroll.style.transform = '';
    delete scroll.dataset.revealed;
  };
  /**
   * Native behaviour: hovering a clipped title crawls it to its far edge and stops there.
   * `prefers-reduced-motion` jumps straight to the far edge (the title is still readable);
   * nothing moves for a title that fits, or is clipped by less than the dead zone.
   */
  const startHint = (element) => {
    clearTimeout(hintTimer.current);
    // While selecting, the row is a checkbox target; the hover card and marquee would only
    // compete with the selection state.
    if (selectMode) {
      // Entering selection mode replaces the title with a checkbox target, so an in-flight
      // reveal must be cancelled and the offset cleared — otherwise the frame loop keeps
      // writing transforms under a row the user can no longer read.
      cancelAnimationFrame(frameRef.current);
      frameRef.current = 0;
      resetReveal();
      setMarquee(false);
      return;
    }
    const node = textRef.current;
    const scroll = scrollRef.current;
    const plan = marqueePlan(node);
    cancelAnimationFrame(frameRef.current);
    if (!plan || !scroll) {
      setMarquee(false);
    } else {
      const reduce = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const place = (offset) => {
        scroll.style.transform = offset === 0 ? '' : `translateX(${-offset}px)`;
        // `dataset.x = undefined` would write the literal string "undefined"; delete instead.
        if (offset >= plan.range) scroll.dataset.revealed = '';
        else delete scroll.dataset.revealed;
      };
      setMarquee(true);
      if (reduce) {
        place(plan.range);
      } else {
        place(0);
        // Accumulate deltas from the frame timestamps themselves (like the native marquee)
        // instead of subtracting a `performance.now()` baseline: the rAF clock and the
        // performance timeline only share an origin inside a real page.
        let previous = null;
        let offset = 0;
        const step = (now) => {
          if (previous !== null && now > previous) offset += (now - previous) * plan.pxPerMs;
          previous = now;
          const drawn = Math.min(plan.range, Math.round(offset));
          place(drawn);
          // Stop at the far edge: the title rests under the pointer instead of scrolling back.
          if (drawn < plan.range) frameRef.current = requestAnimationFrame(step);
        };
        frameRef.current = requestAnimationFrame(step);
      }
    }
    if (!onHint) return;
    const rect = element.getBoundingClientRect();
    hintTimer.current = setTimeout(() => onHint({ row, rect }), 480);
  };
  const endHint = () => {
    clearTimeout(hintTimer.current);
    cancelAnimationFrame(frameRef.current);
    frameRef.current = 0;
    // Leaving returns the title to the start in one step: an animated way back would meet the
    // resting ellipsis with text still travelling.
    resetReveal();
    setMarquee(false);
    if (!selectMode) onHintEnd?.();
  };
  const hint = reorder?.hint;
  const dropBefore = hint?.level === 'session' && hint.id === row.id && hint.position === 'before';
  const dropAfter = hint?.level === 'session' && hint.id === row.id && hint.position === 'after';
  // Native order: a pending interaction replaces the timestamp with its compact label;
  // archived and provisional rows never carry a live status marker.
  const trailing = row.pendingKind ? pendingStatusLabel(row.pendingKind, true) : null;
  // Pending rows expose the compact label as real text; the other states are dot/spinner
  // only, so give assistive tech the same status the native row announces.
  const silentStatusLabel = !row.pendingKind && row.status
    ? row.running
      ? t('session.state.running')
      : row.completed
        ? t('session.state.completed')
        : null
    : null;
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
      // 41.5px puts the title's left edge at the right edge of the topic emoji
      // (25.5–41.5px after the marker's left pull); the checkbox in flow takes 22px.
      style={{ '--dts-indent': selectMode ? '19.5px' : '41.5px' }}
      role="treeitem"
      aria-selected={selectMode ? selected : row.isCurrent}
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
        reorder?.onEnd?.();
        event.currentTarget.removeAttribute('data-dragging');
      }}
      onDragOver={(event) => {
        const drag = currentDrag();
        if (!drag) return;
        if (drag.kind === 'reorder') {
          reorder?.onHover?.(event, 'session', { id: row.id, workspaceId: row.workspaceId, topicId: row.topicId });
          return;
        }
        const target = { id: row.id, workspaceId: row.workspaceId, topicId: row.topicId };
        if (sessionReorderVerdict(drag, target).ok) {
          reorder?.onHover?.(event, 'session', target);
          return;
        }
        // A session dragged from another topic can still be filed by dropping it on a row:
        // the browser only fires `drop` when the row opts in here.
        if (!drag.ids.includes(row.id) && (!drag.workspaceId || drag.workspaceId === row.workspaceId)) {
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
        }
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) reorder?.onLeave?.('session', row.id);
      }}
      onDrop={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onDropOnRow?.(event, row);
      }}
      onClick={() => (selectMode ? onToggleSelect(row.id) : onOpen(row))}
      onKeyDown={(event) => {
        // The action strip lives inside this focusable row; its own key handling must not be
        // turned into "open the session" or cancelled here.
        if (event.target !== event.currentTarget) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          if (selectMode) onToggleSelect(row.id);
          else onOpen(row);
        }
      }}
      onDoubleClick={(event) => {
        // The desktop build renames on double-click instead of opening twice. A blank row is
        // the provisional New Session and has nothing to rename yet — same as the stock list.
        // Double-clicks that belong to an action control must not fall through to rename.
        if (event.target?.closest?.('button, input, label, a, [role="button"]')) return;
        event.preventDefault();
        if (row.blank || selectMode) return;
        onRename?.(row);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        // A row menu would mix single-session actions into the batch flow.
        if (row.blank || selectMode) return;
        onMenu({ type: 'session', row, anchor: event.currentTarget });
      }}
    >
      {selectMode ? (
        <span className="dts-row__check" onClick={(event) => event.stopPropagation()}>
          <Checkbox checked={selected} onChange={() => onToggleSelect(row.id)} label={row.title} />
        </span>
      ) : row.status && !row.blank && !row.archived ? (
        <>
          <StateMark state={row.status} className="dts-row__status" />
          {silentStatusLabel ? <span className="dts-visually-hidden">{silentStatusLabel}</span> : null}
        </>
      ) : !row.blank && !row.archived && schedule?.length > 0 ? (
        // Stock rule: the leading 16px cell shows the scheduled-task clock only while the row
        // itself is idle — a pending request, live work or an unread completion keeps its dot.
        <span
          className="dts-row__status dts-row__schedule"
          role="img"
          aria-label={t('schedule.markAria', { count: schedule.length })}
          title={t('schedule.markAria', { count: schedule.length })}
          onClick={(event) => event.stopPropagation()}
        >
          <Icon name="clock" size={14} />
        </span>
      ) : null}

      <span className="dts-row__title">
        <span ref={textRef} className={cx('dts-row__text', marquee && 'is-marquee')}>
          <span ref={scrollRef} className="dts-row__scroll">{highlight(row.title, query)}</span>
        </span>
      </span>

      {row.blank ? null : (
        <span className="dts-row__aside">
          {/* The label is precomputed into the row (see `makeRow`), so a tick that lands in the
              same minute leaves this prop identical and the memo can skip the row entirely. */}
          <span className="dts-row__time">{trailing ?? row.timeLabel ?? formatRelative(row.updatedAt, now)}</span>
          {row.pinned && !row.archived ? (
            <span className="dts-row__pin" role="img" aria-label={t('session.pinned')} title={t('session.pinned')}>
              <Icon name="pinFilled" />
            </span>
          ) : null}
          <span className="dts-row__actions">
            <IconButton
              label={t('session.rowMenu')}
              title={t('session.rowMenu')}
              className="dts-row__act"
              onClick={(event) => onMenu({ type: 'session', row, anchor: event.currentTarget })}
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
            {row.archived ? null : (
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
            )}
          </span>
        </span>
      )}
    </div>
  );
});
