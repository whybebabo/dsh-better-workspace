/**
 * Sequential session batch runner.
 *
 * DSH 0.2.1 has no host-side bulk archive, so each id goes through the official client
 * command one at a time. The loop never aborts on a single rejection: partial failures are
 * reported per id and the caller offers a retry. An archive rejected because the session is
 * still running is tagged `needsStop` so the UI can propose "停止并归档" and re-run those ids
 * with `{ stopActivity: true }`, which is the official way to stop-then-archive.
 */
import { t } from './i18n.js';

export const BATCH_LIMIT = 200;

function looksActive(error) {
  const code = String(error?.code ?? '');
  const message = String(error?.message ?? error ?? '');
  return /active|running|busy/i.test(code) || /运行中|正在运行|active|running|WorkspaceActiveSessionError/i.test(message);
}

function describe(error) {
  const message = String(error?.message ?? error ?? '未知错误');
  return message.length > 220 ? `${message.slice(0, 220)}…` : message;
}

/**
 * @param {object} input
 * @param {'archive'|'unarchive'|'pin'|'unpin'} input.action
 * @param {string[]} input.ids
 * @param {object} input.actions - host actions
 * @param {object} [input.options] - command options, e.g. { stopActivity: true }
 * @param {(progress: {done: number, total: number, current: string}) => void} [input.onProgress]
 * @returns {Promise<{action: string, ok: string[], failed: Array, needsStop: string[], total: number, limited: boolean}>}
 */
export async function runSessionAction({ action, ids, actions, options, onProgress, signal }) {
  const unique = [...new Set(ids ?? [])].filter(Boolean);
  const limited = unique.length > BATCH_LIMIT;
  const targets = limited ? unique.slice(0, BATCH_LIMIT) : unique;
  if (unique.length === 0) return { action, ok: [], failed: [], needsStop: [], total: 0, limited: false, empty: true };

  const dispatch = {
    archive: (id) => actions.archiveSession(id, options ?? {}),
    unarchive: (id) => actions.unarchiveSession(id),
    pin: (id) => actions.pinSession(id),
    unpin: (id) => actions.unpinSession(id),
  }[action];
  if (!dispatch) throw new Error(`未知的批量动作: ${action}`);

  const ok = [];
  const failed = [];
  const needsStop = [];
  let done = 0;
  for (const id of targets) {
    if (signal?.aborted) {
      failed.push({ id, error: t('batch.aborted'), code: 'aborted' });
      continue;
    }
    onProgress?.({ done, total: targets.length, current: id });
    try {
      await dispatch(id);
      ok.push(id);
    } catch (error) {
      if (action === 'archive' && looksActive(error) && options?.stopActivity !== true) {
        needsStop.push(id);
      } else {
        failed.push({ id, error: describe(error), code: error?.code ?? 'failed' });
      }
    }
    done += 1;
    onProgress?.({ done, total: targets.length, current: id });
  }

  return { action, ok, failed, needsStop, total: targets.length, limited, summary: summarize({ action, ok, failed, needsStop }) };
}

const actionLabel = (action) => ({
  archive: t('batch.archive'),
  unarchive: t('batch.unarchive'),
  pin: t('session.pin'),
  unpin: t('session.unpin'),
}[action] ?? action);

function summarize({ action, ok, failed, needsStop }) {
  const label = actionLabel(action);
  const parts = [];
  if (ok.length) parts.push(`${label} · ${t('result.ok', { n: ok.length })}`);
  if (failed.length) parts.push(t('result.failed', { n: failed.length }));
  if (needsStop.length) parts.push(t('batch.runningTitle', { n: needsStop.length }));
  return parts.join(' · ') || t('result.none');
}

/** Retries exactly the ids that failed, keeping the successful ones out of the way. */
export async function retryFailed({ outcome, ids, actions, options, onProgress }) {
  const wanted = new Set((outcome?.failed ?? []).map((entry) => entry.id));
  if (outcome?.needsStop?.length) outcome.needsStop.forEach((id) => wanted.add(id));
  const targets = (ids ?? []).filter((id) => wanted.has(id));
  const stopFirst = Boolean(outcome?.needsStop?.length);
  return runSessionAction({
    action: outcome.action,
    ids: targets,
    actions,
    options: stopFirst ? { ...(options ?? {}), stopActivity: true } : options,
    onProgress,
  });
}

export function mergeOutcomes(previous, next) {
  if (!previous) return next;
  const ok = [...new Set([...previous.ok, ...next.ok])];
  const failedById = new Map();
  for (const entry of [...previous.failed, ...next.failed]) {
    if (!ok.includes(entry.id)) failedById.set(entry.id, entry);
  }
  const needsStop = [...new Set([...(previous.needsStop ?? []), ...(next.needsStop ?? [])])].filter((id) => !ok.includes(id));
  return {
    action: next.action ?? previous.action,
    ok,
    failed: [...failedById.values()],
    needsStop,
    total: (previous.total ?? 0) + (next.total ?? 0),
    limited: Boolean(previous.limited || next.limited),
    summary: summarize({ action: next.action ?? previous.action, ok, failed: [...failedById.values()], needsStop }),
  };
}
