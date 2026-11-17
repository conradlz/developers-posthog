'use strict';

const { hashGraph } = require('./git-assessments');

// Only reviewed snapshots are public. The hash binds them to the entire
// graph, not merely its HEAD: sampling options can change at the same commit.
function createGitAssessmentsHandler({ db }) {
  return async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (req.method !== 'GET') {
      res.set('Allow', 'GET');
      return res.status(405).json({ error: 'method_not_allowed' });
    }
    try {
      const [published, graphSnap] = await Promise.all([
        db.ref('git_assessment_public/current').get(), db.ref('git_graph').get(),
      ]);
      if (!published.exists()) return res.status(404).json({ error: 'assessments_not_found' });
      const snapshot = JSON.parse(published.val().snapshot_json);
      const graph = graphSnap.val();
      if (!graph || hashGraph(graph) !== snapshot.graph_hash) {
        return res.status(409).json({ error: 'assessments_graph_mismatch' });
      }
      if (!Array.isArray(snapshot.authors) || !graph.metadata || !graph.metadata.generatedAt) throw new Error('Invalid snapshot');
      const scores = snapshot.scores && Array.isArray(snapshot.scores.authors)
        ? snapshot.scores.authors.map(author => ({
          authorId: author.author_id, name: author.author_name, rank: author.rank,
          activity: author.algorithmic.score, subjective: author.subjective_proxy.score,
          business: author.business_proxy.score,
        })) : [];
      const commits = Object.values(graph.commits || {});
      const dates = new Map(commits.map(commit => [commit.hash, commit.date]));
      const assessments = {};
      for (const author of snapshot.authors) {
        if (typeof author.author_id !== 'string' || !Array.isArray(author.evidence)) throw new Error('Invalid author');
        const sources = author.evidence.map(item => ({
          id: item.id, title: `Commit ${item.id.slice(7, 19)}`, url: item.url,
          date: (dates.get(item.id.slice(7)) || '').slice(0, 10) || 'date unknown',
        }));
        const section = value => ({
          observations: value.observations.map(claim => ({ text: claim.text, sourceIds: claim.source_ids })),
          interpretations: value.interpretations.map(claim => ({ text: claim.text, sourceIds: claim.source_ids })),
          limitations: [...value.limitations, author.caveats],
        });
        assessments[author.author_id] = {
          algorithmic: { text: `Rank ${author.rank} by ${author.algorithmic.commit_count.toLocaleString('en-US')} reachable non-merge commits in the graph. This is an activity count, not a measure of quality or impact.`, sourceIds: [] },
          subjective: section(author.subjective), business: section(author.business), sources,
        };
      }
      return res.status(200).json({ graphHead: snapshot.graph_head,
        graphGeneratedAt: graph.metadata.generatedAt, generatedAt: snapshot.generated_at, assessments, scores,
        scoreMethodology: snapshot.scores?.methodology || null,
        scoreMethodologyVersion: snapshot.scores?.methodology_version || null });
    } catch (_) {
      return res.status(503).json({ error: 'assessments_unavailable' });
    }
  };
}

module.exports = { createGitAssessmentsHandler };
