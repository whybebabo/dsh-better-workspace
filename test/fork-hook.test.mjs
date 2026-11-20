/**
 * The fork observation shim.
 *
 * DSH 0.2.1-rc.3 stopped recording a fork's source on the child ("make ordinary forks
 * independent of source lineage"), so the panel has to learn the source/child pair from the host
 * command that creates it. These tests pin the shim's contract: the wrapper must be transparent
 * (arguments, `this`, result, rejection) and must not be able to break a fork, which is why every
 * listener runs isolated and why a service that cannot be extended yields no hook at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { watchSessionForks } from '../client/fork-hook.js';

/** A host-like service: `fork` is a prototype-style method and records how it was called. */
function makeService(resolve = (id) => `${id}-child`) {
  const service = {
    calls: [],
    thisSeen: [],
    fork(options) {
      this.calls.push(options);
      this.thisSeen.push(this);
      return Promise.resolve(resolve(options.sessionId));
    },
  };
  return service;
}

test('the observed fork reports the source and the child to every subscriber', async () => {
  const service = makeService();
  const seen = [];
  const other = [];
  const stopA = watchSessionForks(service, (fork) => seen.push(fork));
  const stopB = watchSessionForks(service, (fork) => other.push(fork));

  const child = await service.fork({ sessionId: 'session-a', increaseTitle: true });

  assert.equal(child, 'session-a-child', 'the resolved child id is passed through untouched');
  assert.deepEqual(seen, [{ sourceId: 'session-a', childId: 'session-a-child' }]);
  assert.deepEqual(other, seen, 'a second subscriber sees the same pair');
  stopA();
  stopB();
});

test('the method is wrapped once per service, not once per subscriber', async () => {
  const service = makeService();
  const original = service.fork;
  const stopA = watchSessionForks(service, () => {});
  const afterFirst = service.fork;
  const stopB = watchSessionForks(service, () => {});

  assert.notEqual(afterFirst, original, 'the first subscription replaces the method');
  assert.equal(service.fork, afterFirst, 'the second one reuses the installed shim');
  await service.fork({ sessionId: 'session-b' });
  assert.equal(service.calls.length, 1, 'the original ran exactly once for one fork');
  stopA();
  stopB();
});

test('the shim preserves the receiver, the arguments and a synchronous result', () => {
  const service = {
    seen: null,
    fork(options) {
      this.seen = options;
      return 'synchronous-child';
    },
  };
  const pairs = [];
  const stop = watchSessionForks(service, (fork) => pairs.push(fork));

  const options = { sessionId: 'session-c', atSeq: 4, allowMigration: false };
  const result = service.fork(options);

  assert.equal(result, 'synchronous-child', 'a non-thenable answer is returned as it was');
  assert.equal(service.seen, options, 'the receiver and the arguments are the caller\'s own');
  assert.deepEqual(pairs, [], 'a value that is not a promise cannot be observed, and is not guessed');
  stop();
});

test('a rejected fork is reported unchanged and observes nothing', async () => {
  const failure = Object.assign(new Error('migration required'), { code: 'session/migration-required' });
  const service = makeService(() => Promise.reject(failure));
  const pairs = [];
  const stop = watchSessionForks(service, (fork) => pairs.push(fork));

  await assert.rejects(() => service.fork({ sessionId: 'session-d' }), (error) => error === failure);
  assert.deepEqual(pairs, [], 'a refused fork files nothing');
  stop();
});

test('a synchronous throw from the host method is not converted into a rejection', () => {
  const failure = new Error('host refused synchronously');
  const service = {
    fork() {
      throw failure;
    },
  };
  const stop = watchSessionForks(service, () => {});
  assert.throws(() => service.fork({ sessionId: 'session-i' }), (error) => error === failure);
  stop();
});

test('a self-fork and a non-string child are ignored', async () => {
  const pairs = [];
  const self = makeService((id) => id);
  const stopSelf = watchSessionForks(self, (fork) => pairs.push(fork));
  await self.fork({ sessionId: 'session-e' });

  const odd = { fork: () => Promise.resolve({ id: 'not-a-string' }) };
  const stopOdd = watchSessionForks(odd, (fork) => pairs.push(fork));
  await odd.fork({ sessionId: 'session-f' });

  assert.deepEqual(pairs, [], 'neither a source forking itself nor a structured answer is a pair');
  stopSelf();
  stopOdd();
});

test('a listener that throws cannot fail the user\'s fork', async () => {
  const service = makeService();
  const pairs = [];
  const stopBad = watchSessionForks(service, () => { throw new Error('panel bug'); });
  const stopGood = watchSessionForks(service, (fork) => pairs.push(fork));

  await assert.doesNotReject(() => service.fork({ sessionId: 'session-g' }));
  assert.deepEqual(pairs, [{ sourceId: 'session-g', childId: 'session-g-child' }], 'the other listeners still run');
  stopBad();
  stopGood();
});

test('unsubscribing stops the notifications and is idempotent', async () => {
  const service = makeService();
  const pairs = [];
  const stop = watchSessionForks(service, (fork) => pairs.push(fork));
  stop();
  stop();
  await service.fork({ sessionId: 'session-h' });
  assert.deepEqual(pairs, [], 'a released listener is never called');
});

test('a host without a fork command, or a frozen service, yields no hook', () => {
  assert.equal(watchSessionForks(null, () => {}), null, 'no service');
  assert.equal(watchSessionForks({}, () => {}), null, 'no fork method');
  assert.equal(watchSessionForks(makeService(), null), null, 'no listener');

  const frozen = Object.freeze({ fork: () => Promise.resolve('child') });
  assert.equal(watchSessionForks(frozen, () => {}), null, 'the shim never half-installs on a frozen service');
  assert.equal(typeof frozen.fork, 'function', 'and the host method is left alone');
});