#!/usr/bin/env node
'use strict';

const { validateConfig } = require('./publish-git-graph');
const { review, publish } = require('./git-scores-public');

const help = `Usage:
  node functions/git-scores-admin.js review
  node functions/git-scores-admin.js publish GRAPH_HASH DRAFT_DIGEST [--accept-partial]

Review prints private graph, score packets, AI outputs and citations. Protect
its output. Inspect all results, including limitations, before publishing.
Use the graphHash and draftDigest printed by review for publication.
Partial runs require --accept-partial. No AI requests are made.
Set GCLOUD_PROJECT, FIREBASE_DATABASE_URL and ADC credentials explicitly.
For an emulator set FIREBASE_DATABASE_EMULATOR_HOST=127.0.0.1:PORT and use
a demo- project. Live access requires GIT_SCORES_ALLOW_LIVE=1.
Publish transacts the entire database root and needs broad Admin privileges;
large databases can exceed transaction limits. Restrict operator access.`;

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') { console.log(help); return; }
  const isReview = args.length === 1 && args[0] === 'review';
  const isPublish = args[0] === 'publish' && (args.length === 3 ||
    args.length === 4 && args[3] === '--accept-partial') &&
    /^[a-f0-9]{64}$/.test(args[1] || '') && /^[a-f0-9]{64}$/.test(args[2] || '');
  if (!isReview && !isPublish) throw Error('arguments');
  const config = validateConfig(process.env);
  const emulator = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
  if (emulator) {
    if (!/^(?:127\.0\.0\.1|localhost):\d{1,5}$/.test(emulator) || !config.projectId.startsWith('demo-')) throw Error('emulator');
  } else if (process.env.GIT_SCORES_ALLOW_LIVE !== '1') throw Error('opt_in');
  const { initializeApp, applicationDefault, deleteApp } = require('firebase-admin/app');
  const { getDatabase } = require('firebase-admin/database');
  const app = initializeApp({ ...config, credential: applicationDefault() });
  try {
    const db = getDatabase(app);
    const result = isReview ? await review(db) : await publish(db, {
      graphHash: args[1], draftDigest: args[2], acceptPartial: args[3] === '--accept-partial',
    });
    console.log(JSON.stringify(result, null, 2));
  } finally { await deleteApp(app); }
}

if (require.main === module) main().catch(() => {
  console.error('Scores command failed. Check arguments, configuration, draft, approval and access; use --help.');
  process.exitCode = 1;
});
module.exports = { main, help };
