'use strict';
// A unique demo database namespace on the local emulator; no external services.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { initializeApp, deleteApp } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');
const { generate, review, publish } = require('./git-assessments');

async function main() {
  if (!/^(?:127\.0\.0\.1|localhost):\d{1,5}$/.test(process.env.FIREBASE_DATABASE_EMULATOR_HOST || '')) {
    throw new Error('Requires a local database emulator');
  }
  const projectId = `demo-assess-${randomUUID()}`;
  const app = initializeApp({ projectId, databaseURL: `https://${projectId}-default-rtdb.firebaseio.com` });
  const db = getDatabase(app);
  const hash = 'a'.repeat(40), head = 'b'.repeat(40);
  const graph = { schemaVersion: 1, metadata: { repositoryUrl: 'https://github.com/PostHog/posthog', head },
    contributors: [{ id: `contributor:${hash}`, name: 'Alice', commitCount: 1 }],
    commits: [{ id: `commit:${hash}`, hash, changedPathCount: 1 }],
    files: [{ id: 'file:1', path: 'src/file.js' }],
    edges: [{ type: 'authored', source: `contributor:${hash}`, target: `commit:${hash}` },
      { type: 'changed', source: `commit:${hash}`, target: 'file:1' }] };
  const perspective = { observations: [], interpretations: [], limitations: ['Sample is limited.'] };
  let calls = 0;
  const fetch = async () => {
    calls++;
    assert.equal((await db.ref('git_assessment_runs/run/reserved_calls').get()).val(), 1);
    return { ok: true, headers: { get: () => null }, text: async () => JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ subjective: perspective, business: perspective }) } }],
    }) };
  };
  try {
    await db.ref('git_graph').set(graph);
    await db.ref('unrelated').set({ preserve: true });
    const params = { db, id: 'run', key: 'mock', fetch };
    const outcomes = await Promise.all([generate(params), generate(params)]);
    assert.deepEqual(outcomes.map(v => v.status).sort(), ['already_claimed', 'draft']);
    assert.equal(calls, 1);
    assert.equal((await review(db, 'run')).authors.length, 1);
    await db.ref('git_graph/metadata/head').set('c'.repeat(40));
    await assert.rejects(publish(db, 'run'));
    await db.ref('git_graph/metadata/head').set(head);
    const results = await Promise.allSettled([publish(db, 'run'), publish(db, 'run')]);
    assert.deepEqual(results.map(x => x.status).sort(), ['fulfilled', 'rejected']);
    assert.deepEqual((await db.ref('unrelated').get()).val(), { preserve: true });
    assert.equal((await db.ref('git_assessment_public/current/run_id').get()).val(), 'run');
    console.log('Git assessments emulator concurrency and publication tests passed');
  } finally {
    await deleteApp(app);
  }
}
main().catch(() => { console.error('Emulator test failed'); process.exitCode = 1; });
