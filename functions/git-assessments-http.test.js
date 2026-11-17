'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createGitAssessmentsHandler } = require('./git-assessments-http');
const { hashGraph } = require('./git-assessments');

const graph = { metadata: { head: 'abc', generatedAt: '2026-01-01T00:00:00.000Z' },
  commits: [{ hash: 'abc', date: '2025-01-01T00:00:00.000Z' }] };
const perspective = { observations: [{ text: 'Changed a path', source_ids: ['commit-abc'] }],
  interpretations: [], limitations: ['Bounded sample'] };
const snapshot = { graph_hash: hashGraph(graph), graph_head: 'abc', generated_at: '2026-01-02T00:00:00.000Z',
  authors: [{ author_id: 'contributor:a', rank: 1, algorithmic: { commit_count: 5 },
    evidence: [{ id: 'commit-abc', url: 'https://github.com/PostHog/posthog/commit/abc' }],
    subjective: perspective, business: perspective, caveats: 'Git identity is unverified.' }] };
function db(values) {
  return { ref(path) { return { async get() {
    const value = values[path];
    return { exists: () => value != null, val: () => value ?? null };
  } }; } };
}
function response() {
  return { headers: {}, set(k, v) { this.headers[k] = v; return this; },
    status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
}
async function request(values, method = 'GET') {
  const res = response();
  await createGitAssessmentsHandler({ db: db(values) })({ method }, res);
  return res;
}
const values = () => ({ git_graph: graph, 'git_assessment_public/current': { snapshot_json: JSON.stringify(snapshot) } });

test('reads only reviewed snapshot and matching graph', async () => {
  const res = await request(values());
  assert.equal(res.code, 200);
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.equal(res.body.graphGeneratedAt, graph.metadata.generatedAt);
  assert.equal(res.body.assessments['contributor:a'].subjective.observations[0].sourceIds[0], 'commit-abc');
  assert.match(res.body.assessments['contributor:a'].algorithmic.text, /5 reachable non-merge commits/);
});

test('refuses mismatched graph even at the same head', async () => {
  const data = values();
  data.git_graph = { ...graph, metadata: { ...graph.metadata, generatedAt: '2026-01-03T00:00:00Z' } };
  const res = await request(data);
  assert.equal(res.code, 409);
  assert.deepEqual(res.body, { error: 'assessments_graph_mismatch' });
});

test('missing, malformed and unsupported requests fail safely', async () => {
  assert.equal((await request({})).code, 404);
  const data = values();
  data['git_assessment_public/current'].snapshot_json = '{bad';
  assert.equal((await request(data)).code, 503);
  const denied = await request(values(), 'POST');
  assert.equal(denied.code, 405);
  assert.equal(denied.headers.Allow, 'GET');
});
