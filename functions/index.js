'use strict';

const { onRequest } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret } = require('firebase-functions/params');
const { initializeApp, getApps } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');
const { createHandler } = require('./contributors');
const { createInsightsHandler, runGeneration } = require('./insights');
const { createGitGraphHandler } = require('./git-graph');
const { createGitAssessmentsHandler } = require('./git-assessments-http');
const { createGitAvatarsHandler } = require('./git-avatars-http');
const { createGitScoresHandler } = require('./git-scores-public');

const githubToken = defineSecret('GITHUB_TOKEN');
const cerebrasKey = defineSecret('CEREBRAS_API_KEY');
if (!getApps().length) {
  const databaseURL = process.env.FIREBASE_DATABASE_URL ||
    (process.env.FIREBASE_DATABASE_EMULATOR_HOST ? `https://${process.env.GCLOUD_PROJECT}-default-rtdb.firebaseio.com` : undefined);
  if (databaseURL) initializeApp({ databaseURL });
  else initializeApp();
}
const db = getDatabase();
const handler = createHandler({
  db,
  getToken: () => githubToken.value(),
  fetch: (...args) => globalThis.fetch(...args),
});

exports.contributors = onRequest({
  region: 'us-central1',
  secrets: [githubToken],
  timeoutSeconds: 240,
  maxInstances: 1,
}, handler);

exports.insights = onRequest({
  region: 'us-central1',
  timeoutSeconds: 30,
  maxInstances: 5,
}, createInsightsHandler({ db }));

exports.gitGraph = onRequest({
  region: 'us-central1',
  timeoutSeconds: 30,
  maxInstances: 5,
}, createGitGraphHandler({ db }));

exports.gitAssessments = onRequest({
  region: 'us-central1',
  timeoutSeconds: 30,
  maxInstances: 5,
}, createGitAssessmentsHandler({ db }));

exports.gitAvatars = onRequest({
  region: 'us-central1',
  timeoutSeconds: 30,
  maxInstances: 5,
}, createGitAvatarsHandler({ db }));

exports.gitScores = onRequest({
  region: 'us-central1',
  timeoutSeconds: 30,
  maxInstances: 5,
}, createGitScoresHandler({ db }));

exports.refreshInsights = onSchedule({
  region: 'us-central1',
  schedule: 'every day 03:00',
  timeZone: 'UTC',
  secrets: [githubToken, cerebrasKey],
  timeoutSeconds: 540,
  maxInstances: 1,
  retryCount: 0,
}, async () => {
  if (process.env.INSIGHTS_SCHEDULE_ENABLED !== 'true') return;
  try {
    const result = await runGeneration({ db, fetch: globalThis.fetch,
      githubToken: githubToken.value(), cerebrasKey: cerebrasKey.value() });
    console.info('Insights refresh', result);
  } catch (error) {
    console.error('Insights refresh failed', { status: error.status || null });
    throw new Error('Insights refresh failed');
  }
});
