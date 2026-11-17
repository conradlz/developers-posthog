# Plan: three perspectives on PostHog contributions

> Historical design plan: the implementation now uses Firebase Realtime Database
> instead of Firestore. See `functions/README.md` for current storage and
> refresh behavior.

## Goal

Help visitors explore how people contribute to the public `posthog/posthog` repository through three clearly separated perspectives:

1. **Algorithmic:** a reproducible ranking computed from published activity metrics.
2. **Subjective:** an AI-assisted interpretation of a contributor's public work and collaboration, with links to supporting evidence.
3. **Business:** an AI-assisted explanation of how that work might relate to PostHog's publicly stated products and business model.

The second and third perspectives are interpretations, not facts about a person's ability, compensation, revenue impact, or importance to the company. None of the three is a complete measure of a person's contributions. The product should celebrate varied work, not create a definitive employee performance ranking.

## Where we are today

The Firebase function already obtains GitHub's top candidates by all-time default-branch commits and, for each, counts commits and authored merged PRs during the previous 90 complete UTC days, plus all-time distinct issues commented on. It caches results in memory and the frontend shows six contributors. It does **not** currently fetch PR descriptions, reviews, comments, changed files, source excerpts, or PostHog business material. Counts alone are insufficient evidence for the two AI perspectives.

GitHub attribution, default-branch conventions, bot classification, incomplete search results, and the initial commit-based candidate selection all introduce bias. AI enrichment of this same candidate set will not make the selection comprehensive. Clearly display the candidate selection and time window.

## 1. Algorithmic answer

### First release

Keep the existing, understandable ranking: **all-time default-branch commits**, ordered by GitHub's contributor endpoint. Show the exact metric, date of collection, and scope. Offer a separate, clearly labeled 90-day activity view, but do not present recent search-commit counts as equivalent to all-time default-branch commits: their scopes can differ.

Show supporting counts separately rather than implying that activity is quality. Label issue data as **distinct issues commented on**, not number of comments or all issues affected. Indicate incomplete GitHub search totals instead of silently ranking on them.

### Optional future composite

After collecting reliable, comparable recent metrics, experiment with a versioned, explainable activity index. Example for a common 90-day window:

`index = 100 × (0.4 × normalized commits + 0.4 × normalized merged PRs + 0.2 × normalized distinct issues commented on)`

For each metric, define normalization as `log(1 + count) / log(1 + maximum count among eligible candidates)`; use zero if the maximum is zero. Fix the candidate set and window, show the individual inputs, weights, version and ranks, and explain that the score is relative to that set. These weights are a product choice, not a validated measure of impact. Commits and PRs may overlap; issue counts need a genuine 90-day collection method before inclusion. Do not substitute today's all-time issue count into the example. If a required metric is missing or incomplete, show **insufficient data** rather than treating it as zero. Do not combine AI opinions into this score.

## 2. Subjective answer

For each contributor, generate a short evidence-backed **contribution profile**, not a personal or psychological assessment. It might describe:

- Observable areas of work and representative merged PRs.
- The nature of the work, such as a feature, reliability fix, documentation, or developer experience improvement, when the evidence supports it.
- Observable collaboration, such as specific reviews or constructive discussions, without claiming that comment volume proves quality.
- Potential novelty only when a cited source establishes the relevant context; otherwise say that novelty cannot be determined.
- Gaps: sampled evidence, missing reviews, unmerged work, private work, or uncertainty about who deserves credit.

Every substantive claim must reference at least one retrieved source. Use **observed**, **interpretation**, and **unknown** labels; avoid unsupported superlatives, personality traits, and claims that a person alone caused a team outcome. If the evidence is thin, return “Not enough public evidence” rather than generating a generic compliment.

## 3. Business answer

Map contribution evidence to a small, versioned set of **publicly documented** business themes, such as product analytics, session replay, feature flags, developer adoption, reliability, and operating efficiency. Maintain the theme descriptions and source links separately from model prompts so they can be reviewed and refreshed.

PostHog's [pricing page](https://posthog.com/pricing) describes a free allowance and usage-based Cloud pricing; its [self-hosting documentation](https://posthog.com/docs/self-host) describes the self-hosted offering. Use dated snapshots or version identifiers and links to these sources. Pricing and offerings change; do not hard-code specific figures into an evergreen prompt.

The model may say, for example, “This change appears related to session replay reliability, which could support the experience of users of that product,” **only** if the change and product relationship are cited. Distinguish a documented product fact from a hypothetical business connection. Do not infer revenue, customer adoption, cost savings, company strategy, or causality without direct, attributable evidence. If the business connection is unclear, say so.

## Evidence pipeline

1. **Select a bounded cohort and window.** Begin with the existing eight GitHub-selected candidates and the previous 90 complete UTC days. Keep selection rules and dates in the response. Explicitly note that the cohort favors historical commit volume.
2. **Fetch public evidence server-side.** Use authenticated GitHub APIs to collect a bounded, paginated sample of merged PRs, PR descriptions, changed file paths, relevant issue discussions, and submitted reviews. Where practical include commit SHA, merged date, authorship, and links. Track truncation, sampling rules, API errors and missing permissions. Avoid assuming PR authorship equals sole implementation credit.
3. **Sample consistently.** For an MVP, select up to five recent merged PRs per person plus up to three relevant review/discussion items; use deterministic ordering and deduplicate. Prefer links, titles, and short bounded excerpts over full repositories. Record counts available versus included and why. A small sample is not representative of a career.
4. **Map product areas carefully.** Use a reviewed, versioned mapping of paths and labels to product themes. Path membership is a hint, not proof of business impact. Include only public product documentation needed for the selected themes.
5. **Create an evidence packet.** Assign stable source IDs, GitHub URLs, dates, author roles, and excerpt lengths. Limit the token budget; avoid private data, credentials, unrelated personal details, and unnecessary raw text. Give the model only this packet and public business context.
6. **Validate before publishing.** The server checks structured output and rejects unsupported source IDs, missing citations, unsafe links, malformed responses, and overlong fields. This checks citation existence, not whether a source actually supports a claim; evaluate factual support separately. Store a content hash so changes to inputs invalidate the right analysis.

Sampling, deleted or edited content, API limits, private work and missing attribution can change the story. Display these limitations next to the result and allow users to inspect source links.

## Proposed architecture

Keep Firebase Hosting and the existing read-only contributors endpoint. Add a background refresh pipeline instead of generating an AI response on every page load:

`GitHub + reviewed PostHog sources → bounded evidence packet → Cerebras → validation → persistent published snapshot → Firebase read API → dashboard`

- **Collection and generation:** a scheduled Firebase function or an admin-triggered job; restrict manual triggers with authentication/authorization. Start with one scheduled refresh per day, adjustable after measuring freshness and cost.
- **Persistence:** store versioned snapshots in Firestore or Cloud Storage, including generated time, input hash, selection rules, prompt/model/schema versions, source IDs, output and failure status. The existing per-instance memory cache is not durable or shared, and is not sufficient to coordinate paid generation across instances.
- **Publication:** publish a complete validated snapshot atomically. Keep the previous successful version available if collection or AI generation fails; show its timestamp and stale state. Do not mix evidence and analyses from incompatible snapshots.
- **Read API:** return precomputed public results and source metadata; no API keys in responses. Public requests must not trigger unbounded GitHub or Cerebras jobs. Retain HTTP caching and add appropriate edge abuse protection if traffic warrants it.
- **Separate failure domains:** the deterministic leaderboard remains available if AI is disabled, the provider fails, or a contributor has insufficient evidence.

Firestore, scheduler, Functions, network egress and inference may incur charges. Firebase second-generation functions require the Blaze plan; free allowances are not a spending cap. Set budgets and alerts, verify pricing, and choose retention and refresh limits before enabling production jobs. Budget alerts alone do not enforce a hard cap; enforce application-level limits too.

## Cerebras integration

Use the server-side [Cerebras Chat Completions API](https://inference-docs.cerebras.ai/api-reference/chat-completions) with the exact model ID `qwen-3.8-27b`, after verifying the model is available to the account. Put `CEREBRAS_API_KEY` in Firebase Secret Manager for deployment and in a gitignored local emulator secret override for development. Never expose either API key to the client, prompts, logs, or source control.

For the MVP, prefer a **controlled evidence-gathering pipeline followed by one structured-output model call per contributor** containing both perspectives. The backend, not the model, chooses and fetches sources. This is simpler to audit than an open-ended agent and prevents unrestricted browsing. Use [strict JSON Schema output](https://inference-docs.cerebras.ai/capabilities/structured-outputs) with separate arrays for observed facts, interpretations, limitations and source IDs. Schema conformance is not factual correctness.

If later evidence shows a need for multi-step agentic research, expose only allowlisted read-only GitHub/product-document tools with bounded calls, strict argument validation, timeouts, and maximum steps. Treat all retrieved PRs, comments, and docs as **untrusted data**, never instructions; enforce permissions and limits outside the model. Do not give the model credentials or write tools. Cerebras documentation cautions against combining tools and structured `response_format` unless the model contract explicitly supports it; use a separate final formatting call if needed.

### Quotas and spend

The supplied account screenshot shows 450 requests/minute, 750,000 total tokens/minute, 150,000 uncached tokens/minute and daily limits. The [current Cerebras rate-limit documentation](https://inference-docs.cerebras.ai/support/rate-limits) lists different limits for some tiers, including 300 requests/minute for this model; treat the account's active dashboard and API response headers as authoritative, and recheck before deployment. Limits may change by tier and organization, and are shared with other consumers. A large context window is a maximum, not a target.

Start with deliberately conservative caps: at most eight contributor calls per daily run, a bounded input/output token budget per call, low concurrency, and a daily application spend/usage ceiling. For illustration, with one run/day and eight calls/run, the baseline is **8 requests/day**. At 8,000 input and 1,000 output tokens per call, that is **64,000 input and 8,000 output tokens/day**, before retries or other applications. These are planning assumptions, not measured usage or a cost estimate; use current account prices, uncached-token rates, observed usage, and retry allowance to estimate spend.

Respect rate-limit headers and `Retry-After` when provided; use capped exponential backoff with jitter for transient 429/5xx failures, limit retries and concurrency, and avoid retrying authentication/configuration errors. Enforce a distributed job lease/idempotency key and per-run budget so duplicate schedules or cold starts do not multiply calls. Log aggregate requests, tokens, latency, cost estimates, 429s and failures without logging secrets or raw sensitive content.

## Dashboard presentation

- Retain a compact, responsive leaderboard as the primary view. Explain the metric and time scope next to it.
- Selecting a person opens a profile with three labeled tabs: **Activity**, **Contribution story**, and **Business context**. Include short evidence citations linking directly to the public source and a “view methodology” link.
- Show generated date, evidence window, sample size, coverage limitations, and stale or unavailable state. Make AI-generated text unmistakable; do not render a fabricated score or empty placeholder as an answer.
- Preserve the existing count-based dashboard if enrichment is unavailable. Test small screens, keyboard navigation, screen-reader labels, and slow connections; load the interactive chart lazily. Above-the-fold coverage is viewport-dependent, so prioritize the leaderboard and selected profile rather than forcing all content into a phone screen.

## Rollout and acceptance criteria

1. **Evidence and methodology:** document exact GitHub queries, candidate bias and metric scopes. Test collection, pagination, truncation, attribution and rate-limit handling with fixtures and a small live sample.
2. **Private evaluation:** collect evidence for a small representative set. Hand-review generated claims against linked sources, including contradictory, sparse and adversarial prompt-injection examples. Track unsupported-claim rate, citation validity, appropriate abstention, coverage and latency. Set explicit acceptance thresholds before public release; a plausible tone is not a pass.
3. **Snapshot generation:** implement secrets, bounded jobs, persistent versioned snapshots, deduplication, retries and stale fallback. Test provider outages, invalid JSON, missing citations, duplicate invocations, rate limits and budget exhaustion.
4. **UI:** add the three perspectives, citations, accessible loading/error states and mobile layout. Verify that the activity-only view remains usable without AI.
5. **Limited public launch:** enable for the existing cohort, monitor token usage and errors, manually review a sample of updates, and provide a way to report incorrect attribution. Expand coverage only after quality and costs are understood.

## Decisions to make before implementation

- Is the initial historical-commit-based cohort acceptable, or should we also discover people through recent PRs, reviews and issue work? A broader cohort costs more GitHub requests and changes the meaning of the ranking.
- Should generation run daily or less often, and what hard monthly spending cap is acceptable across Cerebras and Firebase?
- Which public product sources and product-area mappings should be reviewed and maintained, and who reviews disputed attribution?
- Should AI summaries be published automatically after validation, or require human approval initially? **Recommendation:** human review for the first release.

## References

- [GitHub repository contributors API](https://docs.github.com/en/rest/repos/repos#list-repository-contributors)
- [GitHub search API](https://docs.github.com/en/rest/search/search)
- [Cerebras model details](https://inference-docs.cerebras.ai/models/qwen-3.8-27b), [rate limits](https://inference-docs.cerebras.ai/support/rate-limits), [structured outputs](https://inference-docs.cerebras.ai/capabilities/structured-outputs), and [tool calling](https://inference-docs.cerebras.ai/capabilities/tool-use)
- [PostHog pricing](https://posthog.com/pricing) and [self-hosting](https://posthog.com/docs/self-host)
