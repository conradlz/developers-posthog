'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createGitGraphHandler } = require('./git-graph');

function response() {
  return { headers: {}, set(key, value) { this.headers[key] = value; return this; },
    status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
}
function database(value, failure) {
  const paths = [];
  return { paths, ref(path) {
    paths.push(path);
    return { async get() {
      if (failure) throw new Error('private database credentials');
      return { exists: () => value !== null, val: () => structuredClone(value) };
    } };
  } };
}
async function request(db, method = 'GET') {
  const res = response();
  await createGitGraphHandler({ db })({ method }, res);
  return res;
}

test('returns the stored graph and preserves timestamps and extra fields', async () => {
  const graph = { schemaVersion: 1, metadata: { generatedAt: '2020-02-02T00:00:00.000Z' },
    contributors: [{ id: 'contributor:a' }], commits: [{ id: 'commit:a', date: '2019-01-01T00:00:00Z' }],
    files: [{ id: 'file:a' }], edges: [{ source: 'contributor:a', target: 'commit:a', type: 'authored' }],
    publishedAt: 1700000000000 };
  const db = database(graph);
  const result = await request(db);
  assert.equal(result.code, 200);
  assert.equal(result.headers['Cache-Control'], 'no-store');
  assert.deepEqual(result.body, graph);
  assert.deepEqual(db.paths, ['git_graph']);
});

test('restores omitted empty collections and empty metadata without changing other values', async () => {
  const db = database({ schemaVersion: 1, commits: [{ id: 'commit:a' }], extra: 0 });
  const result = await request(db);
  assert.deepEqual(result.body, { schemaVersion: 1, metadata: {}, contributors: [],
    commits: [{ id: 'commit:a' }], files: [], edges: [], extra: 0 });
  assert.deepEqual((await request(database({ schemaVersion: 1, metadata: {} }))).body,
    { schemaVersion: 1, metadata: {}, contributors: [], commits: [], files: [], edges: [] });
});

test('normalizes dense numeric-key objects and fails closed on malformed collections', async () => {
  const result = await request(database({ schemaVersion: 1, metadata: { head: 'a' },
    commits: { 0: { id: 'commit:a' }, 1: { id: 'commit:b' } } }));
  assert.deepEqual(result.body.commits, [{ id: 'commit:a' }, { id: 'commit:b' }]);
  for (const value of [
    { schemaVersion: 2 }, { schemaVersion: 1, metadata: 'bad' },
    { schemaVersion: 1, commits: { 1: { id: 'commit:b' } } },
    { schemaVersion: 1, commits: { invalid: 'secret' } }, { schemaVersion: 1, commits: null },
  ]) {
    const res = await request(database(value));
    assert.equal(res.code, 503);
    assert.deepEqual(res.body, { error: 'git_graph_unavailable' });
  }
});

test('missing data, storage errors, and other methods return safe errors', async () => {
  const missing = await request(database(null));
  assert.equal(missing.code, 404);
  assert.deepEqual(missing.body, { error: 'git_graph_not_found' });
  const unavailable = await request(database(null, true));
  assert.equal(unavailable.code, 503);
  assert.deepEqual(unavailable.body, { error: 'git_graph_unavailable' });
  for (const method of ['POST', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']) {
    const db = database(null);
    const res = await request(db, method);
    assert.equal(res.code, 405);
    assert.equal(res.headers.Allow, 'GET');
    assert.equal(res.headers['Cache-Control'], 'no-store');
    assert.deepEqual(res.body, { error: 'method_not_allowed' });
    assert.deepEqual(db.paths, []);
  }
});
