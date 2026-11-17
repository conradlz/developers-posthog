#!/usr/bin/env node
'use strict';

const { hashGraph } = require('./git-assessments');
const { validateConfig } = require('./publish-git-graph');
const { safeAvatarUrl, validSnapshot, graphIds } = require('./hydrate-git-avatars');
const MAX_BYTES = 128000;

async function fetchImage(url, fetchImpl) {
  if (!safeAvatarUrl(url)) throw new Error('Invalid image URL');
  const target = new URL(url);
  target.searchParams.set('s', '96');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetchImpl(target.href, { redirect: 'error', signal: controller.signal });
    if (!res.ok || Number(res.headers.get('content-length')) > MAX_BYTES) throw new Error('Image unavailable');
    const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(type)) throw new Error('Invalid image');
    const reader = res.body?.getReader();
    if (!reader) throw new Error('Image stream unavailable');
    const chunks = [];
    let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) { await reader.cancel(); throw new Error('Image too large'); }
        chunks.push(Buffer.from(value));
      }
    } finally { reader.releaseLock(); }
    const bytes = Buffer.concat(chunks);
    const valid = type === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
      : type === 'image/jpeg' ? bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))
        : type === 'image/gif' ? ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))
          : bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
    if (!valid) throw new Error('Image signature invalid');
    return `data:${type};base64,${bytes.toString('base64')}`;
  } finally { clearTimeout(timer); }
}

async function materialize({ db, fetch: fetchImpl = globalThis.fetch, now = () => new Date() }) {
  const root = db.ref();
  let listener;
  try {
    const initial = await new Promise((resolve, reject) => { listener = root.on('value', resolve, reject); });
    const state = initial.val();
    if (!state || !validSnapshot(state.git_avatars)) throw new Error('Missing avatar associations');
    const graphHash = hashGraph(state.git_graph);
    if (state.git_avatars.graphHash !== graphHash) throw new Error('Graph changed');
    const ids = new Set(graphIds(state.git_graph));
    const associationsHash = hashGraph(state.git_avatars);
    const previousHash = hashGraph(state.git_avatar_images ?? null);
    const contributors = {};
    for (const [id, item] of Object.entries(state.git_avatars.contributors || {})) {
      if (!ids.has(id)) throw new Error('Invalid author');
      try { contributors[id] = { dataUrl: await fetchImage(item.avatarUrl, fetchImpl) }; } catch { /* Keep initials for missing images. */ }
    }
    const images = { graphHash, generatedAt: now().toISOString(), contributors };
    const result = await root.transaction(current => {
      if (!current || hashGraph(current.git_graph) !== graphHash ||
          hashGraph(current.git_avatars) !== associationsHash ||
          hashGraph(current.git_avatar_images ?? null) !== previousHash) return;
      return { ...current, git_avatar_images: images };
    }, undefined, false);
    if (!result.committed) throw new Error('Graph or images changed');
    return { status: 'published', resolved: Object.keys(contributors).length, attempted: Object.keys(state.git_avatars.contributors || {}).length };
  } finally { if (listener) root.off('value', listener); }
}

async function main() {
  const config = validateConfig(process.env);
  if (process.env.FIREBASE_DATABASE_EMULATOR_HOST || process.env.GIT_AVATARS_ALLOW_LIVE !== '1') throw new Error('Live opt-in required');
  const { initializeApp, applicationDefault, deleteApp } = require('firebase-admin/app');
  const { getDatabase } = require('firebase-admin/database');
  const app = initializeApp({ ...config, credential: applicationDefault() });
  try { console.log(JSON.stringify(await materialize({ db: getDatabase(app) }))); }
  finally { await deleteApp(app); }
}
if (require.main === module) main().catch(() => { console.error('Avatar image storage failed; check database and network access.'); process.exitCode = 1; });
module.exports = { fetchImage, materialize };
