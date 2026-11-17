'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { scoreGitGraph } = require('./git-assessment-scores');
const { hashGraph } = require('./git-assessments');
const { RUN_ID, ROOT, PRIOR, LEASE_MS, packetFor, validateOutput, generate, authorKey } =
  require('./cerebras-git-scores');

const hash = n => n.toString(16).padStart(40, '0');
const clone = x => structuredClone(x);
function graph(n = 1, path = 'products/a.js') {
  const g = { schemaVersion: 1, metadata: { head: hash(999), repositoryUrl: 'https://github.com/PostHog/posthog' },
    contributors: [], commits: [], files: [], edges: [] };
  for (let i = 1; i <= n; i++) {
    const author = `contributor:${hash(i)}`, commit = `commit:${hash(100 + i)}`, file = `file:${hash(200 + i)}`;
    g.contributors.push({ id: author, name: `Author ${i}`, commitCount: n - i + 1 });
    g.commits.push({ id: commit, hash: hash(100 + i), changedPathCount: path ? 1 : 0 });
    g.edges.push({ type: 'authored', source: author, target: commit });
    if (path) {
      g.files.push({ id: file, path });
      g.edges.push({ type: 'changed', source: commit, target: file });
    }
  }
  return g;
}
function prior(g) {
  const scores = scoreGitGraph(g), h = hashGraph(g);
  const snapshot_json = JSON.stringify({ graph_hash: h, authors: scores.authors.map(a => ({ author_id: a.author_id })) });
  return { status: 'draft', graph_hash: h, snapshot_json, snapshot_hash: createHash('sha256').update(snapshot_json).digest('hex'),
    reservations: Object.fromEntries(scores.authors.map(a => [authorKey(a.author_id), { author_id: a.author_id, calls: 1 }])) };
}
const snap = x => ({ val: () => clone(x), exists: () => x !== null });
class Database {
  constructor(data) { this.data = clone(data); this.lock = Promise.resolve(); }
  read(path) { return path.split('/').filter(Boolean).reduce((x, k) => x?.[k], this.data) ?? null; }
  write(path, v) {
    const parts = path.split('/').filter(Boolean);
    let cur = this.data;
    for (const p of parts.slice(0, -1)) cur = cur[p] ||= {};
    cur[parts.at(-1)] = clone(v);
  }
  ref(path) {
    return {
      get: async () => snap(this.read(path)),
      on: (_event, cb) => { queueMicrotask(() => cb(snap(this.read(path)))); return cb; },
      off: () => {},
      transaction: async fn => {
        let release;
        const prev = this.lock;
        this.lock = new Promise(resolve => { release = resolve; });
        await prev;
        try {
          const value = fn(clone(this.read(path)));
          if (value === undefined) return { committed: false, snapshot: snap(this.read(path)) };
          this.write(path, value);
          return { committed: true, snapshot: snap(value) };
        } finally { release(); }
      },
    };
  }
}
function dbFor(g) { return new Database({ git_graph: g, git_assessment_runs: { 'run-20261117-2149': prior(g) } }); }
const part = (score, source) => ({ score, explanation: 'Sampled graph evidence is limited.', source_ids: [source] });
function output(packet) {
  const counts = packet.raw_values_from_scoreGitGraph.counts;
  const commit = packet.commits.find(c => c.paths.length)?.id;
  return {
    author_id: packet.author_id,
    activity: part(packet.raw_values_from_scoreGitGraph.activity.value === null ? null : 75, 'graph-snapshot'),
    subjective_path_breadth: part(commit ? 33 : null, commit || 'graph-snapshot'),
    business_directory_mapping: part(commit ? counts.distinct_mapped_paths ? 60 : 0 : null, commit || 'graph-snapshot'),
  };
}
const response = o => ({ ok: true, headers: { get: () => null }, text: async () =>
  JSON.stringify({ choices: [{ message: { content: JSON.stringify(o) } }] }) });
const args = (db, fetch) => ({ db, key: 'top-secret', fetch });

test('generates 20 sequential authors with verified reservations and resumability', async () => {
  const g = graph(20), db = dbFor(g);
  let calls = 0, active = 0;
  const fetch = async (_url, options) => {
    assert.equal(active++, 0);
    const req = JSON.parse(options.body), packet = JSON.parse(req.messages[1].content);
    assert.equal(req.model, 'qwen-3.8-27b');
    assert.match(req.messages[0].content, /untrusted data/);
    assert.equal(db.read(`${ROOT}/authors/${authorKey(packet.author_id)}/reserved_calls`), 1);
    assert(!options.body.includes('top-secret'));
    calls++; active--;
    return response(output(packet));
  };
  assert.equal((await generate(args(db, fetch))).status, 'draft');
  assert.equal(calls, 20);
  assert.equal((await generate(args(db, fetch))).status, 'draft');
  assert.equal(calls, 20);
  const state = db.read(`${ROOT}/authors/${authorKey(g.contributors[0].id)}`);
  assert.equal(JSON.parse(state.packet_json).raw_values_from_scoreGitGraph.activity.value, 20);
  assert.equal(JSON.parse(state.result_json).activity.score, 75);
  assert(!JSON.stringify(db.data).includes('top-secret'));
  assert.equal(db.read('git_assessment_public'), null);
  assert.equal(db.read(`${ROOT}/meta/run_id`), RUN_ID);
});

test('concurrent workers share a reservation and never duplicate calls', async () => {
  const g = graph(), db = dbFor(g);
  let calls = 0, release;
  const waiting = new Promise(resolve => { release = resolve; });
  const fetch = async (_, options) => { calls++; await waiting; return response(output(JSON.parse(JSON.parse(options.body).messages[1].content))); };
  const first = generate(args(db, fetch));
  while (!calls) await new Promise(resolve => setImmediate(resolve));
  const second = await generate(args(db, fetch));
  assert.equal(second.status, 'incomplete');
  release();
  assert.equal((await first).status, 'draft');
  assert.equal(calls, 1);
  assert.equal(db.read(`${ROOT}/meta/status`), 'draft');
});

test('retries three times, records sanitized errors and never retries after exhaustion', async () => {
  const g = graph(), db = dbFor(g);
  let calls = 0;
  const fetch = async () => { calls++; throw Error('top-secret'); };
  assert.equal((await generate(args(db, fetch))).status, 'failed');
  assert.equal(calls, 3);
  assert.equal((await generate(args(db, fetch))).status, 'failed');
  assert.equal(calls, 3);
  const state = db.read(`${ROOT}/authors/${authorKey(g.contributors[0].id)}`);
  assert.equal(state.attempts.attempt_1.error, 'request_or_parse');
  assert(!JSON.stringify(db.data).includes('top-secret'));
});

test('crash consumes reservation, waits for lease and recovers without going over budget', async () => {
  const g = graph(), db = dbFor(g), key = authorKey(g.contributors[0].id);
  const scores = scoreGitGraph(g), packet = packetFor(scores.authors[0], scores, hashGraph(g));
  db.write(`${ROOT}/authors/${key}`, {
    author_id: g.contributors[0].id, graph_hash: hashGraph(g), packet_json: JSON.stringify(packet),
    reserved_calls: 1, status: 'running', active: { token: 'old', number: 1, expires_at: 1000 + LEASE_MS },
    attempts: { attempt_1: { token: 'old', status: 'reserved', reserved_at: 1000 } },
  });
  let calls = 0;
  const fetch = async () => { calls++; return response(output(packet)); };
  assert.equal((await generate({ ...args(db, fetch), now: () => 1000 })).status, 'incomplete');
  assert.equal(calls, 0);
  assert.equal((await generate({ ...args(db, fetch), now: () => 1001 + LEASE_MS })).status, 'draft');
  const state = db.read(`${ROOT}/authors/${key}`);
  assert.equal(state.reserved_calls, 2);
  assert.equal(state.attempts.attempt_1.error, 'interrupted_or_timeout');
  assert.equal(calls, 1);
});

test('validates citation allowlist, scores, missing paths and mapping zero', () => {
  const g = graph(1, 'docs/a.md'), scores = scoreGitGraph(g), packet = packetFor(scores.authors[0], scores, hashGraph(g));
  assert.equal(packet.raw_values_from_scoreGitGraph.business_directory_mapping.value, null);
  const good = output(packet);
  assert.equal(validateOutput(good, packet).business_directory_mapping.score, 0);
  const bad = clone(good); bad.business_directory_mapping.score = 1;
  assert.throws(() => validateOutput(bad, packet));
  bad.business_directory_mapping.score = 0; bad.activity.source_ids = ['commit:fake'];
  assert.throws(() => validateOutput(bad, packet));
  bad.activity.source_ids = ['graph-snapshot']; bad.activity.score = 101;
  assert.throws(() => validateOutput(bad, packet));
  const empty = graph(1, null), s = scoreGitGraph(empty), p = packetFor(s.authors[0], s, hashGraph(empty));
  assert.equal(validateOutput(output(p), p).subjective_path_breadth.score, null);
  const invented = output(p); invented.subjective_path_breadth.score = 20;
  assert.throws(() => validateOutput(invented, p));
});

test('rejects missing prior budget or changed graph before requests or overwrites', async () => {
  const g = graph(), db = dbFor(g);
  let calls = 0;
  const fetch = async () => { calls++; throw Error('unexpected'); };
  delete db.data.git_assessment_runs['run-20261117-2149'].reservations[authorKey(g.contributors[0].id)];
  await assert.rejects(generate(args(db, fetch)));
  assert.equal(calls, 0);
  assert.equal(db.read(ROOT), null);
  db.data.git_assessment_runs['run-20261117-2149'] = prior(g);
  const good = async (_, options) => response(output(JSON.parse(JSON.parse(options.body).messages[1].content)));
  await generate(args(db, good));
  const before = clone(db.read(ROOT));
  db.data.git_graph.metadata.head = hash(123);
  await assert.rejects(generate(args(db, fetch)));
  assert.deepEqual(db.read(ROOT), before);
  assert.equal(PRIOR, 'git_assessment_runs/run-20261117-2149');
});

test('handles RTDB omitting an empty attempts object and rejects corrupted histories', async () => {
  const g = graph(), db = dbFor(g), scores = scoreGitGraph(g), author = scores.authors[0];
  const packet = packetFor(author, scores, hashGraph(g)), path = `${ROOT}/authors/${authorKey(author.author_id)}`;
  db.write(path, { author_id: author.author_id, graph_hash: hashGraph(g), packet_json: JSON.stringify(packet), reserved_calls: 0 });
  let calls = 0;
  const fetch = async () => { calls++; return response(output(packet)); };
  assert.equal((await generate(args(db, fetch))).status, 'draft');
  assert.equal(calls, 1);
  db.data.git_cerebras_score_drafts[RUN_ID].authors[authorKey(author.author_id)].reserved_calls = 0;
  await assert.rejects(generate(args(db, fetch)));
  assert.equal(calls, 1);
});

test('retries invalid model output then succeeds without leaking error text', async () => {
  const g = graph(), db = dbFor(g);
  let calls = 0;
  const fetch = async (_, options) => {
    const packet = JSON.parse(JSON.parse(options.body).messages[1].content);
    const model = output(packet);
    if (++calls === 1) model.activity.source_ids = ['fake-top-secret'];
    return response(model);
  };
  assert.equal((await generate(args(db, fetch))).status, 'draft');
  assert.equal(calls, 2);
  const state = db.read(`${ROOT}/authors/${authorKey(g.contributors[0].id)}`);
  assert.equal(state.attempts.attempt_1.error, 'schema');
  assert(!JSON.stringify(db.data).includes('top-secret'));
});
