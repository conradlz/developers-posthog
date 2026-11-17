# Contributor insights backend

The existing `/api/contributors` endpoint remains independent. `GET /api/insights`
returns the last human-approved snapshot or `404 {"error":"insights_not_found"}`.
Other methods return 405. Realtime Database failures return 503; reads never start jobs.
Successful responses have exactly `generated_at`, `window` (`start_date`,
`end_date`), `contributors`, and `stale`. Each contributor has `subjective` and
`business` (`observations`, `interpretations`, `limitations`), `sources` and
`sample_summary`. Claims contain `text` and `source_ids`. Stale means the snapshot
is more than 48 hours old. Responses are publicly cached for up to 60 seconds.

## Evidence and safeguards

The cohort is the first eight valid GitHub `User` entries from the first page
of the repository contributors endpoint, ordered by GitHub historical
default-branch commits. This biases selection, excludes many contributors, and
is not a performance measure. The window is the previous 90 complete UTC days.
For each person, search merged authored PRs in that window, request the first
20 ordered by GitHub's updated time, deduplicate, sort that sample by merge
time and PR number, and take at most five. Fetch at most the first 30 changed
paths for each. Include bounded titles, excerpts, paths and authorship caveats.
Search totals, incompleteness, and possible file truncation are saved with the
draft; the public summary describes sampling. The pipeline does not sample
reviews, comments, commits or a complete career. Insufficient PR evidence
produces an abstention without a model call.

Two versioned public documentation links are included as business context:
pricing and self-hosting, catalogued 2026-11-17. These are link references, not
archived snapshots or verified current page contents; they must be reviewed and
refreshed before publication. No automatic product-path mapping is implemented.
The model is given bounded untrusted excerpts and no tools or credentials.
Prompting prohibits instructions embedded in evidence and unsupported personal
or business claims. JSON schema and local validation restrict shape, lengths,
IDs, and allowlisted HTTPS URLs. Business interpretations require at least one
PR and one business source. Citation existence **does not prove support**:
review every claim and attribution against the sources.

Unsupported or malformed individual claims are withheld and noted in the
limitations. If no subjective observations survive, the server lists up to
three sampled PR titles as a clearly labeled deterministic fallback; this is
not a quality assessment. The model may still abstain on business context.

The run record includes prompt/model/schema versions, evidence, input hashes,
the result, and status. Keep Realtime Database records private: the provided rules
deny client reads/writes; backend/admin SDK access bypasses rules and must be
controlled with IAM. The public API only exposes the approved projection. Do
not grant untrusted users database write access or the service account role.

## Operation and manual approval

Node 22 is required. Install with `npm ci` in this directory. For production,
configure the functions' `GITHUB_TOKEN` and `CEREBRAS_API_KEY` with Firebase
Secret Manager, and grant the function service account access. Never commit
credentials. The scheduler is deployed but performs no work unless the
function environment explicitly sets `INSIGHTS_SCHEDULE_ENABLED=true`. It
creates **drafts only**, daily at 03:00 UTC; it never publishes automatically.
Check plan pricing and establish spending alerts before enabling it. The
application limit is not a monetary or organization-wide spending cap.

First create a Realtime Database instance and deploy the database rules along with
Hosting and Functions. Use a trusted operator account with Application Default
Credentials and only the necessary Realtime Database IAM permissions. Explicitly set
`GCLOUD_PROJECT` and `FIREBASE_DATABASE_URL` to your project and database URL,
then use the following commands from this directory:

```
node insights-admin.js generate
node insights-admin.js review YYYY-MM-DD
node insights-admin.js publish YYYY-MM-DD
```

For manual generation, supply `GITHUB_TOKEN` and `CEREBRAS_API_KEY` as
environment variables from your secret manager in the operator's secure
environment, not as shell command arguments. `review` prints the full private
draft including public-source excerpts; handle its output accordingly. Review
all citations, wording, sourcing, sample limitations, and potential attribution
errors before invoking `publish`. Publishing atomically replaces the current
public snapshot and rejects older or already-published runs. No public admin
or generation endpoint exists.

One transactional claim per UTC day is shared by scheduler and CLI. The run is
never reclaimed, including after a timeout or failure, preventing duplicate
paid requests; retry on the next UTC day. A 15-minute lease timestamp is
diagnostic, not a takeover mechanism. At most eight model calls are reserved
transactionally before each call, with no automatic retries, one call at a time
and at most 1,500 output tokens per call. GitHub calls are capped at 49 per run
(one cohort, eight searches, 40 file lists), each with a 20-second timeout and
bounded response; model responses are bounded too. Provider failures leave the
last public snapshot untouched. No automated token/cost accounting, adaptive
backoff, retention policy, or monthly spending cap is implemented; configure
external billing safeguards and periodically manage old private run records.

For local operation, start the Realtime Database emulator alongside Functions and
Hosting using a `demo-` project ID. In a separate trusted shell, set
`GCLOUD_PROJECT=demo-contributor-atlas` and
`FIREBASE_DATABASE_URL=https://demo-contributor-atlas-default-rtdb.firebaseio.com` and
`FIREBASE_DATABASE_EMULATOR_HOST=127.0.0.1:9000`. Load the two secrets securely into
that shell's environment without printing them, then run the same generate,
review and publish commands. Do not publish until the source-by-source
[review checklist](../docs/insight-review-checklist.md) has been completed.
Emulator data is temporary unless Firebase emulator import/export is configured.

## Testing locally

Run `npm test` for deterministic mock tests. For the Realtime Database and localhost
HTTP integration test, with Java and Firebase CLI installed, from the project
root run:

```
firebase emulators:exec --only database --project demo-insights 'cd functions && npm run test:emulator'
```

The test requires a `demo-` project and a localhost Realtime Database emulator, uses
mock upstream responses, and removes its test records. Hosting and Functions
emulators are configured in `firebase.json`; use a demo project and fake
secrets when starting them. Do not point local tests at production. Never use
real provider credentials to test this pipeline.

The test was verified with Firebase CLI 13.35.1 and Java 17. Recent Firebase CLI
releases require Java 21 or newer.
# Contributor dashboard backend

Firebase Hosting forwards `GET /api/contributors` to a Node.js 22, second-generation Firebase HTTPS function in `us-central1`. It fetches public data from the GitHub REST API server-side; the browser never receives the token. A second-generation Functions deployment requires a Firebase project on the Blaze (pay-as-you-go) plan; charges can apply beyond free allowances. Hosting and Functions are not deployed by this code alone.

## Setup

1. Install Node.js 22 and the Firebase CLI, sign in with `firebase login`, and select or specify your Firebase project. Install dependencies with `npm install` in `functions/`.
2. Create a GitHub personal access token able to read public repositories (a fine-grained token with public repository access is sufficient). Give it only the access needed. Never commit it or put it in frontend code.
3. Run `firebase functions:secrets:set GITHUB_TOKEN --project PROJECT_ID` and enter the token when prompted. The secret is bound only to the function. To rotate it, set a new version and redeploy the function. No Firebase service account file is required.
4. Create a Realtime Database instance. Build the frontend from the project root with `npm run build`, then run `firebase deploy --only functions,hosting,database --project PROJECT_ID`. The Hosting configuration serves Vite's `dist/` output and falls back to `/index.html` for frontend routes. Set `FIREBASE_DATABASE_URL` in the Functions environment if the database URL is not supplied automatically.

The function uses `GITHUB_TOKEN` through Firebase Secret Manager. For local development, use the Firebase Functions emulator's supported secret override mechanism (for example, a **private, uncommitted** `functions/.secret.local` containing `GITHUB_TOKEN=...`). Do not place tokens in `firebase.json`, source control, browser code, or logs.

## Endpoint and schema

`GET /api/contributors` returns JSON:

```json
{
  "repository": "posthog/posthog",
  "generated_at": "2026-11-17T20:00:00.000Z",
  "activity_window": {
    "start_date": "2026-08-19",
    "end_date": "2026-11-16",
    "timezone": "UTC",
    "days": 90
  },
  "candidate_limit": 8,
  "contributors": [
    {
      "login": "example",
      "profile_url": "https://github.com/example",
      "avatar_url": "https://avatars.githubusercontent.com/u/1?v=4",
      "all_time_default_branch_commits": 1000,
      "commits": { "count": 42, "incomplete": false },
      "merged_pull_requests": { "count": 12, "incomplete": false },
      "issues_commented_on": { "count": 34, "incomplete": false }
    }
  ],
  "stale": false
}
```

`avatar_url` is a string or `null`. Dates are inclusive UTC calendar dates. `generated_at` is the UTC collection start time; `stale` indicates that the snapshot is at least 12 hours old or the latest refresh failed. The array can contain fewer than eight contributors, or be empty. Results retain GitHub's contributor order, not an order by the recent metrics. Each search metric contains a nonnegative integer `count` and GitHub's boolean `incomplete_results` flag as `incomplete`; when true, the count is incomplete and should not be presented as exact.

Candidate selection: GitHub's repository contributors endpoint returns its first 100 contributors ordered by all-time default-branch commit contributions; the first eight entries of GitHub type `User` with valid logins are selected. It does not identify all automated accounts, and the first page may not contain eight users. GitHub's attribution, indexing, pagination, and possible updates to its contributor statistics affect the list and counts. This is not a ranking of the most active people in the recent window, nor a measure of quality, impact, innovation, or all project contributions.

Metric definitions and limits:

- `all_time_default_branch_commits`: GitHub contributor endpoint's all-time `contributions` count for the default branch, used for candidate selection.
- `commits`: GitHub commit-search total for this repository and GitHub author account, filtered by commit **author date** in the previous 90 complete UTC days. Commit search can include indexed commits outside the default branch; it is not necessarily comparable to the all-time default-branch count. It can miss unlinked author emails or unindexed commits.
- `merged_pull_requests`: issue-search total for PRs authored by the account and merged within that same window. This measures merged PRs, not reviews, comments, or all PRs worked on.
- `issues_commented_on`: all-time issue-search total of distinct issues on which the account commented. It is **not** a count of comments and has no 90-day filter; it excludes PRs, reviews, and other forms of issue participation.

GitHub search totals are subject to indexing delay, search limits, and GitHub's `incomplete_results` flag. GitHub limits retrieval of search results to 1,000 matches; this endpoint requests only the aggregate `total_count`, not all matching items, so it does not count by paginating those results. Totals may still be approximate or incomplete. Public contributions and identity attribution can change over time.

Non-GET requests return `405 {"error":"method_not_allowed"}` with `Allow: GET`. A locally rate-limited request returns `429 {"error":"rate_limited"}` and `Retry-After`. When no usable data is available, the endpoint returns `503 {"error":"contributors_unavailable"}`. Upstream details and secrets are not included in errors.

## Caching and limits

The last successful snapshot and user records are stored in Realtime Database. When the snapshot is at least 12 hours old, a transaction claims a refresh only if no attempt has started in the previous 12 hours. Failed attempts also consume that interval; the previous snapshot is served as stale, or a 503 is returned if none exists. Responses use `Cache-Control: no-store`. The function allows 60 GET requests per rolling minute **per instance**, with a maximum of one configured instance. This is a best-effort abuse/rate control, not per-client, durable, globally coordinated, or a substitute for an edge firewall. Cold starts and deployments reset this request counter. GitHub API quotas and secondary limits are shared with other users of the token. Each successful refresh uses one contributor request and three searches per candidate, so throttling or upstream outages can produce stale data or 503s.

## Tests

Run `npm test` in `functions/`. Tests use mocked GitHub responses and exercise windows, attribution queries, caching, concurrent requests, stale/error handling, and rate limiting. They do not validate live GitHub behavior or deploy Firebase resources.
