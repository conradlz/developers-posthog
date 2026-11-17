'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { buildPackets, generate, review, publish, addScores, validateOutput, requestAssessment } = require('./git-assessments');

const hash = n => n.toString(16).padStart(40, '0');
const graph = (count = 1) => {
  const contributors = [], commits = [], files = [], edges = [];
  for (let i = 1; i <= count; i++) {
    const author = `contributor:${hash(i)}`, commit = `commit:${hash(i + 100)}`, file = `file:${hash(i + 200)}`;
    contributors.push({ id: author, name: `Author ${i}`, commitCount: count - i + 1 });
    commits.push({ id: commit, hash: hash(i + 100), changedPathCount: 2 });
    files.push({ id: file, path: `src/file${i}.js` });
    edges.push({ type: 'authored', source: author, target: commit }, { type: 'changed', source: commit, target: file });
  }
  return { schemaVersion: 1, metadata: { head: hash(999), repositoryUrl: 'https://github.com/PostHog/posthog' },
    contributors, commits, files, edges };
};
const copy = x => structuredClone(x);
const empty = () => ({ observations: [], interpretations: [], limitations: ['Limited evidence.'] });
const result = () => ({ subjective: empty(), business: empty() });
const response = value => ({ ok: true, headers: { get: () => null }, text: async () => JSON.stringify(value) });
const model = onCall => async (_url, options) => {
  const request = JSON.parse(options.body);
  onCall?.(request);
  return response({ choices: [{ message: { content: JSON.stringify(result()) } }] });
};
const snap = x => ({ val: () => copy(x), exists: () => x !== null });

class Database {
  constructor(data) { this.data = copy(data); this.lock = Promise.resolve(); this.paths = []; }
  read(path) { return path.split('/').filter(Boolean).reduce((v, k) => v?.[k], this.data) ?? null; }
  write(path, v) {
    const parts = path.split('/').filter(Boolean);
    if (!parts.length) { this.data = copy(v); return; }
    let obj = this.data;
    for (const p of parts.slice(0, -1)) obj = obj[p] ||= {};
    obj[parts.at(-1)] = copy(v);
  }
  ref(path = '') {
    this.paths.push(path);
    return {
      get: async () => snap(this.read(path)),
      on: (_event, cb) => { queueMicrotask(() => cb(snap(this.read(path)))); return cb; },
      off: () => {},
      transaction: async fn => {
        let release;
        const previous = this.lock;
        this.lock = new Promise(resolve => { release = resolve; });
        await previous;
        try {
          const value = fn(copy(this.read(path)));
          if (value === undefined) return { committed: false };
          this.write(path, value);
          return { committed: true };
        } finally { release(); }
      },
    };
  }
}
const args = (db, fetch = model()) => ({ db, id: 'run-1', key: 'secret', fetch, now: () => new Date('2026-01-01T00:00:00Z') });

test('ranks twenty graph authors and bounds evidence with immutable links and caveats', () => {
  const packets = buildPackets(graph(25));
  assert.equal(packets.length, 20);
  assert.equal(packets[0].algorithmic.commit_count, 25);
  assert.equal(packets[0].rank, 1);
  assert.match(packets[0].evidence[0].url, /^https:\/\/github\.com\/PostHog\/posthog\/commit\/[0-9a-f]{40}$/);
  assert.match(packets[0].caveats, /bots/i);
  assert.equal(packets[0].evidence[0].changed_path_count, 2);
});

test('concurrent duplicates reserve before one call per author and publish only a reviewed graph', async () => {
  const db = new Database({ git_graph: graph(21), other: { untouched: true } });
  let calls = 0;
  const fetch = model(request => {
    calls++;
    assert.equal(db.read('git_assessment_runs/run-1').reserved_calls, calls);
    assert.equal(request.model, 'qwen-3.8-27b');
    assert.equal(request.response_format.type, 'json_schema');
    assert(!JSON.stringify(request).includes('secret'));
  });
  const outcomes = await Promise.all([generate(args(db, fetch)), generate(args(db, fetch))]);
  assert.deepEqual(outcomes.map(x => x.status).sort(), ['already_claimed', 'draft']);
  assert.equal(calls, 20);
  assert.equal(Object.keys(db.read('git_assessment_runs/run-1/reservations')).length, 20);
  assert.equal((await review(db, 'run-1')).authors.length, 20);
  assert.equal(db.read('git_assessment_public'), null);
  await publish(db, 'run-1');
  assert.equal(db.read('git_assessment_public/current/run_id'), 'run-1');
  assert.deepEqual(db.read('other'), { untouched: true });
  await assert.rejects(publish(db, 'run-1'));
});

test('failure and restart never duplicate paid calls; secrets are not stored', async () => {
  const db = new Database({ git_graph: graph() });
  let calls = 0;
  await assert.rejects(generate(args(db, async () => { calls++; throw new Error('secret'); })));
  assert.equal(db.read('git_assessment_runs/run-1/status'), 'failed');
  assert.equal((await generate(args(db, model(() => calls++)))).status, 'already_claimed');
  assert.equal(calls, 1);
  assert(!JSON.stringify(db.data).includes('secret'));
});

test('adds scores to a legacy draft without model calls and checks graph', async () => {
  const db = new Database({ git_graph: graph() });
  let calls = 0;
  await generate(args(db, model(() => calls++)));
  const run = db.data.git_assessment_runs['run-1'];
  const legacy = JSON.parse(run.snapshot_json);
  delete legacy.scores;
  run.snapshot_json = JSON.stringify(legacy);
  run.snapshot_hash = createHash('sha256').update(run.snapshot_json).digest('hex');
  db.data.git_graph.metadata.head = hash(42);
  await assert.rejects(addScores(db, 'run-1'));
  db.data.git_graph.metadata.head = hash(999);
  assert.equal((await addScores(db, 'run-1')).scores, 'added');
  assert.equal((await review(db, 'run-1')).scores.authors.length, 1);
  assert.equal(calls, 1);
  await assert.rejects(addScores(db, 'run-1'));
  await publish(db, 'run-1');
});

test('publication is atomic against graph changes and malformed drafts', async () => {
  const db = new Database({ git_graph: graph() });
  await generate(args(db));
  db.data.git_graph.metadata.head = hash(42);
  await assert.rejects(publish(db, 'run-1'), /refused/);
  assert.equal(db.read('git_assessment_public'), null);
  db.data.git_graph.metadata.head = hash(999);
  db.data.git_assessment_runs['run-1'].snapshot_json = '{}';
  await assert.rejects(publish(db, 'run-1'), /refused/);
});

test('rejects invalid sources, missing citations, oversized content and malformed graphs', async () => {
  const packet = buildPackets(graph())[0], output = result();
  output.subjective.observations.push({ text: 'Example', source_ids: ['commit-fake'] });
  assert.throws(() => validateOutput(output, packet), /citation/);
  output.subjective.observations[0].source_ids = [packet.evidence[0].id];
  output.subjective.observations[0].text = 'x'.repeat(501);
  assert.throws(() => validateOutput(output, packet), /citation/);
  const bad = graph(); bad.edges[0].target = 'commit:missing';
  assert.throws(() => buildPackets(bad), /edge/);
  bad.metadata.repositoryUrl = 'https://evil.example';
  assert.throws(() => buildPackets(bad), /graph/);
  await assert.rejects(requestAssessment(async () => response({ choices: [{ message: { content: 'x'.repeat(20001) } }] }), 'secret', packet));
});

test('rejects business claims without business evidence', () => {
  const packet = buildPackets(graph())[0], output = result();
  output.business.observations.push({ text: 'Business impact', source_ids: [packet.evidence[0].id] });
  assert.throws(() => validateOutput(output, packet), /business/);
});

test('CLI refuses live operation without opt-in before accessing credentials', () => {
  const command = spawnSync(process.execPath, ['git-assessments-admin.js', 'generate', 'run'], {
    cwd: __dirname, encoding: 'utf8', env: { ...process.env, GCLOUD_PROJECT: 'demo-test-project',
      FIREBASE_DATABASE_URL: 'https://demo-test-project-default-rtdb.firebaseio.com',
      FIREBASE_DATABASE_EMULATOR_HOST: '', GIT_ASSESSMENTS_ALLOW_LIVE: '', CEREBRAS_API_KEY: 'topsecret' },
  });
  assert.equal(command.status, 1);
  assert(!command.stderr.includes('topsecret'));
});

module.exports = { graph, model };
