/**
 * Host scheduled tasks ("自动化任务") projected onto the panel's own rows.
 *
 * The stock sidebar draws these with the `sidebar.session.row.leading` and
 * `sidebar.session.row.hover` slots. Those seats belong to the native list entry — a slot can
 * only be rendered by the entry that declared it — so an overlay that replaces the list cannot
 * hand them back. Instead this module reads the same global catalog the schedule UI projects
 * (`remote.schedule.catalog()`) and mirrors the two native surfaces: the clock mark in the
 * row's 16px leading cell while the session is idle, and the task block in the hover card.
 *
 * The wording is the host's `schedule.catalog` copy (see `i18n.js`): a task reads as
 * `每天 09:00（UTC+08:00 · 中国标准时间） · 10月21日 09:00 (21小时后)`. Cron rules keep the
 * host's raw-expression form rather than its humanized preview, so an unparsable expression
 * and a parsable one look the same here.
 */
import { t } from './i18n.js';

const EMPTY = Object.freeze([]);
const EMPTY_MAP = new Map();
const SECOND = { seconds: 1, unit: 'second' };
const UNITS = [
  { seconds: 86_400, unit: 'day' },
  { seconds: 3_600, unit: 'hour' },
  { seconds: 60, unit: 'minute' },
  SECOND,
];

/** Read one optional service without letting a missing/renamed entry take the panel down. */
function service(ctx, name) {
  try {
    return ctx.get?.(name) ?? null;
  } catch {
    return null;
  }
}

/** Group active catalog records by their originating session; inactive rows never mark. */
export function indexSchedules(records) {
  const bySession = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    if (record?.status !== 'active' || !record.sessionId) continue;
    const list = bySession.get(record.sessionId);
    if (list) list.push(record);
    else bySession.set(record.sessionId, [record]);
  }
  for (const list of bySession.values()) list.sort(byTarget);
  return bySession;
}

/** Overdue first, then the nearest future target; equal targets keep the catalog order. */
function byTarget(left, right) {
  const leftTime = Date.parse(left?.scheduledAt);
  const rightTime = Date.parse(right?.scheduledAt);
  const leftValid = Number.isFinite(leftTime);
  const rightValid = Number.isFinite(rightTime);
  if (leftValid && rightValid && leftTime !== rightTime) return leftTime - rightTime;
  return 0;
}

/**
 * One long-lived catalog reader shared by every row.
 *
 * `start()` resolves the Remote face once the panel is actually on screen, attaches the two
 * invalidations the native catalog follows (`schedule/changed` and a connection reset) and
 * keeps the records visible while a refresh is in flight, exactly like the host's own source.
 */
export function createScheduleStore(ctx) {
  let snapshot = { bySession: EMPTY_MAP, status: 'idle', settled: false };
  const listeners = new Set();
  let started = false;
  let disposed = false;
  let remote = null;
  let reading = null;
  let dirty = false;
  let offChanged = null;
  let offReset = null;
  let retryTimer = null;
  let attempts = 0;

  const publish = (next) => {
    if (disposed) return;
    snapshot = next;
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch { /* one row's render error must not stop the others */ }
    }
  };

  const scheduleFace = () => {
    try {
      if (!remote) remote = service(ctx, 'remote');
      return remote?.schedule ?? service(ctx, 'remote.schedule');
    } catch {
      // A lazy Remote face may throw until its namespace mounts; treat it as absent.
      return null;
    }
  };

  /**
   * The schedule face may register after this overlay mounts (both are client plugins); a
   * bounded retry is enough — a composition without it never answers and must stay silent.
   */
  const retryLater = () => {
    if (disposed || retryTimer || attempts >= 5) return;
    attempts += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (disposed) return;
      if (!scheduleFace()) {
        retryLater();
        return;
      }
      attach();
      refresh();
    }, 1_000);
  };

  const readOnce = async () => {
    const schedule = scheduleFace();
    if (typeof schedule?.catalog !== 'function') return;
    publish({ ...snapshot, status: 'loading' });
    let result;
    try {
      result = await schedule.catalog();
    } catch {
      publish({ ...snapshot, status: 'error' });
      return;
    }
    if (disposed) return;
    if (!result?.ok || !Array.isArray(result.value)) {
      publish({ ...snapshot, status: 'error' });
      return;
    }
    publish({ bySession: indexSchedules(result.value), status: 'ready', settled: true });
  };

  const refresh = () => {
    if (reading) {
      dirty = true;
      return reading;
    }
    reading = readOnce().finally(() => {
      reading = null;
      if (dirty) {
        dirty = false;
        refresh();
      }
    });
    return reading;
  };

  const attach = () => {
    if (remote && typeof remote.$on === 'function' && !offChanged) {
      try {
        offChanged = remote.$on('schedule/changed', () => { refresh(); });
      } catch {
        offChanged = null;
      }
    }
    if (!offReset) {
      try {
        // A reconnect may have missed changes while the socket was down.
        offReset = ctx.on?.('connection/reset', () => { refresh(); }) ?? null;
      } catch {
        offReset = null;
      }
    }
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Idempotent; safe to call from the panel's mount effect. */
    start() {
      if (started || disposed) return undefined;
      started = true;
      if (!scheduleFace()) {
        retryLater();
        return undefined;
      }
      attach();
      return refresh();
    },
    refresh,
    dispose() {
      disposed = true;
      listeners.clear();
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      try {
        offChanged?.();
      } catch { /* already torn down */ }
      try {
        offReset?.();
      } catch { /* already torn down */ }
      offChanged = null;
      offReset = null;
    },
  };
}

/** The active tasks one row should render; the empty array is shared so rows stay memoized. */
export function schedulesOf(snapshot, sessionId) {
  return snapshot?.bySession?.get?.(sessionId) ?? EMPTY;
}

/** `09:00:00.000` → `09:00`, the host's clock label. */
function clockLabel(time) {
  return String(time ?? '').replace(/\.\d+$/, '').replace(/:00$/, '');
}

function unitLabel(unit, value) {
  return t(`schedule.unit.${unit}.${value === 1 ? 'one' : 'other'}`, { count: value });
}

function formatWeekdays(weekdays) {
  const join = t('schedule.weekday.join');
  return (Array.isArray(weekdays) ? weekdays : [])
    .map((day) => t(`schedule.weekday.${day}`))
    .join(join);
}

/** `UTC+08:00`, or nothing when the runtime cannot resolve the zone. */
function offsetLabel(zone) {
  if (!zone) return undefined;
  try {
    const prefix = t('schedule.time.utcPrefix');
    const value = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' })
      .formatToParts(Date.now())
      .find((part) => part.type === 'timeZoneName')?.value;
    if (value === 'GMT') return `${prefix}+00:00`;
    const match = /^GMT([+-])(\d{2}):(\d{2})$/.exec(value ?? '');
    return match ? `${prefix}${match[1]}${match[2]}:${match[3]}` : undefined;
  } catch {
    return undefined;
  }
}

/** `UTC+08:00 · 中国标准时间` — the offset plus the ICU zone name, like the host. */
function zoneLabel(zone) {
  const offset = offsetLabel(zone);
  let name;
  try {
    name = new Intl.DateTimeFormat(t('schedule.time.locale'), { timeZone: zone, timeZoneName: 'longGeneric' })
      .formatToParts(Date.now())
      .find((part) => part.type === 'timeZoneName')?.value;
  } catch {
    name = undefined;
  }
  if (offset === undefined) return name ?? zone ?? '';
  if (name === undefined || /^GMT(?:[+-]|$)/.test(name)) return offset;
  return `${offset} · ${name}`;
}

/** The stored rule as one line: one-shot, fixed interval, daily/weekly wall clock, or cron. */
export function formatFrequency(record) {
  switch (record?.kind) {
    case 'after':
    case 'at':
      return t('schedule.frequency.once');
    case 'daily':
      return t('schedule.frequency.daily', { time: clockLabel(record.time), timeZone: zoneLabel(record.timeZone) });
    case 'weekly':
      return t('schedule.frequency.weekly', {
        weekdays: formatWeekdays(record.weekdays),
        time: clockLabel(record.time),
        timeZone: zoneLabel(record.timeZone),
      });
    case 'cron':
      return t('schedule.frequency.cron', { expression: record.expression, timeZone: zoneLabel(record.timeZone) });
    case 'every': {
      const seconds = Number(record.everySeconds);
      if (!Number.isFinite(seconds) || seconds <= 0) return '';
      const selected = UNITS.find((candidate) => seconds % candidate.seconds === 0) ?? SECOND;
      const value = seconds / selected.seconds;
      return t('schedule.frequency.every', { value, unit: unitLabel(selected.unit, value) });
    }
    default:
      return '';
  }
}

/** The device-zone stamp of one target (`10月21日 09:00`), with the year only where `en` reads it. */
export function formatTarget(scheduledAt) {
  const at = Date.parse(scheduledAt);
  if (Number.isNaN(at)) return String(scheduledAt ?? '');
  const locale = t('schedule.time.locale');
  const year = locale.toLowerCase().startsWith('zh') ? {} : { year: 'numeric' };
  try {
    return new Intl.DateTimeFormat(locale, {
      ...year,
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(at);
  } catch {
    return String(scheduledAt ?? '');
  }
}

/** `(21小时后)` / `(已逾期 3分钟)` — the host's own distance wording, in parentheses. */
export function formatDistance(scheduledAt, now) {
  const at = Date.parse(scheduledAt);
  if (Number.isNaN(at)) return '';
  const difference = at - now;
  if (difference === 0) return `(${t('schedule.relative.now')})`;
  const seconds = Math.abs(difference) / 1000;
  const selected = UNITS.find((candidate) => seconds >= candidate.seconds) ?? SECOND;
  const value = Math.max(1, difference > 0 ? Math.ceil(seconds / selected.seconds) : Math.floor(seconds / selected.seconds));
  const key = difference > 0 ? 'schedule.relative.future' : 'schedule.relative.overdue';
  return `(${t(key, { value, unit: unitLabel(selected.unit, value) })})`;
}

function taskName(record) {
  return String(record?.title || record?.prompt || record?.id || '');
}

/**
 * The hover block: at most two active tasks (overdue first), then the "另有 N 个任务" line.
 * The clock sampling is the caller's `now`, so the block follows the panel's 30s tick.
 */
export function scheduleHover(records, now) {
  const ordered = [...(Array.isArray(records) ? records : [])].sort((left, right) => {
    const leftTime = Date.parse(left?.scheduledAt);
    const rightTime = Date.parse(right?.scheduledAt);
    const leftOverdue = Number.isFinite(leftTime) && leftTime <= now;
    const rightOverdue = Number.isFinite(rightTime) && rightTime <= now;
    if (leftOverdue !== rightOverdue) return Number(rightOverdue) - Number(leftOverdue);
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) return leftTime - rightTime;
    return 0;
  });
  return {
    tasks: ordered.slice(0, 2).map((record) => ({
      id: record.id,
      name: taskName(record),
      frequency: formatFrequency(record),
      scheduledAt: record.scheduledAt,
      absolute: formatTarget(record.scheduledAt),
      relative: formatDistance(record.scheduledAt, now),
    })),
    omitted: Math.max(0, ordered.length - 2),
  };
}
