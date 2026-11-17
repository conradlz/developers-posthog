#!/usr/bin/env node
'use strict';

// Trusted local operator only. Root transactions fence the three flat tables:
// /git_hydration_jobs, /git_tracked_users and /git_graph. All other root
// children are preserved. This requires root read/write access and downloads
// and transacts the entire database; see the command's --help for caveats.
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const INTERVAL_MS = 12 * 60 * 60 * 1000;
const JOBS = 'git_hydration_jobs';
const USERS = 'git_tracked_users';
const GRAPH = 'git_graph';
const EMAIL_KEY = /email/i;
const UNSAFE_KEY = /[.#$[\]/\u0000-\u001f\u007f]/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function validateConfig(env) {
  const projectId = env.GCLOUD_PROJECT;
  if (!projectId || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId)) {
    throw new Error('Set GCLOUD_PROJECT to an explicit valid project ID.');
  }
  let url;
  try { url = new URL(env.FIREBASE_DATABASE_URL); } catch {
    throw new Error('Set FIREBASE_DATABASE_URL to an explicit Firebase database URL.');
  }
  const host = url.hostname.toLowerCase();
  const match = host.match(/^([a-z0-9-]+)\.(?:firebaseio\.com|[a-z0-9-]+\.firebasedatabase\.app)$/);
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      url.pathname !== '/' || url.search || url.hash || !match) {
    throw new Error('FIREBASE_DATABASE_URL must be an HTTPS Firebase database root URL.');
  }
  const instance = match[1];
  if (instance.endsWith('-default-rtdb') && instance !== `${projectId}-default-rtdb`) {
    throw new Error('The default database hostname does not match GCLOUD_PROJECT.');
  }
  return { projectId, databaseURL: url.origin };
}

// Reject email fields and email-looking values, including URL-encoded addresses.
// Plain @ mentions and the generator's explanatory metadata are allowed.
function validateTree(value) {
  if (typeof value === 'string') {
    let decoded = value;
    try { decoded = decodeURIComponent(value); } catch { decoded = value.replace(/%40/ig, '@'); }
    if (/[^\s<>/@]+@[^\s<>/@]+\.[^\s<>/@]+/u.test(decoded)) {
      throw new Error('Input contains a potentially email-bearing string.');
    }
    return;
  }
  if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return;
  if (Array.isArray(value)) {
    value.forEach(validateTree);
    return;
  }
  if (!isObject(value)) throw new Error('Input contains a non-JSON value.');
  for (const [key, child] of Object.entries(value)) {
    if (!key || EMAIL_KEY.test(key) || UNSAFE_KEY.test(key) || FORBIDDEN_KEYS.has(key)) {
      throw new Error('Input contains an unsafe or email-bearing field name.');
    }
    validateTree(child);
  }
}

function validateGraph(graph) {
  validateTree(graph);
  if (!isObject(graph) || graph.schemaVersion !== 1 || !isObject(graph.metadata) ||
      !['contributors', 'commits', 'files', 'edges'].every(key => Array.isArray(graph[key]))) {
    throw new Error('Input must be a schemaVersion 1 git graph with metadata and four arrays.');
  }
  const nodes = new Map();
  for (const [kind, entries] of [['contributor', graph.contributors], ['commit', graph.commits], ['file', graph.files]]) {
    for (const entry of entries) {
      if (!isObject(entry) || typeof entry.id !== 'string' ||
          !entry.id.startsWith(`${kind}:`) || entry.id.length <= kind.length + 1 ||
          UNSAFE_KEY.test(entry.id) || nodes.has(entry.id)) {
        throw new Error('Input contains an invalid or duplicate node ID.');
      }
      nodes.set(entry.id, kind);
    }
  }
  for (const edge of graph.edges) {
    if (!isObject(edge) ||
        !((edge.type === 'authored' && nodes.get(edge.source) === 'contributor' && nodes.get(edge.target) === 'commit') ||
          (edge.type === 'changed' && nodes.get(edge.source) === 'commit' && nodes.get(edge.target) === 'file'))) {
      throw new Error('Input contains an invalid or dangling edge.');
    }
  }
  const users = Object.fromEntries(graph.contributors.map(contributor => [contributor.id, contributor]));
  return { graph, users };
}

function rootObject(root) {
  if (root === null) return {};
  if (!isObject(root)) throw new Error('Database root is not an object.');
  return root;
}

function jobState(root) {
  const state = root[JOBS];
  if (state === undefined || state === null) return { jobs: {} };
  if (!isObject(state) || !isObject(state.jobs) ||
      (state.lastAttemptAt !== undefined && (!Number.isSafeInteger(state.lastAttemptAt) || state.lastAttemptAt < 0)) ||
      (state.lastAttemptAt !== undefined && typeof state.activeJobId !== 'string')) {
    throw new Error('Existing hydration job state is invalid; refusing to overwrite it.');
  }
  return state;
}

async function claim(db, id, now) {
  const result = await db.ref().transaction(current => {
    const root = rootObject(current);
    const state = jobState(root);
    const timestamp = now();
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new Error('Invalid process clock.');
    if (state.lastAttemptAt !== undefined && timestamp - state.lastAttemptAt < INTERVAL_MS) return;
    return { ...root, [JOBS]: { ...state, lastAttemptAt: timestamp, activeJobId: id,
      jobs: { ...state.jobs, [id]: { startedAt: timestamp, status: 'running' } } } };
  }, undefined, false);
  return result.committed;
}

async function finish(db, id, now, payload, status) {
  const result = await db.ref().transaction(current => {
    if (current === null) return; // Never create data without a valid claim.
    const root = rootObject(current);
    const state = jobState(root);
    if (state.activeJobId !== id || !isObject(state.jobs[id]) || state.jobs[id].status !== 'running') return;
    const timestamp = now();
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new Error('Invalid process clock.');
    const updated = { ...root, [JOBS]: { ...state, jobs: { ...state.jobs,
      [id]: { ...state.jobs[id], status, finishedAt: timestamp } } } };
    if (status === 'succeeded') {
      updated[USERS] = payload.users;
      updated[GRAPH] = payload.graph;
    }
    return updated;
  }, undefined, false);
  return result.committed;
}

async function publish({ db, load, now = Date.now, id = randomUUID() }) {
  const root = db.ref();
  // Keep the server state subscribed for the whole operation. Without a live
  // listener, RTDB may initially invoke the finish transaction with null.
  let listener;
  const ready = new Promise((resolve, reject) => {
    listener = root.on('value', resolve, reject);
  });
  try {
    await ready;
    if (!await claim(db, id, now)) throw new Error('A hydration attempt started within the last 12 hours.');
    try {
      const payload = validateGraph(await load());
      if (!await finish(db, id, now, payload, 'succeeded')) {
        throw new Error('This hydration attempt was fenced by a newer attempt.');
      }
      return { id };
    } catch (error) {
      // A failed or superseded attempt never changes a newer job or the snapshot.
      try { await finish(db, id, now, null, 'failed'); } catch { /* preserve original failure */ }
      throw error;
    }
  } finally {
    if (listener) root.off('value', listener);
  }
}

async function readGraph(input) {
  const containsSecretComponent = p => path.resolve(p).split(path.sep).some(part => /^\.secret/i.test(part));
  if (containsSecretComponent(input)) throw new Error('Secret files are not accepted as input.');
  const real = await fs.realpath(input);
  if (containsSecretComponent(real)) throw new Error('Secret files are not accepted as input.');
  return JSON.parse(await fs.readFile(real, 'utf8'));
}

const HELP = `Usage: GCLOUD_PROJECT=PROJECT_ID FIREBASE_DATABASE_URL=https://INSTANCE.firebaseio.com \\
  node functions/publish-git-graph.js PATH_TO_GRAPH.json

Authenticate with trusted Application Default Credentials or GOOGLE_APPLICATION_CREDENTIALS.
Tables: /git_hydration_jobs (attempts), /git_tracked_users (contributor ID index),
and /git_graph (the schemaVersion 1 snapshot). These names are owned by this command.
Each successful publication replaces the latter two tables atomically; empty RTDB
arrays/objects may disappear. Git identities are not verified GitHub accounts.

The 12-hour rolling cooldown includes failed attempts after the claim. A newer
claim fences an older writer. Clock accuracy and synchronization across operators
are required; an unavailable database cannot record an attempt. Root transactions
read and write the entire database, preserve other root children, require broad
privileges, may conflict with other writers and may be expensive or exceed limits.
Firebase rules do not protect against Admin SDK credentials. Restrict IAM and
keep these tables private if their data must not be public. Custom database
instance names cannot be verified against the project from their hostname.
Job history grows without automatic retention. No live writes occur during tests.`;

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') { console.log(HELP); return; }
  if (args.length !== 1 || args[0].startsWith('--')) throw new Error('Provide exactly one graph JSON path; use --help for usage.');
  const config = validateConfig(process.env);
  const { initializeApp, applicationDefault, deleteApp } = require('firebase-admin/app');
  const { getDatabase } = require('firebase-admin/database');
  const app = initializeApp({ ...config, credential: applicationDefault() });
  try {
    const { id } = await publish({ db: getDatabase(app), load: () => readGraph(args[0]) });
    console.log(`Published git graph (job ${id}).`);
  } finally {
    await deleteApp(app);
  }
}

if (require.main === module) {
  // Only print known static messages, never SDK, filesystem or JSON error details.
  const safeMessages = new Set([
    'Provide exactly one graph JSON path; use --help for usage.',
    'Set GCLOUD_PROJECT to an explicit valid project ID.',
    'Set FIREBASE_DATABASE_URL to an explicit Firebase database URL.',
    'FIREBASE_DATABASE_URL must be an HTTPS Firebase database root URL.',
    'The default database hostname does not match GCLOUD_PROJECT.',
    'A hydration attempt started within the last 12 hours.',
    'This hydration attempt was fenced by a newer attempt.',
    'Input contains a potentially email-bearing string.',
    'Input contains an unsafe or email-bearing field name.',
    'Input contains a non-JSON value.',
    'Input must be a schemaVersion 1 git graph with metadata and four arrays.',
    'Input contains an invalid or duplicate node ID.',
    'Input contains an invalid or dangling edge.',
    'Secret files are not accepted as input.',
    'Existing hydration job state is invalid; refusing to overwrite it.',
    'Database root is not an object.',
    'Invalid process clock.',
  ]);
  main().catch(error => {
    const message = safeMessages.has(error.message) ? error.message : 'Check input, credentials and database access.';
    console.error(`Git graph publication failed: ${message}`);
    process.exitCode = 1;
  });
}

module.exports = { INTERVAL_MS, validateConfig, validateGraph, readGraph, publish };
