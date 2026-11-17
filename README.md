# Contributor Atlas

## Local Git knowledge graph

The repository history is stored separately in `.local/posthog/` and is ignored by
Git. A local operator can analyze the default branch's reachable Git history and
populate Firebase Realtime Database without using the GitHub API.

Git author identities are not reliably GitHub accounts. Git history also does
not contain PR reviews, issue discussions, or evidence of business impact; a
commit or changed file is not a measure of quality or sole credit.

The dashboard reads the published Git graph from Realtime Database through a
read-only Firebase Function. Page views do not contact GitHub, generate insights,
or launch hydration. A snapshot at least 12 hours old is marked stale; an
operator must run the update commands to refresh it. The page displays reviewed
Git assessments from RTDB when available. The previous GitHub API and PR-based
AI functions are retained for reference but are not used by this page.

## Requirements

- Node.js 22 and npm
- Git
- Firebase CLI, a Firebase project, and a Realtime Database instance.

## Setup and deployment

```sh
nvm use 22
npm ci
cd functions && npm ci && cd ..
firebase login
npm run build
firebase deploy --only functions:gitGraph,functions:gitAssessments,functions:gitAvatars,functions:gitScores,hosting,database --project PROJECT_ID
```

Replace `PROJECT_ID` with your Firebase project ID. Create a Realtime Database
instance first and configure `FIREBASE_DATABASE_URL` in the Functions
environment if Firebase does not supply its URL automatically. This graph
endpoint does not require GitHub or Cerebras secrets. Never commit a
service-account JSON file or ship it to the browser.

## Populate the graph

Create the clone once, then generate and publish a snapshot from the project
root. The clone below contains the complete reachable commit history and trees,
but omits blobs and does not check out files:

```sh
git clone --filter=blob:none --no-checkout --single-branch https://github.com/PostHog/posthog.git .local/posthog
npm run build:git-graph
export GCLOUD_PROJECT=PROJECT_ID
export FIREBASE_DATABASE_URL=https://YOUR_DATABASE_INSTANCE.firebasedatabase.app
export GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/service-account.json
node functions/publish-git-graph.js .local/git-graph.json
```

Use the exact database URL from the Firebase console and credentials with the
necessary Realtime Database access. Alternatively, use Application Default
Credentials and omit `GOOGLE_APPLICATION_CREDENTIALS`. The publisher replaces
`/git_graph` and `/git_tracked_users`, records jobs in `/git_hydration_jobs`,
and leaves other root children intact. It uses root transactions, which read
and rewrite the entire database and require broad privileges; this is suitable
only for a small, dedicated database. Failed attempts also consume the
12-hour cooldown. The guard uses the local operator machine's clock, so clock
skew between machines can violate strict server-time enforcement. Job history
has no automatic retention.

The snapshot samples up to 40 authors, 400 commits and 600 files by default,
while author commit totals are counted across all reachable non-merge history.
The script strips email addresses and excludes file paths containing `@`.
The graph is only as current as the local clone. Refresh the remote-tracking
branch and explicitly analyze it before publishing again:

```sh
git -C .local/posthog fetch origin master
npm run build:git-graph -- --ref refs/remotes/origin/master
node functions/publish-git-graph.js .local/git-graph.json
```

### Contributor avatars

After publishing a graph, a local operator can resolve GitHub's author for each
anchor commit and cache its image in RTDB. Set `GITHUB_TOKEN` in the
environment, along with the Firebase variables above, then run:

```sh
export GIT_AVATARS_ALLOW_LIVE=1
node functions/hydrate-git-avatars.js
node functions/materialize-git-avatars.js
```

The first command makes at most 40 GitHub API requests and stores associations
under `/git_avatars`. The second copies bounded images under
`/git_avatar_images`, so browsers load image data only from Firebase. The
association is GitHub's attribution of one anchor commit, not proof that a
mailmap-normalized Git identity is a particular GitHub account; bots and
merged or split identities are possible. Missing images use initials. Avatar
snapshots are tied to the complete graph and must be rebuilt after a graph
refresh. Both commands use root transactions and require broad Admin access.

For local development:

Start the emulators with `firebase emulators:start --only functions,hosting,database --project demo-contributor-atlas`,
then in another terminal set `GCLOUD_PROJECT=demo-contributor-atlas`,
`FIREBASE_DATABASE_URL=https://demo-contributor-atlas-default-rtdb.firebaseio.com`,
and `FIREBASE_DATABASE_EMULATOR_HOST=127.0.0.1:9000` before running the
publisher. Run `npm run dev` and open the Vite URL. Emulator data is separate
from production.

## Generate and review Git assessments

After publishing a graph, run the local operator script against that same RTDB
instance. It reads `/git_graph`, selects up to 20 Git author identities by
non-merge commit count, samples up to five connected commits and ten paths
per commit, and sends only that limited evidence to Cerebras. Git authors
can include bots, and are not verified people. The full-history commit count
is an activity metric, not a quality or impact score.

Set `CEREBRAS_API_KEY` in your shell from your secure secret store; do not put
it in the frontend, source code, command history, or a committed file. The
script reads this environment variable; it does not automatically load
`functions/.secret.local`. The other variables are the same as graph
publication above. Then:

```sh
export GIT_ASSESSMENTS_ALLOW_LIVE=1
node functions/git-assessments-admin.js generate RUN_ID
node functions/git-assessments-admin.js review RUN_ID
node functions/git-assessments-admin.js publish RUN_ID
```

Use a unique `RUN_ID` containing letters, digits, hyphens or underscores.
Each run reserves at most one Cerebras request per author and 20 requests
total (below the four-per-author limit); failures and ambiguous timeouts still
consume the reservation. A used run ID cannot be resumed or retried; using
a new ID creates a new budget. Generation uses the `qwen-3.8-27b` model and
stores a private draft in `/git_assessment_runs`. Credentials and graph text
are not printed during generation. Review prints the entire draft to the
terminal; protect its output. Inspect every claim and citation using
`docs/insight-review-checklist.md` before publishing. Citation validation
does not prove a claim. If the draft is inaccurate, do not publish it.

Publishing saves the reviewed snapshot to `/git_assessment_public/current`
and refuses a changed graph. The read-only `/api/git-assessments` Function
also hides it if the graph later changes, including a new snapshot at the
same Git HEAD. Page views never call Cerebras. Publishing transacts the whole
database, so use it only with a small dedicated database and restricted Admin
credentials. RTDB rules deny direct client access to both draft and public
data; Admin SDK credentials bypass these rules.

Use `node functions/git-assessments-admin.js --help` for emulator and safety
details. Creating a fresh run intentionally incurs a fresh paid request budget;
there is no cross-run or per-day cap.

### Experimental score map

The score map is a separate reviewed publication, read from Realtime Database
through `/api/git-scores`. The activity score maps the lowest and highest
non-merge commit counts in the top-20 cohort to 0 and 100, respectively.
For the two other views, the displayed score blends 75% activity with 25%
Cerebras's sampled-path estimate. The subjective score describes path breadth;
the business score describes matches to `products/`, `frontend/src/`, and
`posthog/api/`. These are proxies, not measures of quality or business impact.
The blended scores need not themselves reach 0 or 100, and the lower-ranked
author can occasionally score higher. Where an AI result is unavailable, its
two scores remain unavailable rather than silently falling back to graph data.
The graph may itself be shallow or truncated, and results change with the
cohort. Git identities can include bots and are not verified people.

To review the existing Cerebras score draft without making new model calls,
set the Firebase environment variables described above, then run:

```sh
export GIT_SCORES_ALLOW_LIVE=1
node functions/git-scores-admin.js review
node functions/git-scores-admin.js publish GRAPH_HASH DRAFT_DIGEST --accept-partial
```

Review prints the private evidence and outputs: protect the terminal output
and inspect it before publishing. Use the hash and digest from that review.
`--accept-partial` explicitly allows missing scores, and is required for this
run. Publication uses an atomic root transaction and refuses a changed graph
or draft. RTDB rules deny direct client access; the function exposes only the
reviewed scores, without the private draft.

## Verification

```sh
npm run typecheck
npm run build
npm run test:git-graph
node --test functions/publish-git-graph.test.js
node --test functions/git-graph.test.js
node --test functions/git-assessments.test.js functions/git-assessments-http.test.js
```

No analytics are enabled. Fitting every detail above the fold depends on screen size.
