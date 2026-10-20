/**
 * Selection toolbar. It takes over the panel header while selection mode is on, so the
 * actions share the native header's icon buttons instead of stacking text buttons in a
 * narrow sidebar. Hover titles carry the action name; a slim status line explains why an
 * action is unavailable.
 */
import * as React from 'react';
import { cx, Icon, IconButton } from './widgets.jsx';
import { t } from './i18n.js';
import { BATCH_LIMIT } from './batch.js';

export function BatchBar({ count, busy, progress, hasArchived, hasUnarchived, hasUngrouped = false, onArchive, onUnarchive, onMove, onDelete, onExit, deleteAvailable }) {
  const overLimit = count > BATCH_LIMIT;
  // Mixed selections would half-apply an archive run, so the conflicting action greys out.
  const archiveDisabled = count === 0 || busy || overLimit || hasArchived;
  const unarchiveDisabled = count === 0 || busy || overLimit || hasUnarchived;
  const moveDisabled = count === 0 || busy || overLimit || hasArchived || hasUngrouped;
  const deleteDisabled = count === 0 || busy || overLimit;
  const limitTitle = overLimit ? t('batch.limit') : null;
  const archiveTitle = limitTitle ?? (hasArchived ? t('batch.archiveDisabled') : t('batch.archive'));
  const unarchiveTitle = limitTitle ?? (hasUnarchived ? t('batch.unarchiveDisabled') : t('batch.unarchive'));
  const moveTitle = limitTitle
    ?? (hasArchived ? t('batch.moveDisabled') : hasUngrouped ? t('batch.ungroupedMoveDisabled') : t('batch.move'));
  const deleteTitle = limitTitle ?? t('batch.delete');
  const hint = progress
    ? { tone: 'is-progress', text: progress }
    : overLimit
      ? { tone: 'is-error', text: t('batch.limit') }
      : hasArchived && hasUnarchived
        ? { tone: null, text: t('batch.mixed') }
        : hasArchived
          ? { tone: null, text: t('batch.moveDisabled') }
          : hasUngrouped
            ? { tone: null, text: t('batch.ungroupedMoveDisabled') }
            : null;

  return (
    <div className="dts-header dts-selectbar" role="toolbar" aria-label={t('action.select')}>
      <div className="dts-header__row">
        <IconButton label={t('action.exitSelect')} title={t('action.exitSelect')} disabled={busy} onClick={onExit}>
          <Icon name="close" />
        </IconButton>
        <span className="dts-selectbar__count" aria-live="polite">
          {t('batch.selected', { n: count })}
        </span>
        <span className="dts-header__spacer" />
        <IconButton
          className="dts-selectbar__action dts-selectbar__action--archive"
          label={t('batch.archive')}
          title={archiveTitle}
          disabled={archiveDisabled}
          onClick={onArchive}
        >
          <Icon name="archive" />
        </IconButton>
        <IconButton
          className="dts-selectbar__action dts-selectbar__action--unarchive"
          label={t('batch.unarchive')}
          title={unarchiveTitle}
          disabled={unarchiveDisabled}
          onClick={onUnarchive}
        >
          <Icon name="unarchive" />
        </IconButton>
        <IconButton
          className="dts-selectbar__action dts-selectbar__action--move"
          label={t('batch.move')}
          title={moveTitle}
          disabled={moveDisabled}
          onClick={onMove}
        >
          <Icon name="move" />
        </IconButton>
        {deleteAvailable ? (
          <IconButton
            className="dts-selectbar__action dts-selectbar__danger"
            label={t('batch.delete')}
            title={deleteTitle}
            disabled={deleteDisabled}
            onClick={onDelete}
          >
            <Icon name="trash" />
          </IconButton>
        ) : null}
      </div>
      {hint ? <div className={cx('dts-selectbar__hint', hint.tone)} aria-live="polite">{hint.text}</div> : null}
    </div>
  );
}
