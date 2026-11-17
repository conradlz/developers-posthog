'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { hashGraph } = require('./git-assessments');
const { hydrate, safeAvatarUrl, graphIds } = require('./hydrate-git-avatars');

const hash = n => n.toString(16).padStart(40, '0');
const id = n => `contributor:${hash(n)}`;
const graph = (count = 2) => ({
  schemaVersion: 1, metadata: { repositoryUrl: 'https://github.com/PostHog/posthog', head: hash(999) },
  contributors: Array.from({ length: count }, (_, i) => ({ id: id(i + 1), name: 'not used' })),
  commits: [], files: [], edges: [],
});
const clone = x => structuredClone(x);
const reply = body => ({ ok: true, headers: { get: () => null }, text: async () => JSON.stringify(body) });
const author = n => ({ login: `user${n}`, avatar_url: `https://avatars.githubusercontent.com/u/${n}?v=4` });
const fixtureFetch = callback => async (url, options) => {
  const anchor = url.split('/').at(-1);
  callback?.(url, options);
  return reply({ sha: anchor, author: author(parseInt(anchor, 16)) });
};

class MockDB {
  constructor(data) { this.data = clone(data); this.paths = []; this.transactions = 0; this.beforeTransaction = null; }
  ref(path = '') {
    this.paths.push(path);
    return {
      on: (_event, cb) => { queueMicrotask(() => cb({ val: () => clone(this.data) })); return cb; },
      off: () => {},
      transaction: async fn => {
        this.transactions++;
        if (this.beforeTransaction) await this.beforeTransaction();
        const next = fn(clone(this.data));
        if (next === undefined) return { committed: false };
        this.data = clone(next);
        return { committed: true };
      },
    };
  }
}
const run = (db, fetch = fixtureFetch(), extra = {}) =>
  hydrate({ db, token: 'private-token', fetch, now: () => new Date('2026-01-01T00:00:00Z'), ...extra });

test('accepts GitHub bot author logins', async () => {
  const db = new MockDB({ git_graph: graph(1) });
  await run(db, async () => reply({ sha: hash(1), author: { login: 'posthog[bot]', avatar_url: 'https://avatars.githubusercontent.com/in/1203049?v=4' } }));
  assert.equal(db.data.git_avatars.contributors[id(1)].login, 'posthog[bot]');
});

test('publishes graph-bound anchor associations without changing graph or unrelated data', async () => {
  const original = graph();
  const db = new MockDB({ git_graph: original, other: { preserve: 1 } });
  const calls = [];
  const result = await run(db, fixtureFetch((url, options) => {
    calls.push(url);
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer private-token');
  }));
  assert.equal(result.status, 'published');
  assert.equal(result.requested, 2);
  assert.deepEqual(calls, [1, 2].map(n => `https://api.github.com/repos/PostHog/posthog/commits/${hash(n)}`));
  assert.deepEqual(db.data.git_graph, original);
  assert.deepEqual(db.data.other, { preserve: 1 });
  assert.deepEqual(db.data.git_avatars, {
    graphHash: hashGraph(original), generatedAt: '2026-01-01T00:00:00.000Z',
    contributors: Object.fromEntries([1, 2].map(n => [id(n), {
      avatarUrl: `https://avatars.githubusercontent.com/u/${n}?v=4`, login: `user${n}`,
      sourceUrl: `https://github.com/PostHog/posthog/commit/${hash(n)}`,
    }])),
  });
  assert.deepEqual(db.paths, ['']);
  assert(!JSON.stringify(db.data.git_avatars).includes('email'));
  const saved = clone(db.data.git_avatars);
  assert.equal((await run(db, () => { throw new Error('must not fetch'); })).status, 'unchanged');
  assert.deepEqual(db.data.git_avatars, saved);
  assert.equal(db.transactions, 1);
});

test('null author is omitted; idempotency accepts RTDB-elided empty object', async () => {
  const db = new MockDB({ git_graph: graph(1) });
  const fetch = async url => reply({ sha: url.split('/').at(-1), author: null });
  await run(db, fetch);
  assert.deepEqual(db.data.git_avatars.contributors, {});
  delete db.data.git_avatars.contributors;
  assert.equal((await run(db, () => { throw new Error('must not fetch'); })).status, 'unchanged');
});

test('enforces exactly one request per anchor and an absolute 40 request cap', async () => {
  for (const count of [40, 41]) {
    const db = new MockDB({ git_graph: graph(count) });
    let calls = 0;
    const promise = run(db, fixtureFetch(() => calls++));
    if (count === 41) await assert.rejects(promise, /limit/);
    else await promise;
    assert.equal(calls, count === 40 ? 40 : 0);
  }
  const duplicate = graph();
  duplicate.contributors[1].id = duplicate.contributors[0].id;
  assert.throws(() => graphIds(duplicate), /Duplicate/);
  duplicate.contributors[0].id = 'contributor:bad.key';
  assert.throws(() => graphIds(duplicate), /ID/);
});

test('validates exact HTTPS avatar host and rejects URLs containing hidden data', () => {
  for (const url of ['https://avatars.githubusercontent.com/u/123?v=4',
    'https://avatars.githubusercontent.com/in/123', 'https://avatars.githubusercontent.com/u/123']) {
    assert(safeAvatarUrl(url));
  }
  for (const url of ['http://avatars.githubusercontent.com/u/1', 'https://avatars.githubusercontent.com.evil/u/1',
    'https://evil@avatars.githubusercontent.com/u/1', 'https://avatars.githubusercontent.com:444/u/1',
    'https://avatars.githubusercontent.com/u/1?email=a@example.com',
    'https://avatars.githubusercontent.com/u/1#x', 'https://avatars.githubusercontent.com/user@example.com',
    'https://AVATARS.githubusercontent.com/u/1', 'https://avatars.githubusercontent.com/u/1?v=4&x=y']) {
    assert.equal(safeAvatarUrl(url), false, url);
  }
});

test('provider, parsing, invalid author, mismatched SHA and clock failures leave snapshot untouched with no retries', async () => {
  const existing = { graphHash: 'a'.repeat(64), generatedAt: '2025-01-01T00:00:00.000Z',
    contributors: { [id(1)]: { avatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4', login: 'user1',
      sourceUrl: `https://github.com/PostHog/posthog/commit/${hash(1)}` } } };
  const fail = [
    async () => { throw new Error('token leaked'); },
    async () => ({ ok: false }),
    async () => ({ ok: true, headers: { get: () => '256001' } }),
    async () => ({ ok: true, headers: { get: () => null }, text: async () => 'invalid json' }),
    async () => reply({ sha: hash(2), author: author(1) }),
    async () => reply({ sha: hash(1), author: { ...author(1), avatar_url: 'https://evil.example/u/1' } }),
    async () => reply({ sha: hash(1), author: { ...author(1), login: 'name@example.com' } }),
  ];
  for (const fetch of fail) {
    const db = new MockDB({ git_graph: graph(1), git_avatars: existing });
    let calls = 0;
    await assert.rejects(run(db, (...args) => { calls++; return fetch(...args); }));
    assert.equal(calls, 1);
    assert.equal(db.transactions, 0);
    assert.deepEqual(db.data.git_avatars, existing);
  }
  const db = new MockDB({ git_graph: graph(1), git_avatars: existing });
  await assert.rejects(run(db, fixtureFetch(), { now: () => new Date('invalid') }), /clock/);
  assert.deepEqual(db.data.git_avatars, existing);
});

test('atomically refuses changed graph or concurrent avatar publication', async () => {
  for (const changed of ['graph', 'avatar']) {
    const db = new MockDB({ git_graph: graph(1), other: 3 });
    db.beforeTransaction = async () => {
      if (changed === 'graph') db.data.git_graph.metadata.head = hash(1000);
      else db.data.git_avatars = { other: 'concurrent writer' };
    };
    await assert.rejects(run(db), /changed/);
    assert.equal(db.data.other, 3);
    if (changed === 'avatar') assert.deepEqual(db.data.git_avatars, { other: 'concurrent writer' });
    else assert.equal(db.data.git_avatars, undefined);
  }
});

test('malformed existing snapshots are not overwritten', async () => {
  const bad = { graphHash: 'oops', generatedAt: 'bad' };
  const db = new MockDB({ git_graph: graph(1), git_avatars: bad });
  await assert.rejects(run(db, () => { throw new Error('must not fetch'); }), /existing/);
  assert.deepEqual(db.data.git_avatars, bad);
});

test('CLI requires explicit configuration and live opt-in without logging secrets', () => {
  const script = require.resolve('./hydrate-git-avatars');
  const base = { PATH: process.env.PATH, GCLOUD_PROJECT: 'demo-test',
    FIREBASE_DATABASE_URL: 'https://demo-test-default-rtdb.firebaseio.com', GITHUB_TOKEN: 'private-token' };
  for (const env of [base, { ...base, FIREBASE_DATABASE_EMULATOR_HOST: 'remote.example:9000' },
    { ...base, FIREBASE_DATABASE_URL: 'https://private-token@bad.example' }, { ...base, GITHUB_TOKEN: '' }]) {
    const result = spawnSync(process.execPath, [script], { env, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert(!result.stderr.includes('private-token'));
  }
  const help = spawnSync(process.execPath, [script, '--help'], { env: base, encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--env-file/);
});
