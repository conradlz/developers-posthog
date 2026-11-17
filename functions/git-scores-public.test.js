'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { scoreGitGraph } = require('./git-assessment-scores');
const { hashGraph } = require('./git-assessments');
const { RUN_ID, PRIOR, packetFor, authorKey } = require('./cerebras-git-scores');
const { review, publish, createGitScoresHandler } = require('./git-scores-public');

const clone = value => structuredClone(value);
const hash = n => n.toString(16).padStart(40, '0');
const snapshot = value => ({ val: () => clone(value), exists: () => value != null });
class Database {
  constructor(data) { this.data = clone(data); this.reads = []; this.beforeTransaction = null; }
  read(path) { return path.split('/').filter(Boolean).reduce((v, k) => v?.[k], this.data) ?? null; }
  ref(path = '') {
    return {
      get: async () => { this.reads.push(path); return snapshot(this.read(path)); },
      on: (_, cb) => { queueMicrotask(() => cb(snapshot(this.read(path)))); return cb; },
      off: () => {},
      transaction: async fn => {
        assert.equal(path, '');
        if (this.beforeTransaction) this.beforeTransaction(this.data);
        const value = fn(clone(this.data));
        if (value === undefined) return { committed: false, snapshot: snapshot(this.data) };
        this.data = clone(value);
        return { committed: true, snapshot: snapshot(value) };
      },
    };
  }
}
function fixture(counts = [10, 6, 2], failed = [2], path = 'products/example.js') {
  const graph = { schemaVersion: 1, metadata: { head: hash(1000),
    repositoryUrl: 'https://github.com/PostHog/posthog', generatedAt: '2026-01-01' },
  contributors: [], commits: [], files: [], edges: [] };
  counts.forEach((count, i) => {
    const author = `contributor:${hash(i + 1)}`, commit = `commit:${hash(i + 100)}`, file = `file:${hash(i + 200)}`;
    graph.contributors.push({ id: author, name: `Author ${i}`, ...(count === null ? {} : { commitCount: count }) });
    graph.commits.push({ id: commit, hash: hash(i + 100), changedPathCount: path ? 1 : 0 });
    graph.edges.push({ type: 'authored', source: author, target: commit });
    if (path) {
      graph.files.push({ id: file, path });
      graph.edges.push({ type: 'changed', source: commit, target: file });
    }
  });
  const scores = scoreGitGraph(graph), graphHash = hashGraph(graph), authors = {};
  const part = (score, source) => ({ score, explanation: 'Private explanation', source_ids: [source] });
  scores.authors.forEach((author, i) => {
    const packet = packetFor(author, scores, graphHash);
    const miss = failed.includes(i), source = packet.commits[0]?.paths.length ? packet.commits[0].id : 'graph-snapshot';
    const count = miss ? 3 : 1;
    const result = { author_id: author.author_id, activity: part(author.algorithmic.value === null ? null : 99, 'graph-snapshot'),
      subjective_path_breadth: part(path ? (i === 0 ? 0 : 100) : null, source),
      business_directory_mapping: part(path ? (path.startsWith('products/') ? 80 : 0) : null, source) };
    const state = { author_id: author.author_id, graph_hash: graphHash, packet_json: JSON.stringify(packet),
      reserved_calls: count, status: miss ? 'failed' : 'complete', attempts: {} };
    for (let j = 1; j <= count; j++) state.attempts[`attempt_${j}`] = { token: `token-${j}`, status: miss ? 'failed' : 'succeeded' };
    if (!miss) state.result_json = JSON.stringify(result);
    authors[authorKey(author.author_id)] = state;
  });
  const meta = { run_id: RUN_ID, graph_hash: graphHash, graph_head: graph.metadata.head, prior_run: PRIOR,
    model: 'qwen-3.8-27b', status: 'running', methodology_json: JSON.stringify(scores.methodology),
    scoring_methodology: scores.methodology_version };
  return new Database({ git_graph: graph, git_cerebras_score_drafts: { [RUN_ID]: { meta, authors } },
    unrelated: { keep: 'value' }, git_assessment_public: { current: { untouched: true } } });
}
const options = r => ({ graphHash: r.graphHash, draftDigest: r.draftDigest, acceptPartial: true,
  now: () => new Date('2026-01-02T00:00:00Z') });
async function request(db, method = 'GET') {
  const res = { headers: {}, set(k, v) { this.headers[k] = v; return this; },
    status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  await createGitScoresHandler({ db })({ method }, res);
  return res;
}

test('reviews private evidence and publishes only allowlisted scores atomically', async () => {
  const db = fixture(), before = clone(db.data), result = await review(db);
  assert.equal(result.completedCount, 2);
  assert.equal(result.missingCount, 1);
  assert.equal(result.authors[0].result.subjective_path_breadth.explanation, 'Private explanation');
  assert.deepEqual(result.scores.map(s => [s.activity, s.subjective, s.business]),
    [[100, 75, 95], [50, 62.5, 57.5], [0, null, null]]);
  await assert.rejects(publish(db, { ...options(result), acceptPartial: false }));
  assert.deepEqual(db.data, before);
  await publish(db, options(result));
  assert.deepEqual(db.data.git_cerebras_score_drafts, before.git_cerebras_score_drafts);
  assert.deepEqual(db.data.git_assessment_public, before.git_assessment_public);
  assert.deepEqual(db.data.unrelated, before.unrelated);
  db.reads = [];
  const res = await request(db);
  assert.equal(res.code, 200);
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.deepEqual(res.body.scores, result.scores);
  assert.equal(res.body.completedCount, 2);
  assert.equal(res.body.missingCount, 1);
  assert.deepEqual(db.reads.sort(), ['git_graph', 'git_score_public/current']);
  assert(!JSON.stringify(res.body).includes('Private explanation'));
  assert(!JSON.stringify(db.data.git_score_public).includes('source_ids'));
});

test('supports 17 validated outputs and three failed authors in the 20-author cohort', async () => {
  const db = fixture(Array.from({ length: 21 }, (_, i) => 21 - i), [3, 8, 18]);
  db.data.git_cerebras_score_drafts[RUN_ID].meta.status = 'failed';
  const before = clone(db.data);
  const result = await review(db);
  assert.equal(result.scores.length, 20);
  assert.equal(result.completedCount, 17);
  assert.equal(result.missingCount, 3);
  for (const i of [3, 8, 18]) {
    assert.equal(result.scores[i].subjective, null);
    assert.equal(result.scores[i].business, null);
    assert.notEqual(result.scores[i].activity, null);
  }
  await assert.rejects(publish(db, { ...options(result), acceptPartial: false }));
  assert.deepEqual(db.data, before);
  await publish(db, options(result));
  assert.equal((await request(db)).body.scores.length, 20);
});

test('failed run metadata does not permit nonterminal or unexhausted authors', async () => {
  for (const mutate of [
    s => { s.status = 'running'; },
    s => { s.status = 'retry'; },
    s => { s.reserved_calls = 2; delete s.attempts.attempt_3; },
    s => { s.active = { number: 3, token: 'token-3' }; },
  ]) {
    const db = fixture();
    const draft = db.data.git_cerebras_score_drafts[RUN_ID];
    draft.meta.status = 'failed';
    const reviewed = await review(db);
    const failed = Object.values(draft.authors).find(s => s.status === 'failed');
    mutate(failed);
    await assert.rejects(review(db));
    await assert.rejects(publish(db, options(reviewed)));
    assert.equal(db.data.git_score_public, undefined);
  }
});

test('ties, missing counts and missing AI components remain distinct', async () => {
  let db = fixture([4, 4, null], [1], null);
  let result = await review(db);
  assert.deepEqual(result.scores.map(s => [s.activity, s.subjective, s.business]),
    [[100, null, null], [100, null, null], [null, null, null]]);
  db = fixture([0, 0], []);
  result = await review(db);
  assert.deepEqual(result.scores.map(s => s.activity), [100, 100]);
  db = fixture([null, null], []);
  result = await review(db);
  assert.deepEqual(result.scores.map(s => s.activity), [null, null]);
  await publish(db, { ...options(result), acceptPartial: false });
});

test('weighted AI can change order and uses displayed rounded index', async () => {
  const db = fixture([4, 3, 2, 1], []);
  const draft = db.data.git_cerebras_score_drafts[RUN_ID];
  const first = draft.authors[authorKey(db.data.git_graph.contributors[0].id)];
  const second = draft.authors[authorKey(db.data.git_graph.contributors[1].id)];
  const a = JSON.parse(first.result_json), b = JSON.parse(second.result_json);
  a.subjective_path_breadth.score = 0; b.subjective_path_breadth.score = 100;
  first.result_json = JSON.stringify(a); second.result_json = JSON.stringify(b);
  const result = await review(db);
  assert.equal(result.scores[1].activity, 66.67);
  assert.equal(result.scores[1].subjective, 75);
  assert.equal(result.scores[0].subjective, 75); // Rounded tie, rank unchanged.
  b.subjective_path_breadth.score = 99; a.subjective_path_breadth.score = 0;
  second.result_json = JSON.stringify(b);
  assert.equal((await review(db)).scores[1].subjective, 74.75);
  const close = fixture([100, 99, 1], []);
  const closeScores = (await review(close)).scores;
  assert(closeScores[1].subjective > closeScores[0].subjective);
  assert.equal(closeScores[1].rank, 2);
});

test('rejects changed draft or graph inside transaction and preserves public data', async () => {
  for (const field of ['graph', 'draft']) {
    const db = fixture(), reviewed = await review(db);
    db.beforeTransaction = data => {
      if (field === 'graph') data.git_graph.metadata.generatedAt = 'changed';
      else data.git_cerebras_score_drafts[RUN_ID].meta.limitations = 'changed';
    };
    await assert.rejects(publish(db, options(reviewed)));
    assert.equal(db.data.git_score_public, undefined);
  }
});

test('transaction retry rechecks the reviewed private run', async () => {
  const db = fixture(), reviewed = await review(db);
  const originalRef = db.ref.bind(db);
  db.ref = path => {
    const ref = originalRef(path);
    if (!path) ref.transaction = async fn => {
      assert(fn(clone(db.data)));
      db.data.git_cerebras_score_drafts[RUN_ID].meta.limitations = 'changed during retry';
      return { committed: fn(clone(db.data)) !== undefined };
    };
    return ref;
  };
  await assert.rejects(publish(db, options(reviewed)));
  assert.equal(db.data.git_score_public, undefined);
});

test('validates every packet, result, citation and terminal status', async () => {
  for (const mutate of [
    (s) => { s.packet_json = '{}'; },
    (s) => { const r = JSON.parse(s.result_json); r.business_directory_mapping.source_ids = ['invalid']; s.result_json = JSON.stringify(r); },
    (s) => { const r = JSON.parse(s.result_json); r.subjective_path_breadth.score = 101; s.result_json = JSON.stringify(r); },
    (s) => { s.status = 'running'; },
    (s) => { s.active = { token: 'x' }; },
    (s) => { s.attempts.attempt_1.status = 'failed'; },
  ]) {
    const db = fixture(), draft = db.data.git_cerebras_score_drafts[RUN_ID];
    mutate(draft.authors[Object.keys(draft.authors)[0]]);
    await assert.rejects(review(db));
  }
  const db = fixture(), draft = db.data.git_cerebras_score_drafts[RUN_ID];
  draft.authors.extra = {};
  await assert.rejects(review(db));
});

test('handler rejects missing, unapproved, stale and malformed public snapshots safely', async () => {
  const db = fixture();
  assert.equal((await request(db)).code, 404);
  const denied = await request(db, 'POST');
  assert.equal(denied.code, 405);
  assert.equal(denied.headers.Allow, 'GET');
  const r = await review(db);
  await publish(db, options(r));
  db.data.git_graph.metadata.generatedAt = 'changed';
  assert.equal((await request(db)).code, 409);
  db.data.git_graph.metadata.generatedAt = '2026-01-01';
  db.data.git_score_public.current.approved = false;
  assert.equal((await request(db)).code, 503);
  db.data.git_score_public.current.approved = true;
  db.data.git_score_public.current.snapshot_json = '{secret';
  const res = await request(db);
  assert.equal(res.code, 503);
  assert(!JSON.stringify(res.body).includes('secret'));
});

test('CLI help requires no credentials and makes no requests', () => {
  const help = execFileSync(process.execPath, ['git-scores-admin.js', '--help'], { cwd: __dirname, encoding: 'utf8' });
  assert.match(help, /--accept-partial/);
  assert.match(help, /draftDigest/);
});
