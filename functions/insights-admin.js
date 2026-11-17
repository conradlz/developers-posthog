#!/usr/bin/env node
'use strict';

// ADC/IAM is the authorization boundary; this command is never exposed over HTTP.
const { initializeApp } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');
const { runGeneration, publish, review } = require('./insights');

async function main() {
  const [command, id, ...extra] = process.argv.slice(2);
  if (extra.length || !['generate', 'review', 'publish'].includes(command) ||
      (command === 'generate' && id) || (command !== 'generate' && !/^\d{4}-\d{2}-\d{2}$/.test(id || ''))) {
    throw new Error('Usage: node insights-admin.js generate | review YYYY-MM-DD | publish YYYY-MM-DD');
  }
  if (!process.env.GCLOUD_PROJECT && !process.env.GOOGLE_CLOUD_PROJECT) {
    throw new Error('Set GCLOUD_PROJECT explicitly');
  }
  if (!process.env.FIREBASE_DATABASE_URL) throw new Error('Set FIREBASE_DATABASE_URL explicitly');
  initializeApp({ projectId: process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT,
    databaseURL: process.env.FIREBASE_DATABASE_URL });
  const db = getDatabase();
  if (command === 'generate') {
    const result = await runGeneration({ db, fetch: globalThis.fetch,
      githubToken: process.env.GITHUB_TOKEN, cerebrasKey: process.env.CEREBRAS_API_KEY });
    console.log(JSON.stringify(result));
  } else if (command === 'review') {
    console.log(JSON.stringify(await review(db, id), null, 2));
  } else {
    await publish(db, id);
    console.log('Published approved draft ' + id);
  }
}
main().catch(error => {
  console.error('Admin command failed:', error.message);
  process.exitCode = 1;
});
