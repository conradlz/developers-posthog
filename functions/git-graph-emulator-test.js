'use strict';

// All writes are confined to a unique demo-project namespace on a local emulator.
const assert = require('node:assert/strict');
const http = require('node:http');
const { initializeApp, deleteApp } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');
const { createGitGraphHandler } = require('./git-graph');

async function main() {
  if (!/^(127\.0\.0\.1|localhost):\d+$/.test(process.env.FIREBASE_DATABASE_EMULATOR_HOST || '')) {
    throw new Error('Requires a local Realtime Database emulator');
  }
  const projectId = `demo-git-graph-${process.pid}`;
  const app = initializeApp({ projectId, databaseURL: `https://${projectId}-default-rtdb.firebaseio.com` });
  const db = getDatabase(app);
  const graphRef = db.ref('git_graph');
  const handler = createGitGraphHandler({ db });
  const server = http.createServer((req, res) => {
    res.set = (key, value) => { res.setHeader(key, value); return res; };
    res.status = code => { res.statusCode = code; return res; };
    res.json = body => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); };
    handler(req, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/git-graph`;
    assert.equal((await fetch(url)).status, 404);
    const graph = { schemaVersion: 1, metadata: { generatedAt: '2020-02-02T00:00:00.000Z' },
      contributors: [{ id: 'contributor:a' }], commits: [], files: [], edges: [] };
    await graphRef.set(graph);
    const stored = (await graphRef.get()).val();
    assert.equal(stored.commits, undefined); // The emulator really drops empty arrays.
    const response = await fetch(url);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), graph);
    assert.equal((await fetch(url, { method: 'POST' })).status, 405);
    assert.deepEqual((await graphRef.get()).val(), stored);
    console.log('Git graph Realtime Database emulator and HTTP tests passed');
  } finally {
    await graphRef.remove();
    await deleteApp(app);
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
