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

/**
 * Resolve one optional service.
 *
 * A namespace that this plugin did not declare in `inject`, that has not mounted yet, or
 * that the composition omits answers `null` — the clock and the hover block are decoration
 * and must never take the panel down. The reason is still logged once, because the bug this
 * guards against is precisely an *expected* service silently reading as absent.
 */
const warned = new Set();
function service(ctx, name) {
  try {
    return ctx.get?.(name) ?? null;
  } catch (error) {
    if (!warned.has(name)) {
      warned.add(name);
      console.warn(`[dsh-better-workspace] cannot resolve ${name}: ${error?.message ?? error}`);
    }
    return null;
  }
}

/**
 * The Session a catalog entry belongs to.
 *
 * DSH 0.2.2 moved the delivery destination into `record.target`:
 *   - `{ kind: 'session', sessionId }`
 *   - `{ kind: 'new_once', sessionId }` (reserved before the first delivery)
 *   - `{ kind: 'new' }` (the first delivered Session is in `lastDelivery`)
 * The 0.2.1 catalogs exposed a top-level `sessionId`; keeping it as a fallback lets the panel
 * work on both shapes instead of silently dropping every task (which is what happened when
 * only the old field was read).
 *
 * @param {object} record - one `remote.schedule.catalog()` entry
 * @returns {string|null} the Session id, or null for a `new` rule with no delivery yet
 */
export function targetSessionId(record) {
  const target = record?.target;
  if (target && typeof target === 'object') {
    if (target.kind === 'new') {
      const delivered = record?.lastDelivery?.targetSessionId;
      return typeof delivered === 'string' && delivered !== '' ? delivered : null;
    }
    if (typeof target.sessionId === 'string' && target.sessionId !== '') return target.sessionId;
  }
  const legacy = record?.sessionId;
  return typeof legacy === 'string' && legacy !== '' ? legacy : null;
}

/** Group active catalog records by their target session; inactive rows never mark. */
export function indexSchedules(records) {
  const bySession = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    if (record?.status !== 'active') continue;
    const sessionId = targetSessionId(record);
    if (!sessionId) continue;
    const list = bySession.get(sessionId);
    if (list) list.push(record);
    else bySession.set(sessionId, [record]);
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
  /** Off screen: subscriptions released, snapshot retained. See `pause()`/`resume()`. */
  let paused = false;
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

  /**
   * The `remote.schedule` namespace.
   *
   * `remote` is a Cordis **service**, and each namespace is registered as its own service
   * (`remote.schedule`). Reading `ctx.get('remote').schedule` therefore throws
   * `cannot get property "remote.schedule" without inject` — the facade proxy only exposes
   * namespaces to a plugin that declared them in `inject`, and it *throws* rather than
   * returning undefined. That throw used to be swallowed here, so the catalog never loaded
   * and both native surfaces stayed blank. Only the dotted service name resolves.
   */
  const scheduleFace = () => {
    const namespace = service(ctx, 'remote.schedule');
    if (namespace && typeof namespace.catalog === 'function') return namespace;
    return null;
  };

  /**
   * The event face: `remote` itself. `schedule/changed` is forwarded on the Remote service,
   * which is a different object from the namespace.
   */
  const eventFace = () => {
    const face = service(ctx, 'remote');
    return face && typeof face.$on === 'function' ? face : null;
  };

  /**
   * The schedule face may register after this overlay mounts (both are client plugins); a
   * bounded retry is enough — a composition without it never answers and must stay silent.
   */
  const retryLater = () => {
    if (disposed || paused || retryTimer || attempts >= 5) return;
    attempts += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (disposed || paused) return;
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
    const face = eventFace();
    if (face && !offChanged) {
      try {
        offChanged = face.$on('schedule/changed', () => { refresh(); });
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

  /** Detaches both invalidations without forgetting that the store was ever started. */
  const detach = () => {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    // A retry armed while paused must not resurrect the subscriptions behind it.
    attempts = 0;
    try {
      offChanged?.();
    } catch { /* already torn down */ }
    try {
      offReset?.();
    } catch { /* already torn down */ }
    offChanged = null;
    offReset = null;
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Idempotent; safe to call from the panel's mount effect. */
    start() {
      if (started || disposed || paused) return undefined;
      started = true;
      if (!scheduleFace()) {
        retryLater();
        return undefined;
      }
      attach();
      return refresh();
    },
    /**
     * Suspends the catalog while the panel is off screen: the two invalidations are released
     * and no retry is armed, so a hidden overlay costs nothing. The last snapshot is kept, so
     * resuming paints the rows the user last saw instead of blanking them for one roundtrip.
     *
     * `paused` is checked by `start()` itself, not just by the caller: otherwise an effect
     * that re-runs while hidden would restart the whole thing.
     */
    pause() {
      if (disposed || paused) return;
      paused = true;
      detach();
    },
    /** Re-attaches and re-reads; a pause/resume cycle must never leave `started` false. */
    resume() {
      if (disposed || !paused) return undefined;
      paused = false;
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
  // '09:00:00.000' → '09:00'; the seconds are dropped only when there is still a clock left.
  // Stripping ':00' unconditionally turned '00:00' into '00' (midnight rendered as an empty hour).
  const trimmed = String(time ?? '').replace(/\.\d+$/, '');
  return trimmed.includes(':') ? trimmed.replace(/(\d{2}:\d{2}):00$/, '$1') : trimmed;
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

/**
 * An `rrule` catalog entry carries its zone inside the DTSTART line, not as a top-level
 * `timeZone` field (unlike daily/weekly/cron). Read the explicit TZID first, then fall back to
 * the stored field so both older and current hosts render the right offset.
 */
function rruleZone(record) {
  if (typeof record?.timeZone === 'string' && record.timeZone !== '') return record.timeZone;
  const match = /TZID=([^:;]+)/i.exec(String(record?.rrule ?? ''));
  return match?.[1] || undefined;
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
    case 'rrule':
      // Current hosts expose a custom recurrence as `rrule`; the raw rule is a multi-line
      // DTSTART/RRULE document, so the row uses the host's "custom rule" wording instead.
      return t('schedule.frequency.rrule', { timeZone: zoneLabel(rruleZone(record)) });
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
  // A caller that forgets the clock used to produce `NaN` seconds and a `NaN` label.
  const reference = Number.isFinite(now) ? now : Date.now();
  const difference = at - reference;
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
