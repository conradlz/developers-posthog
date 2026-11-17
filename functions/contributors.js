'use strict';

const REPOSITORY = 'posthog/posthog';
const CANDIDATE_LIMIT = 8;
const REFRESH_MS = 12 * 60 * 60 * 1000;
const DATA_PATH = 'contributor_data';
const REQUEST_LIMIT = 60;
const WINDOW_MS = 60 * 1000;
const { randomUUID } = require('crypto');

function formatDay(date) {
  return date.toISOString().slice(0, 10);
}

function activityWindow(now) {
  // The previous 90 complete UTC days, including yesterday.
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return {
    start: formatDay(new Date(today - 90 * 86400000)),
    end: formatDay(new Date(today - 86400000)),
  };
}

function githubClient(token, fetchImpl) {
  return async function get(path) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetchImpl('https://api.github.com' + path, {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: 'Bearer ' + token,
          'User-Agent': 'posthog-contributor-dashboard',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        const error = new Error('GitHub request failed');
        error.status = response.status;
        throw error;
      }
      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  };
}

function searchPath(kind, query) {
  return '/search/' + kind + '?per_page=1&q=' + encodeURIComponent(query);
}

function countResult(result) {
  if (!result || !Number.isSafeInteger(result.total_count) || result.total_count < 0 ||
      typeof result.incomplete_results !== 'boolean') {
    throw new Error('Unexpected GitHub search response');
  }
  return { count: result.total_count, incomplete: result.incomplete_results };
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function collectContributors(get, now) {
  const window = activityWindow(now);
  const candidates = await get('/repos/' + REPOSITORY + '/contributors?per_page=100');
  if (!Array.isArray(candidates)) throw new Error('Unexpected GitHub contributors response');
  const humans = candidates.filter((candidate) => candidate && candidate.type === 'User' &&
    typeof candidate.login === 'string' && /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(candidate.login));
  const contributors = await mapLimit(humans.slice(0, CANDIDATE_LIMIT), 2, async (candidate) => {
    if (!Number.isSafeInteger(candidate.contributions) || candidate.contributions < 0) {
      throw new Error('Unexpected GitHub contributor');
    }
    const login = candidate.login;
    const dateRange = window.start + '..' + window.end;
    const commits = await get(searchPath('commits',
      'repo:' + REPOSITORY + ' author:' + login + ' author-date:' + dateRange));
    const merged = await get(searchPath('issues',
      'repo:' + REPOSITORY + ' is:pr is:merged author:' + login + ' merged:' + dateRange));
    // This measures all-time distinct issues commented on, not comment dates.
    const issues = await get(searchPath('issues',
      'repo:' + REPOSITORY + ' is:issue commenter:' + login));
    return {
      login,
      profile_url: 'https://github.com/' + encodeURIComponent(login),
      avatar_url: typeof candidate.avatar_url === 'string' ? candidate.avatar_url : null,
      all_time_default_branch_commits: candidate.contributions,
      commits: countResult(commits),
      merged_pull_requests: countResult(merged),
      issues_commented_on: countResult(issues),
    };
  });
  return {
    repository: REPOSITORY,
    generated_at: now.toISOString(),
    activity_window: { start_date: window.start, end_date: window.end, timezone: 'UTC', days: 90 },
    candidate_limit: CANDIDATE_LIMIT,
    contributors,
  };
}

// All contributor state shares one transaction boundary. Users are keyed flat
// by GitHub login; snapshot.order preserves the API's original ordering.
function snapshotData(state) {
  if (!state || !state.snapshot) return null;
  const { order, ...metadata } = state.snapshot;
  const users = state.users || {};
  const logins = Object.values(order || {});
  if (logins.some((login) => !users[login])) throw new Error('Incomplete contributor snapshot');
  // RTDB removes null-valued properties when storing JSON.
  return Object.assign({}, metadata, { contributors: logins.map((login) =>
    Object.assign({ avatar_url: null }, users[login])) });
}

function isDue(state, time) {
  const generated = state && state.snapshot && Date.parse(state.snapshot.generated_at);
  return !Number.isFinite(generated) || time - generated >= REFRESH_MS;
}

function createHandler(options) {
  const now = options.now || Date.now;
  const ref = options.db.ref(DATA_PATH);
  let requests = [];

  function respond(res, state, time) {
    const data = snapshotData(state);
    const job = state && state.job;
    const next = job && Number.isFinite(job.started_at) ? job.started_at + REFRESH_MS : null;
    res.set('Cache-Control', 'no-store');
    if (!data) {
      if (next && next > time) res.set('Retry-After', String(Math.max(1, Math.ceil((next - time) / 1000))));
      return res.status(503).json({ error: 'contributors_unavailable',
        ...(next ? { next_refresh_at: new Date(next).toISOString() } : {}) });
    }
    return res.status(200).json(Object.assign({}, data, {
      stale: isDue(state, time) || !!(job && job.status === 'failed'),
      ...(next ? { next_refresh_at: new Date(Math.max(next, Date.parse(data.generated_at) + REFRESH_MS)).toISOString() } : {}),
    }));
  }

  return async function handler(req, res) {
    if (req.method !== 'GET') {
      res.set('Allow', 'GET');
      res.set('Cache-Control', 'no-store');
      return res.status(405).json({ error: 'method_not_allowed' });
    }
    const time = now();
    requests = requests.filter((t) => time - t < WINDOW_MS);
    if (requests.length >= REQUEST_LIMIT) {
      res.set('Cache-Control', 'no-store');
      res.set('Retry-After', String(Math.max(1, Math.ceil((WINDOW_MS - (time - requests[0])) / 1000))));
      return res.status(429).json({ error: 'rate_limited' });
    }
    requests.push(time);

    let state;
    try {
      state = (await ref.get()).val();
      if (!isDue(state, now())) return respond(res, state, now());

      const id = randomUUID();
      // Date.now is the trusted function server's clock, never a request value.
      // A retry of the transaction reevaluates both freshness and the interval.
      const claim = await ref.transaction((current) => {
        const claimTime = now();
        if (!isDue(current, claimTime) ||
            (current && current.job && Number.isFinite(current.job.started_at) &&
             claimTime - current.job.started_at < REFRESH_MS)) return;
        return Object.assign({}, current, {
          job: { id, started_at: claimTime, status: 'running' },
        });
      }, undefined, false);
      state = claim.snapshot.val();
      if (!claim.committed) return respond(res, state, now());

      try {
        const token = await options.getToken();
        if (!token) throw new Error('GitHub token is not configured');
        const data = await collectContributors(githubClient(token, options.fetch), new Date(now()));
        const { contributors, ...metadata } = data;
        const users = {};
        const order = {};
        contributors.forEach((user, index) => {
          users[user.login] = user;
          order[index] = user.login;
        });
        // Fence old workers, and publish the complete snapshot and user table in
        // one transaction. A failed or superseded worker cannot erase data.
        const publication = await ref.transaction((current) => {
          if (!current || !current.job || current.job.id !== id || current.job.status !== 'running') return;
          return Object.assign({}, current, {
            users, snapshot: Object.assign({}, metadata, { order }),
            job: Object.assign({}, current.job, { status: 'succeeded', finished_at: now() }),
          });
        }, undefined, false);
        state = publication.snapshot.val();
      } catch (error) {
        // Do not persist or log credentials, response bodies, or error messages.
        console.error('Contributor refresh failed', { status: error.status || null });
        const failure = await ref.transaction((current) => {
          if (!current || !current.job || current.job.id !== id || current.job.status !== 'running') return;
          return Object.assign({}, current, {
            job: Object.assign({}, current.job, { status: 'failed', finished_at: now() }),
          });
        }, undefined, false);
        state = failure.snapshot.val();
      }
      return respond(res, state, now());
    } catch (error) {
      console.error('Contributor storage failed');
      // A previously read snapshot is safe to serve if the database becomes unavailable.
      try {
        if (snapshotData(state)) return respond(res, state, now());
      } catch (_) { /* Treat an incomplete snapshot as unavailable. */ }
      res.set('Cache-Control', 'no-store');
      return res.status(503).json({ error: 'contributors_unavailable' });
    }
  };
}

module.exports = { activityWindow, collectContributors, createHandler, githubClient };
