/**
 * Result and confirmation surfaces for bulk work.
 *
 * Both are honest about partial failure: archiving and deleting run one session at a time,
 * so the dialogs list what happened per id and re-offer only the ids that did not succeed.
 * The delete dialog additionally refuses to arm until the host preview comes back and the
 * user acknowledges that the artifacts are gone for good.
 */
import * as React from 'react';
import { cx, Dialog, Button, Checkbox, Icon } from './widgets.jsx';
import { api, ApiError } from './api.js';
import { formatBytes } from './time.js';
import { t } from './i18n.js';

function ItemList({ entries, emptyText }) {
  if (entries.length === 0) return <div className="dts-result__empty">{emptyText}</div>;
  return (
    <ul className="dts-result__list">
      {entries.map((entry) => (
        <li key={entry.id} className={cx('dts-result__item', `is-${entry.tone ?? 'plain'}`)}>
          <span className="dts-result__label" title={entry.id}>
            {entry.label ?? entry.id}
          </span>
          <span className="dts-result__detail">{entry.detail}</span>
        </li>
      ))}
    </ul>
  );
}

function describeEntry(entry, titles) {
  // `needsStop` is a bare id list; `failed` carries an error. Both must resolve to a label.
  const id = typeof entry === 'string' ? entry : entry?.id;
  const label = (typeof entry === 'string' ? null : entry?.label) ?? titles?.[id] ?? id;
  return { id, label };
}

/** Bulk archive/unarchive outcome, including the "stop the running ones" proposal. */
export function BatchResultDialog({ outcome, busy, progress, onClose, onRetryFailed, onStopRunning }) {
  const titles = outcome?.titles ?? {};
  const failed = (outcome?.failed ?? []).map((entry) => ({ ...describeEntry(entry, titles), detail: entry.error, tone: 'bad' }));
  const stopped = (outcome?.needsStop ?? []).map((entry) => ({ ...describeEntry(entry, titles), detail: t('delete.runningNote'), tone: 'warn' }));
  const ok = (outcome?.ok ?? []).map((id) => ({ id, label: titles[id] ?? id, detail: t('result.ok', { n: 1 }), tone: 'good' }));
  return (
    <Dialog
      title={t('result.title')}
      onClose={onClose}
      width={440}
      footer={
        <>
          {stopped.length > 0 ? (
            <Button variant="primary" disabled={busy} onClick={onStopRunning}>
              {t('batch.stopAndArchive')} ({stopped.length})
            </Button>
          ) : null}
          {failed.length > 0 ? (
            <Button disabled={busy} onClick={onRetryFailed}>
              {t('action.retry')} ({failed.length})
            </Button>
          ) : null}
          <span className="dts-spacer" />
          <Button variant="ghost" onClick={onClose}>
            {t('action.done')}
          </Button>
        </>
      }
    >
      <p className="dts-result__summary">
        {t('result.ok', { n: ok.length })} · {t('result.failed', { n: failed.length })}
        {stopped.length > 0 ? ` · ${t('batch.runningTitle', { n: stopped.length })}` : ''}
      </p>
      {progress ? <p className="dts-result__progress">{progress}</p> : null}
      {outcome?.limited ? <p className="dts-error">{t('batch.limit')}</p> : null}
      {stopped.length > 0 ? <p className="dts-dialog__hint">{t('batch.runningBody')}</p> : null}
      <ItemList entries={[...stopped, ...failed, ...ok]} emptyText={t('result.none')} />
    </Dialog>
  );
}

/**
 * Permanent delete: preview from the host, explicit acknowledgement, then per-item results.
 * The confirm button stays armed only while the preview reported something deletable.
 */
export function DeleteSessionsDialog({ ids, titles, onClose, onDone }) {
  const [phase, setPhase] = React.useState('preview');
  const [preview, setPreview] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [ack, setAck] = React.useState(false);
  const [outcome, setOutcome] = React.useState(null);
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    setPhase('preview');
    setError(null);
    try {
      setPreview(await api.deletePreview(ids));
      setPhase('ready');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : String(caught));
      setPhase('failed');
    }
  }, [ids]);

  React.useEffect(() => {
    load();
  }, [load]);

  const deletable = (preview?.items ?? []).filter((item) => !item.blockers.some((blocker) => blocker.severity === 'hard'));
  const blocked = (preview?.items ?? []).filter((item) => item.blockers.some((blocker) => blocker.severity === 'hard'));

  const execute = async (subset) => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.deleteExecute({ sessionIds: subset, confirm: true });
      setOutcome(result);
      setPhase('result');
      onDone(result);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const label = (id) => titles?.[id] ?? id;

  if (phase === 'result' && outcome) {
    const entries = outcome.items.map((item) => ({
      id: item.sessionId,
      label: label(item.sessionId),
      tone: item.status === 'deleted' ? 'good' : item.status === 'skipped' ? 'warn' : 'bad',
      detail: item.status === 'deleted' ? `${t('result.ok', { n: 1 })}${item.subagentsRemoved?.length ? ` · ${item.subagentsRemoved.length} 个子智能体` : ''}` : item.error,
    }));
    const failedIds = outcome.items.filter((item) => item.status === 'failed').map((item) => item.sessionId);
    return (
      <Dialog
        title={t('delete.title', { n: ids.length })}
        onClose={onClose}
        width={460}
        footer={
          <>
            {failedIds.length > 0 ? (
              <Button disabled={busy} onClick={() => execute(failedIds)}>
                {t('action.retry')} ({failedIds.length})
              </Button>
            ) : null}
            <span className="dts-spacer" />
            <Button variant="primary" onClick={onClose}>
              {t('action.done')}
            </Button>
          </>
        }
      >
        <p className="dts-result__summary">
          {t('delete.results', { ok: outcome.summary.deleted, skipped: outcome.summary.skipped, failed: outcome.summary.failed })}
        </p>
        {outcome.assignmentCleanup?.failed ? <p className="dts-error">{`主题归属清理失败:${outcome.assignmentCleanup.error}`}</p> : null}
        <ItemList entries={entries} emptyText={t('result.none')} />
      </Dialog>
    );
  }

  return (
    <Dialog
      title={t('delete.title', { n: ids.length })}
      onClose={onClose}
      width={460}
      footer={
        <>
          {phase === 'failed' ? <Button onClick={load}>{t('menu.reload')}</Button> : null}
          <span className="dts-spacer" />
          <Button onClick={onClose} disabled={busy}>
            {t('action.cancel')}
          </Button>
          <Button variant="danger" disabled={busy || phase !== 'ready' || !ack || deletable.length === 0} onClick={() => execute(deletable.map((item) => item.sessionId))}>
            {busy ? t('state.loading') : t('delete.confirmButton')}
          </Button>
        </>
      }
    >
      {phase === 'preview' ? <p className="dts-dialog__hint">{t('state.loading')}</p> : null}
      {error ? <p className="dts-error">{error}</p> : null}
      {phase === 'ready' ? (
        <>
          <p className="dts-result__summary">
            {t('delete.summary', { n: deletable.length, size: formatBytes(preview.bytes), running: preview.running, subagents: preview.subagents })}
          </p>
          <p className="dts-warning">
            <Icon name="warning" />
            <span>{t('delete.warning')}</span>
          </p>
          {blocked.length > 0 ? (
            <>
              <p className="dts-dialog__hint">{t('delete.blocked', { n: blocked.length })}</p>
              <ItemList
                entries={blocked.map((item) => ({
                  id: item.sessionId,
                  label: label(item.sessionId),
                  tone: 'warn',
                  detail: item.blockers.map((blocker) => blocker.message).join('; '),
                }))}
              />
            </>
          ) : null}
          <label className={cx('dts-ack', ack && 'is-on')}>
            <Checkbox checked={ack} onChange={setAck} label={t('delete.ack')} />
            <span>{t('delete.ack')}</span>
          </label>
        </>
      ) : null}
    </Dialog>
  );
}
