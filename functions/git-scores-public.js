'use strict';

// The public snapshot contains only an allowlisted projection. The review
// digest binds the operator's approval to the entire private run and graph.
const { scoreGitGraph } = require('./git-assessment-scores');
const { hashGraph } = require('./git-assessments');
const { RUN_ID, PRIOR, packetFor, validateOutput, authorKey, MAX_ATTEMPTS } =
  require('./cerebras-git-scores');

const PUBLIC = 'git_score_public';
const DRAFTS = 'git_cerebras_score_drafts';
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const digest = x => hashGraph(x);
const hashPattern = /^[a-f0-9]{64}$/;
const round = x => Math.round(x * 100) / 100;

const methodology = Object.freeze({
  cohort: 'Top 20 graph contributors by non-merge commit count, descending; ties by contributor ID, missing counts last. Rank is activity rank, not score rank.',
  activity: 'For available cohort counts: 100 × (count − minimum) / (maximum − minimum); if all available counts are equal, activity is 100. Missing counts remain null.',
  subjective: '75% displayed activity index plus 25% AI subjective path breadth score.',
  business: '75% displayed activity index plus 25% AI business directory mapping score.',
  missing: 'The AI components are not min-max normalized because some AI outputs are missing. A missing AI output, missing component, or missing activity yields a null weighted score; no values are imputed. Completed counts refer to validated AI outputs, not non-null components.',
  limitations: 'AI may change score ordering and scores may tie; rank remains activity rank. Sampled paths are incomplete proxies, not quality or actual business impact. Identities may include bots or merge or split people. Values are rounded to two decimal places.',
});

function checkedDraft(graph, draft) {
  if (!object(graph) || graph.metadata?.repositoryUrl !== 'https://github.com/PostHog/posthog' ||
      typeof graph.metadata.generatedAt !== 'string' || !graph.metadata.generatedAt ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(graph.metadata.head || '')) throw Error('graph');
  const graphHash = hashGraph(graph);
  const scores = scoreGitGraph(graph);
  if (!scores.authors.length || !object(draft) || !object(draft.meta) ||
      draft.meta.run_id !== RUN_ID || draft.meta.graph_hash !== graphHash ||
      draft.meta.graph_head !== scores.source.head || draft.meta.prior_run !== PRIOR ||
      draft.meta.model !== 'qwen-3.8-27b' || !['running', 'draft', 'failed'].includes(draft.meta.status) ||
      draft.meta.methodology_json !== JSON.stringify(scores.methodology) ||
      draft.meta.scoring_methodology !== scores.methodology_version || !object(draft.authors)) throw Error('draft');
  const keys = scores.authors.map(a => authorKey(a.author_id));
  if (Object.keys(draft.authors).length !== keys.length ||
      Object.keys(draft.authors).some(key => !keys.includes(key))) throw Error('authors');

  const counts = scores.authors.map(a => a.algorithmic.value).filter(n => n !== null);
  const min = counts.length ? Math.min(...counts) : null;
  const max = counts.length ? Math.max(...counts) : null;
  let completedCount = 0;
  const privateAuthors = [];
  const publicScores = scores.authors.map(author => {
    const packet = packetFor(author, scores, graphHash);
    const state = draft.authors[authorKey(author.author_id)];
    if (!object(state) || state.author_id !== author.author_id || state.graph_hash !== graphHash ||
        state.packet_json !== JSON.stringify(packet) || !Number.isSafeInteger(state.reserved_calls) ||
        state.reserved_calls < 1 || state.reserved_calls > MAX_ATTEMPTS || !object(state.attempts) ||
        Object.keys(state.attempts).length !== state.reserved_calls || state.active != null) throw Error('state');
    for (let i = 1; i <= state.reserved_calls; i++) {
      const attempt = state.attempts[`attempt_${i}`];
      if (!object(attempt) || typeof attempt.token !== 'string' ||
          attempt.status !== (state.status === 'complete' && i === state.reserved_calls ? 'succeeded' : 'failed')) {
        throw Error('attempt');
      }
    }
    let result = null;
    if (state.status === 'complete' && typeof state.result_json === 'string') {
      result = validateOutput(JSON.parse(state.result_json), packet);
      completedCount++;
    } else if (state.status !== 'failed' || state.reserved_calls !== MAX_ATTEMPTS || state.result_json != null) {
      throw Error('unfinished');
    }
    privateAuthors.push({ packet, result, status: state.status });
    const count = author.algorithmic.value;
    const activity = count === null ? null : max === min ? 100 : round(100 * (count - min) / (max - min));
    const weighted = value => activity === null || value == null ? null : round(0.75 * activity + 0.25 * value);
    return {
      authorId: author.author_id, name: author.author_name, rank: author.rank, commitCount: count,
      activity,
      subjective: weighted(result?.subjective_path_breadth.score),
      business: weighted(result?.business_directory_mapping.score),
    };
  });
  return { graphHash, draftDigest: digest(draft), graph, graphScores: scores, authors: privateAuthors,
    scores: publicScores, completedCount, missingCount: scores.authors.length - completedCount };
}

async function review(db) {
  // A root read obtains graph and draft from the same database snapshot.
  const state = (await db.ref().get()).val();
  const result = checkedDraft(state?.git_graph, state?.[DRAFTS]?.[RUN_ID]);
  return { runId: RUN_ID, ...result, methodology };
}

async function publish(db, { graphHash, draftDigest, acceptPartial = false, now = () => new Date() } = {}) {
  if (!hashPattern.test(graphHash || '') || !hashPattern.test(draftDigest || '') ||
      typeof acceptPartial !== 'boolean') throw Error('approval');
  const generatedAt = now().toISOString();
  const root = db.ref();
  let listener;
  try {
    await new Promise((resolve, reject) => { listener = root.on('value', resolve, reject); });
    const transaction = await root.transaction(state => {
      try {
        if (!object(state) || (state[PUBLIC] != null && !object(state[PUBLIC]))) return;
        const checked = checkedDraft(state.git_graph, state[DRAFTS]?.[RUN_ID]);
        if (checked.graphHash !== graphHash || checked.draftDigest !== draftDigest ||
            (checked.missingCount && !acceptPartial)) return;
        const snapshot = {
          graphHead: state.git_graph.metadata.head, graphGeneratedAt: state.git_graph.metadata.generatedAt,
          scores: checked.scores, methodology, generatedAt,
          completedCount: checked.completedCount, missingCount: checked.missingCount,
        };
        return { ...state, [PUBLIC]: { ...(state[PUBLIC] || {}), current: {
          approved: true, graph_hash: graphHash, snapshot_json: JSON.stringify(snapshot),
        } } };
      } catch (_) { return; }
    }, undefined, false);
    if (!transaction.committed) throw Error('Publication refused: approval, draft or graph changed');
    return { runId: RUN_ID, graphHash, draftDigest, generatedAt, status: 'published' };
  } finally { if (listener) root.off('value', listener); }
}

function createGitScoresHandler({ db }) {
  return async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (req.method !== 'GET') {
      res.set('Allow', 'GET');
      return res.status(405).json({ error: 'method_not_allowed' });
    }
    try {
      // Read only the public inputs; no draft is accessed by the HTTP handler.
      const [publishedSnap, graphSnap] = await Promise.all([
        db.ref(`${PUBLIC}/current`).get(), db.ref('git_graph').get(),
      ]);
      if (!publishedSnap.exists()) return res.status(404).json({ error: 'scores_not_found' });
      const published = publishedSnap.val(), graph = graphSnap.val();
      if (!object(published) || published.approved !== true ||
          !hashPattern.test(published.graph_hash || '') || typeof published.snapshot_json !== 'string') throw Error('snapshot');
      if (!graph || hashGraph(graph) !== published.graph_hash) return res.status(409).json({ error: 'scores_graph_mismatch' });
      const data = JSON.parse(published.snapshot_json);
      if (!object(data) || !Array.isArray(data.scores) || !object(data.methodology) ||
          data.graphHead !== graph.metadata?.head || data.graphGeneratedAt !== graph.metadata?.generatedAt ||
          typeof data.generatedAt !== 'string' || !Number.isSafeInteger(data.completedCount) ||
          !Number.isSafeInteger(data.missingCount) || data.completedCount < 0 || data.missingCount < 0 ||
          data.completedCount + data.missingCount !== data.scores.length || data.scores.length > 20) throw Error('snapshot');
      const metric = x => x === null || typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 100;
      const scores = data.scores.map(s => {
        if (!object(s) || typeof s.authorId !== 'string' || typeof s.name !== 'string' ||
            !Number.isSafeInteger(s.rank) || s.rank < 1 ||
            !(s.commitCount === null || Number.isSafeInteger(s.commitCount) && s.commitCount >= 0) ||
            !metric(s.activity) || !metric(s.subjective) || !metric(s.business)) throw Error('snapshot');
        return { authorId: s.authorId, name: s.name, rank: s.rank, commitCount: s.commitCount,
          activity: s.activity, subjective: s.subjective, business: s.business };
      });
      // Use the fixed methodology rather than passing through arbitrary stored fields.
      return res.status(200).json({ graphHead: data.graphHead, graphGeneratedAt: data.graphGeneratedAt,
        scores, methodology, generatedAt: data.generatedAt,
        completedCount: data.completedCount, missingCount: data.missingCount });
    } catch (_) { return res.status(503).json({ error: 'scores_unavailable' }); }
  };
}

module.exports = { createGitScoresHandler, review, publish };
