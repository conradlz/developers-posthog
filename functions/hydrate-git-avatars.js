#!/usr/bin/env node
'use strict';

// Trusted local operator only. This module never writes /git_graph.
const { hashGraph } = require('./git-assessments');
const { validateConfig } = require('./publish-git-graph');

const MAX_REQUESTS = 40;
const MAX_RESPONSE_BYTES = 256_000;
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const idPattern = /^contributor:([a-f0-9]{40}|[a-f0-9]{64})$/;
const loginPattern = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})|[A-Za-z0-9][A-Za-z0-9-]{0,34}\[bot\])$/;
const sourceFor = hash => `https://github.com/PostHog/posthog/commit/${hash}`;

function safeAvatarUrl(value) {
  if (typeof value !== 'string' || value.length > 500) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'avatars.githubusercontent.com' &&
      !url.username && !url.password && !url.port && !url.hash &&
      /^\/(?:u|in)\/[0-9]+$/.test(url.pathname) &&
      (url.search === '' || /^\?v=[0-9]+$/.test(url.search)) &&
      value === url.href;
  } catch { return false; }
}

function graphIds(graph) {
  if (!object(graph) || graph.schemaVersion !== 1 || !object(graph.metadata) ||
      graph.metadata.repositoryUrl !== 'https://github.com/PostHog/posthog' ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(graph.metadata.head) ||
      Buffer.byteLength(JSON.stringify(graph)) > 4_000_000) throw new Error('Invalid graph');
  let contributors = graph.contributors;
  if (contributors === undefined || contributors === null) contributors = [];
  else if (!Array.isArray(contributors)) {
    if (!object(contributors)) throw new Error('Invalid contributors');
    const keys = Object.keys(contributors);
    if (!keys.every((key, i) => key === String(i))) throw new Error('Invalid contributors');
    contributors = keys.map(key => contributors[key]);
  }
  if (contributors.length > MAX_REQUESTS) throw new Error('Contributor request limit exceeded');
  const ids = contributors.map(entry => {
    if (!object(entry) || typeof entry.id !== 'string' || !idPattern.test(entry.id)) throw new Error('Invalid contributor ID');
    return entry.id;
  });
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate contributor ID');
  return ids;
}

// Firebase omits an empty contributors object; treat its absence as empty.
function validSnapshot(snapshot) {
  if (!object(snapshot) || !/^[a-f0-9]{64}$/.test(snapshot.graphHash) ||
      typeof snapshot.generatedAt !== 'string' ||
      !Number.isFinite(Date.parse(snapshot.generatedAt)) ||
      Object.keys(snapshot).some(key => !['graphHash', 'generatedAt', 'contributors'].includes(key))) return false;
  const contributors = snapshot.contributors ?? {};
  if (!object(contributors) || Object.keys(contributors).length > MAX_REQUESTS) return false;
  return Object.entries(contributors).every(([id, item]) => {
    const match = id.match(idPattern);
    return match && object(item) && Object.keys(item).sort().join(',') === 'avatarUrl,login,sourceUrl' &&
      typeof item.login === 'string' && loginPattern.test(item.login) &&
      safeAvatarUrl(item.avatarUrl) && item.sourceUrl === sourceFor(match[1]);
  });
}

async function readResponse(response) {
  if (Number(response.headers?.get('content-length')) > MAX_RESPONSE_BYTES) throw new Error('Response too large');
  let text;
  if (response.body?.getReader) {
    const reader = response.body.getReader(), chunks = [];
    let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error('Response too large'); }
        chunks.push(Buffer.from(value));
      }
    } finally { reader.releaseLock(); }
    text = Buffer.concat(chunks).toString('utf8');
  } else {
    text = await response.text();
    if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new Error('Response too large');
  }
  return JSON.parse(text);
}

async function resolveAnchor(id, token, fetchImpl) {
  const hash = id.match(idPattern)[1];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetchImpl(`https://api.github.com/repos/PostHog/posthog/commits/${hash}`, {
      method: 'GET', redirect: 'error', signal: controller.signal,
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'git-avatar-hydrator' },
    });
    if (!response.ok) throw new Error('GitHub request failed');
    const body = await readResponse(response);
    if (!object(body) || body.sha !== hash || !Object.hasOwn(body, 'author')) throw new Error('Invalid GitHub response');
    if (body.author === null) return null;
    if (!object(body.author) || typeof body.author.login !== 'string' ||
        !loginPattern.test(body.author.login) || !safeAvatarUrl(body.author.avatar_url)) {
      throw new Error('Invalid GitHub author');
    }
    return { avatarUrl: body.author.avatar_url, login: body.author.login, sourceUrl: sourceFor(hash) };
  } finally { clearTimeout(timeout); }
}

async function hydrate({ db, token, fetch: fetchImpl = globalThis.fetch, now = () => new Date() }) {
  if (!db || typeof db.ref !== 'function' || typeof token !== 'string' || !token.trim() ||
      /[\r\n]/.test(token) || typeof fetchImpl !== 'function') throw new Error('Invalid configuration');
  const root = db.ref();
  let listener;
  try {
    const initial = await new Promise((resolve, reject) => { listener = root.on('value', resolve, reject); });
    const state = initial.val();
    if (!object(state)) throw new Error('Invalid database root');
    const ids = graphIds(state.git_graph);
    const graphHash = hashGraph(state.git_graph);
    const previous = state.git_avatars ?? null;
    if (previous !== null && !validSnapshot(previous)) throw new Error('Invalid existing avatar snapshot');
    if (previous?.graphHash === graphHash) {
      const existing = Object.keys(previous.contributors ?? {});
      if (!existing.every(id => ids.includes(id))) throw new Error('Invalid existing avatar snapshot');
      return { status: 'unchanged', graphHash };
    }
    const contributors = {};
    for (const id of ids) {
      const result = await resolveAnchor(id, token, fetchImpl);
      if (result) contributors[id] = result;
    }
    const date = now();
    if (!(date instanceof Date) || !Number.isFinite(date.valueOf())) throw new Error('Invalid clock');
    const snapshot = { graphHash, generatedAt: date.toISOString(), contributors };
    const previousHash = hashGraph(previous);
    const result = await root.transaction(current => {
      if (!object(current) || hashGraph(current.git_graph) !== graphHash ||
          hashGraph(current.git_avatars ?? null) !== previousHash) return;
      return { ...current, git_avatars: snapshot };
    }, undefined, false);
    if (!result.committed) throw new Error('Graph or avatar snapshot changed');
    return { status: 'published', graphHash, resolved: Object.keys(contributors).length, requested: ids.length };
  } finally { if (listener) root.off('value', listener); }
}

const help = `Usage: node --env-file=PATH functions/hydrate-git-avatars.js

Set GCLOUD_PROJECT, FIREBASE_DATABASE_URL and GITHUB_TOKEN explicitly in the
environment; use ADC or GOOGLE_APPLICATION_CREDENTIALS. For a local RTDB
emulator set FIREBASE_DATABASE_EMULATOR_HOST=127.0.0.1:PORT and a demo- project.
Live database access requires GIT_AVATARS_ALLOW_LIVE=1. Never commit credentials.

At most 40 GitHub commit requests per run, no retries. More than 40 contributors
is rejected before requests. A null GitHub author is omitted; other failures
abort without writing. Existing snapshots for the same graph are not refreshed.
The /git_avatars snapshot contains graphHash, generatedAt and contributors keyed
by contributor:anchor hash, with avatarUrl, login and sourceUrl. RTDB may omit
an empty contributors object. Compare graphHash with hashGraph of the raw
/git_graph snapshot before use. Each association is based on one anchor commit;
git identities are unverified and can merge or split people. No email is stored.
The root transaction reads/writes the whole database and needs broad privileges;
it preserves other children, can conflict with writers, and may exceed limits.
Custom database hostnames cannot prove ownership by the configured project.`;

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') { console.log(help); return; }
  if (args.length !== 0) throw new Error('Invalid arguments');
  const config = validateConfig(process.env);
  if (!process.env.GITHUB_TOKEN?.trim() || /[\r\n]/.test(process.env.GITHUB_TOKEN)) throw new Error('Missing token');
  const emulator = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
  if (emulator) {
    const match = /^(?:127\.0\.0\.1|localhost):(\d{1,5})$/.exec(emulator);
    if (!match || Number(match[1]) < 1 || Number(match[1]) > 65535 || !config.projectId.startsWith('demo-')) {
      throw new Error('Invalid emulator configuration');
    }
  } else if (process.env.GIT_AVATARS_ALLOW_LIVE !== '1') throw new Error('Live access requires opt-in');
  const { initializeApp, applicationDefault, deleteApp } = require('firebase-admin/app');
  const { getDatabase } = require('firebase-admin/database');
  const app = initializeApp({ ...config, credential: applicationDefault() });
  try {
    console.log(JSON.stringify(await hydrate({ db: getDatabase(app), token: process.env.GITHUB_TOKEN })));
  } finally { await deleteApp(app); }
}

if (require.main === module) {
  main().catch(() => {
    console.error('Avatar hydration failed. Check configuration, graph, GitHub and database access; use --help.');
    process.exitCode = 1;
  });
}

module.exports = { MAX_REQUESTS, safeAvatarUrl, graphIds, validSnapshot, resolveAnchor, hydrate, main, help };
