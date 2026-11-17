'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { INTERVAL_MS, validateConfig, validateGraph, readGraph, publish } = require('./publish-git-graph');

const copy = value => structuredClone(value);
const graph = () => ({
  schemaVersion: 1, metadata: { head: 'abc', identity: 'Email is used to group identities.' },
  contributors: [{ id: 'contributor:abc', name: 'Alice', commitCount: 1 }],
  commits: [{ id: 'commit:abc', hash: 'abc' }],
  files: [{ id: 'file:abc', path: 'src/a.js' }],
  edges: [
    { source: 'contributor:abc', target: 'commit:abc', type: 'authored' },
    { source: 'commit:abc', target: 'file:abc', type: 'changed' },
  ],
});

// Optimistic compare-and-swap with deliberately asynchronous commits forces
// concurrent transactions to rerun their update callbacks on conflicts.
class MockDatabase {
  constructor(data = null) { this.data = copy(data); this.version = 0; this.paths = []; }
  ref(pathname) {
    this.paths.push(pathname || '/');
    return { on: (_event, callback) => { setImmediate(() => callback({ val: () => copy(this.data) })); return callback; },
      off: () => {}, transaction: async update => {
      for (;;) {
        const version = this.version;
        const result = update(copy(this.data));
        if (result === undefined) return { committed: false };
        await new Promise(resolve => setImmediate(resolve));
        if (version !== this.version) continue;
        this.data = copy(result);
        this.version++;
        return { committed: true };
      }
    } };
  }
}
const run = (db, now, id, load = async () => graph()) => publish({ db, now: () => now, id, load });

test('publishes flat tables atomically and preserves unrelated root children', async () => {
  const db = new MockDatabase({ other: { sensitive: 'leave unchanged' } });
  await run(db, 1000, 'first');
  assert.deepEqual(db.data.other, { sensitive: 'leave unchanged' });
  assert.deepEqual(db.data.git_graph, graph());
  assert.deepEqual(db.data.git_tracked_users, { 'contributor:abc': graph().contributors[0] });
  assert.deepEqual(db.data.git_hydration_jobs.jobs.first, { startedAt: 1000, status: 'succeeded', finishedAt: 1000 });
  assert(db.paths.every(p => p === '/'));
  await assert.rejects(run(db, 1000 + INTERVAL_MS - 1, 'early'), /12 hours/);
  await run(db, 1000 + INTERVAL_MS, 'next');
  assert.equal(db.data.git_hydration_jobs.activeJobId, 'next');
});

test('concurrent claims admit one writer and reserve before loading', async () => {
  const db = new MockDatabase();
  let loads = 0;
  const load = async () => { loads++; return graph(); };
  const outcomes = await Promise.allSettled([run(db, 1000, 'a', load), run(db, 1000, 'b', load)]);
  assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(loads, 1);
  assert.equal(Object.keys(db.data.git_hydration_jobs.jobs).length, 1);
});

test('failure consumes cooldown and retains previous publication', async () => {
  const db = new MockDatabase();
  await run(db, 1000, 'success');
  const snapshot = copy(db.data.git_graph);
  await assert.rejects(run(db, 1000 + INTERVAL_MS, 'failed', async () => { throw new Error('input failure'); }), /input failure/);
  assert.equal(db.data.git_hydration_jobs.jobs.failed.status, 'failed');
  assert.deepEqual(db.data.git_graph, snapshot);
  await assert.rejects(run(db, 1000 + INTERVAL_MS * 2 - 1, 'early'), /12 hours/);
  await run(db, 1000 + INTERVAL_MS * 2, 'retry');
});

test('newer claim fences late success and late failure', async () => {
  for (const failOld of [false, true]) {
    const db = new MockDatabase();
    let release;
    let started;
    const ready = new Promise(resolve => { started = resolve; });
    const blocked = new Promise(resolve => { release = resolve; });
    const old = run(db, 1000, 'old', async () => {
      started();
      await blocked;
      if (failOld) throw new Error('old failure');
      const value = graph(); value.metadata.head = 'old'; return value;
    });
    await ready;
    await run(db, 1000 + INTERVAL_MS, 'new', async () => {
      const value = graph(); value.metadata.head = 'new'; return value;
    });
    release();
    await assert.rejects(old, failOld ? /old failure/ : /fenced/);
    assert.equal(db.data.git_graph.metadata.head, 'new');
    assert.equal(db.data.git_hydration_jobs.jobs.new.status, 'succeeded');
    assert.equal(db.data.git_hydration_jobs.jobs.old.status, 'running');
  }
});

test('clock rollback fails closed and malformed job state is not overwritten', async () => {
  const db = new MockDatabase();
  await run(db, 5000, 'a');
  await assert.rejects(run(db, 4999, 'b'), /12 hours/);
  const bad = new MockDatabase({ git_hydration_jobs: { lastAttemptAt: 'bad' } });
  await assert.rejects(run(bad, 1000, 'a'), /invalid/);
  assert.deepEqual(bad.data, { git_hydration_jobs: { lastAttemptAt: 'bad' } });
});

test('validates shape, graph links, keys and email anywhere', () => {
  const allowed = graph();
  allowed.metadata.note = 'Names may use @ mentions.';
  allowed.contributors[0].name = '@alice';
  validateGraph(allowed);
  for (const change of [
    g => { g.contributors[0].email = 'alice'; },
    g => { g.metadata.contactEmail = null; },
    g => { g.files[0].path = 'alice@example.com'; },
    g => { g.metadata.note = 'alice%40example.com'; },
    g => { g.contributors[0].id = 'contributor:bad.key'; },
    g => { g.edges[0].target = 'missing'; },
    g => { g.files = {}; },
    g => { g.metadata['bad/key'] = 1; },
  ]) {
    const value = graph(); change(value);
    assert.throws(() => validateGraph(value));
  }
});

test('checks database URLs and obvious mismatches without assuming custom instance ownership', () => {
  const config = { GCLOUD_PROJECT: 'project-one', FIREBASE_DATABASE_URL: 'https://project-one-default-rtdb.firebaseio.com' };
  assert.equal(validateConfig(config).projectId, 'project-one');
  validateConfig({ ...config, FIREBASE_DATABASE_URL: 'https://project-one-default-rtdb.europe-west1.firebasedatabase.app' });
  validateConfig({ ...config, FIREBASE_DATABASE_URL: 'https://custom-name.firebaseio.com' });
  for (const url of [
    'https://project-two-default-rtdb.firebaseio.com', 'https://evil.com',
    'http://project-one-default-rtdb.firebaseio.com', 'https://secret@project-one-default-rtdb.firebaseio.com',
    'https://project-one-default-rtdb.firebaseio.com/path', 'https://project-one-default-rtdb.firebaseio.com?token=secret',
  ]) assert.throws(() => validateConfig({ ...config, FIREBASE_DATABASE_URL: url }));
  assert.throws(() => validateConfig({ ...config, GCLOUD_PROJECT: '' }));
});

test('rejects .secret paths including symlinks and does not expose CLI errors', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-publisher-'));
  try {
    const secret = path.join(dir, '.secret.local');
    const link = path.join(dir, 'graph.json');
    await fs.writeFile(secret, JSON.stringify(graph()));
    await fs.symlink(secret, link);
    await assert.rejects(readGraph(secret), /Secret/);
    await assert.rejects(readGraph(link), /Secret/);
    const cli = spawnSync(process.execPath, [path.join(__dirname, 'publish-git-graph.js'), 'foo'], {
      env: { ...process.env, GCLOUD_PROJECT: 'project-one', FIREBASE_DATABASE_URL: 'https://secret@bad.example' },
      encoding: 'utf8',
    });
    assert.equal(cli.status, 1);
    assert(!cli.stderr.includes('secret'));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
