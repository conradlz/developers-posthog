'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { hashGraph } = require('./git-assessments');
const { createGitAvatarsHandler } = require('./git-avatars-http');
const graph = { metadata: { head: 'abc', generatedAt: '2026-01-01T00:00:00Z' } };
const id = 'contributor:' + 'a'.repeat(40);
const data = { graphHash: hashGraph(graph), contributors: {
  [id]: { dataUrl: 'data:image/png;base64,aGVsbG8=', login: 'example' },
} };
function db(values) {
  return { ref: path => ({ get: async () => ({ val: () => values[path] ?? null, exists: () => values[path] != null }) }) };
}
async function request(values, method = 'GET') {
  const res = { headers: {}, set(k, v) { this.headers[k] = v; return this; },
    status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  await createGitAvatarsHandler({ db: db(values) })({ method }, res);
  return res;
}
test('serves only image data from the matching graph', async () => {
  const res = await request({ git_graph: graph, git_avatar_images: data });
  assert.equal(res.code, 200);
  assert.equal(res.body.avatars[id], data.contributors[id].dataUrl);
  assert.equal(JSON.stringify(res.body).includes('login'), false);
  assert.equal(res.headers['Cache-Control'], 'no-store');
});
test('hides images from a different snapshot even with the same head', async () => {
  const altered = { metadata: { ...graph.metadata, generatedAt: '2027-01-01T00:00:00Z' } };
  assert.equal((await request({ git_graph: altered, git_avatar_images: data })).code, 409);
  assert.equal((await request({ git_graph: graph })).code, 404);
  assert.equal((await request({}, 'POST')).code, 405);
});
test('never returns external or malformed image references', async () => {
  const invalid = { graphHash: hashGraph(graph), contributors: { [id]: { dataUrl: 'https://example.com/avatar' } } };
  assert.deepEqual((await request({ git_graph: graph, git_avatar_images: invalid })).body.avatars, {});
  assert.deepEqual((await request({ git_graph: graph, git_avatar_images: { graphHash: hashGraph(graph) } })).body.avatars, {});
});
