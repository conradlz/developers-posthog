#!/usr/bin/env node
'use strict';

const { validateConfig } = require('./publish-git-graph');
const { generate, review, publish, addScores } = require('./git-assessments');

const help = `Usage: node functions/git-assessments-admin.js generate RUN_ID
       node functions/git-assessments-admin.js add-scores RUN_ID
       node functions/git-assessments-admin.js review RUN_ID
       node functions/git-assessments-admin.js publish RUN_ID

Set GCLOUD_PROJECT and FIREBASE_DATABASE_URL explicitly. Use ADC or
GOOGLE_APPLICATION_CREDENTIALS; generate also requires CEREBRAS_API_KEY.
For the local emulator, set FIREBASE_DATABASE_EMULATOR_HOST=127.0.0.1:PORT
and a demo- project ID. Live database access requires the explicit opt-in
GIT_ASSESSMENTS_ALLOW_LIVE=1. Never commit keys or credentials.

Generate makes one paid call per author with sampled commits (maximum 20
calls per run, one per author); a run ID is consumed even after failure.
add-scores upgrades an old draft without calling Cerebras.
Review prints the draft. Publish requires a human-reviewed draft and refuses
if the graph has changed. Publishing uses an atomic root transaction, reading
and writing the full database, preserving other children, and requires broad
Admin privileges. Large databases may exceed transaction limits. Restrict IAM.
Models may produce incorrect or unsupported claims despite citation checks.`;

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') { console.log(help); return; }
  const [command, id] = args;
  if (args.length !== 2 || !['generate', 'add-scores', 'review', 'publish'].includes(command) ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error('Invalid arguments');
  const config = validateConfig(process.env);
  const emulator = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
  if (emulator) {
    if (!/^(?:127\.0\.0\.1|localhost):\d{1,5}$/.test(emulator) || !config.projectId.startsWith('demo-')) {
      throw new Error('Use a local emulator with a demo project');
    }
  } else if (process.env.GIT_ASSESSMENTS_ALLOW_LIVE !== '1') {
    throw new Error('Live database access requires explicit opt-in');
  }
  const { initializeApp, applicationDefault, deleteApp } = require('firebase-admin/app');
  const { getDatabase } = require('firebase-admin/database');
  const app = initializeApp({ ...config, credential: applicationDefault() });
  try {
    const db = getDatabase(app);
    const result = command === 'generate'
      ? await generate({ db, id, key: process.env.CEREBRAS_API_KEY })
      : command === 'add-scores' ? await addScores(db, id)
        : command === 'review' ? await review(db, id) : await publish(db, id);
    console.log(JSON.stringify(result, null, 2));
  } finally { await deleteApp(app); }
}

if (require.main === module) {
  main().catch(() => {
    // Provider, credential, JSON and SDK errors can contain secrets.
    console.error('Assessment command failed. Check arguments, configuration, draft and access; use --help.');
    process.exitCode = 1;
  });
}
module.exports = { main, help };
