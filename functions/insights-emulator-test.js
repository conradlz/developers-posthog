'use strict';

// Requires a local Realtime Database emulator. No network calls to GitHub or Cerebras.
const assert = require('node:assert/strict');
const http = require('node:http');
const { initializeApp } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');
const { runGeneration, publish, review, createInsightsHandler } = require('./insights');

async function main() {
  if (!/^127\.0\.0\.1:\d+$|^localhost:\d+$/.test(process.env.FIREBASE_DATABASE_EMULATOR_HOST || '') ||
      !/^demo-/.test(process.env.GCLOUD_PROJECT || '')) throw new Error('Requires localhost emulator and demo project');
  initializeApp({ projectId: process.env.GCLOUD_PROJECT,
    databaseURL: `https://${process.env.GCLOUD_PROJECT}-default-rtdb.firebaseio.com` });
  const db = getDatabase();
  const now = () => new Date('2024-03-01T12:00:00.000Z');
  const run = db.ref('insight_runs/2024-03-01');
  const publicRef = db.ref('insight_public');
  await Promise.all([run.remove(), publicRef.remove()]);
  const mockFetch = async url => {
    let value;
    if (url.includes('/contributors?')) value = [{ login: 'alice', type: 'User' }];
    else if (url.includes('/search/issues?')) value = { total_count: 0, incomplete_results: false, items: [] };
    else throw new Error('Unexpected upstream request');
    return { ok: true, headers: { get: () => null }, text: async () => JSON.stringify(value) };
  };
  const handler = createInsightsHandler({ db, now: () => now().getTime() });
  const server = http.createServer((req, res) => {
    res.set = (key, value) => { res.setHeader(key, value); return res; };
    res.status = code => { res.statusCode = code; return res; };
    res.json = body => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); };
    handler(req, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/insights`;
    assert.equal((await fetch(url)).status, 404);
    const args = { db, fetch: mockFetch, githubToken: 'mock', cerebrasKey: 'mock', now };
    const outcomes = await Promise.all([runGeneration(args), runGeneration(args)]);
    assert.deepEqual(outcomes.map(v => v.status).sort(), ['already_claimed', 'draft']);
    assert.equal((await fetch(url)).status, 404);
    assert.deepEqual((await review(db, '2024-03-01')).snapshot.contributors.alice.subjective.observations, []);
    const publications = await Promise.allSettled([
      publish(db, '2024-03-01', now), publish(db, '2024-03-01', now),
    ]);
    assert.deepEqual(publications.map(value => value.status).sort(), ['fulfilled', 'rejected']);
    assert.equal((await db.ref('insight_public/published_runs/2024-03-01').get()).val(), now().toISOString());
    await assert.rejects(() => review(db, '2024-03-01'));
    const response = await fetch(url);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.contributors.alice.subjective.observations.length, 0);
    assert.equal(body.stale, false);
    assert.equal((await fetch(url, { method: 'POST' })).status, 405);
    console.log('Realtime Database emulator and HTTP tests passed');
  } finally {
    server.close();
    await Promise.all([run.remove(), publicRef.remove()]);
    await db.goOffline();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
