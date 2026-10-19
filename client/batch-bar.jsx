/**
 * The batch action bar that slides in under the tree while selection mode is on.
 */
import * as React from 'react';
import { Icon, Button } from './widgets.jsx';
import { t } from './i18n.js';

export const BATCH_LIMIT = 200;

export function BatchBar({ count, busy, progress, onArchive, onUnarchive, onMove, onDelete, onClear, deleteAvailable }) {
  const overLimit = count > BATCH_LIMIT;
  return (
    <div className="dts-batchbar" role="toolbar" aria-label={t('action.select')}>
      <span className="dts-batchbar__count">{t('batch.selected', { n: count })}</span>
      {progress ? <span className="dts-batchbar__progress">{progress}</span> : null}
      <span className="dts-header__spacer" />
      <Button disabled={count === 0 || busy || overLimit} onClick={onArchive}>
        <Icon name="archive" />
        {t('batch.archive')}
      </Button>
      <Button disabled={count === 0 || busy || overLimit} onClick={onUnarchive}>
        <Icon name="unarchive" />
        {t('batch.unarchive')}
      </Button>
      <Button disabled={count === 0 || busy || overLimit} onClick={onMove}>
        <Icon name="move" />
        {t('batch.move')}
      </Button>
      {deleteAvailable ? (
        <Button variant="danger" disabled={count === 0 || busy || overLimit} onClick={onDelete}>
          <Icon name="trash" />
          {t('batch.delete')}
        </Button>
      ) : null}
      <Button variant="ghost" disabled={busy} onClick={onClear}>
        {t('action.cancel')}
      </Button>
      {overLimit ? <span className="dts-batchbar__warn">{t('batch.limit')}</span> : null}
    </div>
  );
}
