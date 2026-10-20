/**
 * Scheduled-task projection: the copy and the ordering the stock hover card uses.
 *
 * These are pure functions over a catalog snapshot, so the cases pin the wording without a
 * DOM (`test/panel.test.mjs` covers where the block is mounted).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDistance, formatFrequency, formatTarget, indexSchedules, scheduleHover, createScheduleStore } from '../client/schedule.js';

const daily = {
  id: 'sch_daily',
  sessionId: 'ses_1',
  status: 'active',
  kind: 'daily',
  title: '每天早上发送问候',
  prompt: '问候',
  time: '09:00:00.000',
  timeZone: 'Asia/Shanghai',
  scheduledAt: '2026-10-21T01:00:00.000Z',
};

test('the daily rule reads like the host card: time, offset and zone', () => {
  const text = formatFrequency(daily);
  assert.ok(text.startsWith('每天 09:00（UTC+08:00'), text);
  assert.ok(text.endsWith('）'), 'the zone label keeps the host parentheses');
  assert.ok(text.includes('·'), 'offset and ICU zone name are joined with a middle dot');
});

test('weekly, fixed interval, one-shot and cron rules keep their stored shape', () => {
  assert.ok(formatFrequency({ ...daily, kind: 'weekly', weekdays: [1, 3] }).startsWith('每周一、三 09:00（'));
  assert.equal(formatFrequency({ ...daily, kind: 'every', everySeconds: 3_600 }), '1小时一次');
  assert.equal(formatFrequency({ ...daily, kind: 'every', everySeconds: 90 }), '90秒一次');
  assert.equal(formatFrequency({ ...daily, kind: 'at' }), '单次');
  assert.equal(formatFrequency({ ...daily, kind: 'after' }), '单次');
  assert.ok(formatFrequency({ ...daily, kind: 'cron', expression: '0 9 * * *' }).startsWith('Cron 0 9 * * *（'));
});

test('the clock label strips fractional and all-zero seconds the way the host does', () => {
  assert.ok(formatFrequency({ ...daily, time: '09:05:30.000' }).startsWith('每天 09:05:30（'), 'a real second is meaningful');
  assert.ok(formatFrequency({ ...daily, time: '09:00:00.000' }).startsWith('每天 09:00（'));
});

test('distance uses the host wording and stays deterministic for a fixed clock', () => {
  const now = Date.parse('2026-10-20T00:00:00.000Z');
  assert.equal(formatDistance('2026-10-20T12:00:00.000Z', now), '(12小时后)');
  assert.equal(formatDistance('2026-10-20T00:00:00.000Z', now), '(现在到期)');
  assert.equal(formatDistance('2026-10-19T21:00:00.000Z', now), '(已逾期 3小时)');
});

test('the absolute stamp follows the language: Chinese omits the year', () => {
  const iso = '2026-10-21T01:00:00.000Z';
  const text = formatTarget(iso);
  const expected = new Intl.DateTimeFormat('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(Date.parse(iso));
  assert.equal(text, expected, 'the device zone and the Chinese month/day form');
  assert.ok(!text.includes('2026'), 'Chinese copy never states the year');
});

test('only active tasks mark a row, and only for their own session', () => {
  const bySession = indexSchedules([
    daily,
    { ...daily, id: 'sch_other', sessionId: 'ses_2' },
    { ...daily, id: 'sch_old', status: 'inactive' },
    { ...daily, id: 'sch_archived', status: 'inactive', sessionId: 'ses_2' },
  ]);
  assert.deepEqual(bySession.get('ses_1').map((record) => record.id), ['sch_daily']);
  assert.deepEqual(bySession.get('ses_2').map((record) => record.id), ['sch_other']);
  assert.equal(bySession.get('ses_3'), undefined);
});

test('the hover block shows overdue tasks first, caps at two and counts the rest', () => {
  const now = Date.parse('2026-10-20T12:00:00.000Z');
  const future = { ...daily, id: 'sch_future', scheduledAt: '2026-10-21T01:00:00.000Z' };
  const overdue = { ...daily, id: 'sch_overdue', title: '补发问候', scheduledAt: '2026-10-20T11:00:00.000Z' };
  const later = { ...daily, id: 'sch_later', title: '晚安', scheduledAt: '2026-10-22T01:00:00.000Z' };
  const view = scheduleHover([future, later, overdue], now);
  assert.deepEqual(view.tasks.map((task) => task.id), ['sch_overdue', 'sch_future'], 'overdue leads, then the nearest future target');
  assert.equal(view.omitted, 1);
  assert.equal(view.tasks[0].relative, '(已逾期 1小时)');
  assert.equal(view.tasks[0].frequency.startsWith('每天 09:00'), true, 'the rule travels with each row');
  assert.equal(scheduleHover([daily], now).omitted, 0);
});

test('the shared store reads once and follows schedule/changed', async () => {
  let records = [daily];
  let reads = 0;
  const listeners = new Map();
  // The real Client exposes each namespace as its own Cordis service (`remote.schedule`),
  // while `remote` itself only carries the forwarded events. Reading `remote.schedule` as a
  // *property* of the facade throws without an `inject` entry, so the store must never do it
  // — that throw used to be swallowed and blanked both native surfaces.
  const facade = {
    get schedule() {
      throw new Error('cannot get property "remote.schedule" without inject');
    },
    $on(event, listener) {
      listeners.set(event, listener);
      return () => listeners.delete(event);
    },
  };
  const ctx = {
    get: (name) => {
      if (name === 'remote.schedule') {
        return {
          async catalog() {
            reads += 1;
            return { ok: true, value: records };
          },
        };
      }
      if (name === 'remote') return facade;
      return null;
    },
    on: () => () => {},
  };
  const store = createScheduleStore(ctx);
  await store.start();
  assert.equal(reads, 1, 'one global read serves the whole panel');
  assert.equal(store.getSnapshot().status, 'ready', 'the namespace service answered the catalog');
  assert.deepEqual(scheduleHover(store.getSnapshot().bySession.get('ses_1'), Date.now()).tasks.map((task) => task.name), ['每天早上发送问候']);

  records = [];
  listeners.get('schedule/changed')();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(reads, 2, 'the invalidation re-reads the catalog');
  assert.equal(store.getSnapshot().bySession.size, 0, 'ended tasks leave the row');
  store.dispose();
});

test('a composition without the schedule plugin stays silent instead of throwing', async () => {
  const store = createScheduleStore({
    // The service never mounts: `ctx.get` answers undefined, and the facade guard may throw.
    get: () => {
      throw new Error('cannot get property "remote.schedule" without inject');
    },
    on: () => () => {},
  });
  await store.start();
  assert.equal(store.getSnapshot().status, 'idle');
  assert.equal(store.getSnapshot().settled, false);
  assert.equal(store.getSnapshot().bySession.size, 0);
  store.dispose();
});
