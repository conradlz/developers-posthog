'use strict';

const assert = require('assert');
const { activityWindow, collectContributors, createHandler, githubClient } = require('./contributors');

// The deployed Node 22 runtime provides AbortController; keep mock tests runnable
// on the older local Node versions that may be present in a blank workspace.
if (typeof global.AbortController === 'undefined') {
  global.AbortController = class {
    constructor() { this.signal = {}; }
    abort() {}
  };
}

function response() {
  return {
    headers: {}, code: 0, body: null,
    set(key, value) { this.headers[key] = value; return this; },
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

// One shared store models the atomic transaction semantics across instances.
function database() {
  let value = null;
  const copy = (item) => item == null ? null : JSON.parse(JSON.stringify(item));
  function rtdbValue(item) {
    if (item === null || item === undefined) return null;
    if (typeof item !== 'object') return item;
    const result = {};
    for (const [key, child] of Object.entries(item)) {
      const stored = rtdbValue(child);
      if (stored !== null) result[key] = stored;
    }
    return Object.keys(result).length ? result : null;
  }
  const history = [];
  return {
    history,
    value: () => copy(value),
    ref(path) {
      assert.strictEqual(path, 'contributor_data');
      return {
        async get() { const read = copy(value); return { val: () => read }; },
        async transaction(update) {
          const next = update(copy(value));
          const committed = next !== undefined;
          if (committed) {
            value = rtdbValue(copy(next));
            history.push(copy(value));
          }
          const read = copy(value);
          return { committed, snapshot: { val: () => read } };
        },
      };
    },
  };
}

async function run() {
  assert.deepStrictEqual(activityWindow(new Date('2024-03-01T12:00:00Z')), {
    start: '2023-12-02', end: '2024-02-29',
  });
  const paths = [];
  const get = async (path) => {
    paths.push(path);
    if (path.includes('/contributors?')) return [
      { login: 'bot', type: 'Bot', contributions: 300 },
      { login: 'alice', type: 'User', contributions: 200, avatar_url: 'https://example.com/avatar' },
    ];
    return { total_count: 23, incomplete_results: path.includes('/commits?') };
  };
  const data = await collectContributors(get, new Date('2024-03-01T12:00:00Z'));
  assert.strictEqual(data.contributors.length, 1);
  assert.deepStrictEqual(data.contributors[0].commits, { count: 23, incomplete: true });
  assert.strictEqual(data.contributors[0].issues_commented_on.count, 23);
  assert(decodeURIComponent(paths[1]).includes('author-date:2023-12-02..2024-02-29'));
  assert(decodeURIComponent(paths[3]).includes('is:issue commenter:alice'));

  const interval = 12 * 60 * 60 * 1000;
  let time = Date.parse('2024-03-01T12:00:00Z');
  let calls = 0;
  let fail = false;
  let users = ['alice', 'bob'];
  let gate = deferred();
  let started = deferred();
  const fetch = async (url) => {
    calls++;
    if (url.includes('/contributors?') && gate) {
      started.resolve();
      await gate.promise;
    }
    if (fail) return { ok: false, status: 403 };
    return { ok: true, json: async () => url.includes('/contributors?') ?
      users.map((login) => ({ login, type: 'User', contributions: 5 })) :
      { total_count: 1, incomplete_results: false } };
  };
  const db = database();
  const options = { db, now: () => time, getToken: () => 'secret', fetch };
  const handler = createHandler(options);
  const otherInstance = createHandler(options);
  const request = async (fn = handler) => {
    const res = response();
    await fn({ method: 'GET' }, res);
    return res;
  };
  const first = request();
  const racers = Array.from({ length: 10 }, () => request(otherInstance));
  await started.promise;
  const pending = await Promise.all(racers);
  assert(pending.every((res) => res.code === 503 && res.headers['Retry-After']));
  assert.strictEqual(calls, 1);
  gate.resolve();
  const initial = await first;
  assert.strictEqual(initial.code, 200);
  assert.strictEqual(initial.body.stale, false);
  assert.deepStrictEqual(initial.body.contributors.map((user) => user.login), ['alice', 'bob']);
  assert.strictEqual(initial.body.contributors[0].avatar_url, null);
  assert.strictEqual(JSON.stringify(initial.body).includes('secret'), false);
  assert.deepStrictEqual(Object.keys(db.value().users), ['alice', 'bob']);
  assert.strictEqual(db.value().job.status, 'succeeded');
  assert.strictEqual(calls, 7);
  const method = response();
  await handler({ method: 'POST' }, method);
  assert.strictEqual(method.code, 405);
  assert.strictEqual(method.headers.Allow, 'GET');

  time += interval - 1;
  assert.strictEqual((await request()).body.stale, false);
  assert.strictEqual(calls, 7);
  time++;
  gate = deferred();
  started = deferred();
  users = ['carol'];
  const refresh = request(otherInstance);
  await started.promise;
  const during = await request();
  assert.strictEqual(during.code, 200);
  assert.strictEqual(during.body.stale, true);
  assert.deepStrictEqual(during.body.contributors.map((user) => user.login), ['alice', 'bob']);
  assert.deepStrictEqual(Object.keys(db.value().users), ['alice', 'bob']);
  gate.resolve();
  const updated = await refresh;
  assert.deepStrictEqual(updated.body.contributors.map((user) => user.login), ['carol']);
  assert.deepStrictEqual(Object.keys(db.value().users), ['carol']);
  assert.strictEqual(db.value().job.status, 'succeeded');
  for (const state of db.history) {
    if (state.snapshot) {
      assert.deepStrictEqual(Object.values(state.snapshot.order || {}).sort(),
        Object.keys(state.users || {}).sort());
    }
  }

  time += interval;
  gate = null;
  fail = true;
  const failed = await request();
  assert.strictEqual(failed.code, 200);
  assert.strictEqual(failed.body.stale, true);
  assert.deepStrictEqual(failed.body.contributors.map((user) => user.login), ['carol']);
  assert.strictEqual(db.value().job.status, 'failed');
  const afterFailure = calls;
  time += interval - 1;
  const stillStale = await request(otherInstance);
  assert.strictEqual(stillStale.body.stale, true);
  assert.strictEqual(calls, afterFailure);
  time++;
  fail = false;
  users = ['dave'];
  assert.deepStrictEqual((await request()).body.contributors.map((user) => user.login), ['dave']);
  assert.strictEqual(calls, afterFailure + 4);

  // An abandoned, superseded worker must never publish over its replacement.
  time += interval;
  gate = deferred();
  started = deferred();
  const oldGate = gate;
  const oldWorker = request();
  await started.promise;
  time += interval;
  gate = null;
  users = ['eve'];
  const replacement = await request(otherInstance);
  assert.deepStrictEqual(replacement.body.contributors.map((user) => user.login), ['eve']);
  oldGate.resolve();
  const oldResult = await oldWorker;
  assert.deepStrictEqual(oldResult.body.contributors.map((user) => user.login), ['eve']);
  assert.deepStrictEqual(Object.keys(db.value().users), ['eve']);

  // A first-attempt failure persists its cooldown even across handler instances.
  const emptyDb = database();
  fail = true;
  const failedHandler = createHandler({ ...options, db: emptyDb });
  const failedFirst = await request(failedHandler);
  assert.strictEqual(failedFirst.code, 503);
  assert.strictEqual(emptyDb.value().job.status, 'failed');
  const failedCalls = calls;
  time += interval - 1;
  const restartedHandler = createHandler({ ...options, db: emptyDb });
  assert.strictEqual((await request(restartedHandler)).code, 503);
  assert.strictEqual(calls, failedCalls);
  time++;
  fail = false;
  assert.strictEqual((await request(restartedHandler)).code, 200);

  // An empty contributor list must survive RTDB removing empty objects.
  const emptyListDb = database();
  users = [];
  const emptyListHandler = createHandler({ ...options, db: emptyListDb });
  assert.deepStrictEqual((await request(emptyListHandler)).body.contributors, []);
  assert.deepStrictEqual((await request(createHandler({ ...options, db: emptyListDb }))).body.contributors, []);

  const rateHandler = createHandler(options);
  for (let i = 0; i < 60; i++) await request(rateHandler);
  const limited = await request(rateHandler);
  assert.strictEqual(limited.code, 429);
  assert(limited.headers['Retry-After']);

  const client = githubClient('secret', async (url, options) => {
    assert.strictEqual(options.headers.Authorization, 'Bearer secret');
    return { ok: false, status: 401 };
  });
  await assert.rejects(() => client('/test'), (error) => error.status === 401);
  console.log('Backend tests passed');
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
