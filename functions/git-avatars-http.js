'use strict';

const { hashGraph } = require('./git-assessments');

function createGitAvatarsHandler({ db }) {
  return async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (req.method !== 'GET') {
      res.set('Allow', 'GET');
      return res.status(405).json({ error: 'method_not_allowed' });
    }
    try {
      const [avatarSnap, graphSnap] = await Promise.all([
        db.ref('git_avatar_images').get(), db.ref('git_graph').get(),
      ]);
      if (!avatarSnap.exists()) return res.status(404).json({ error: 'avatars_not_found' });
      const data = avatarSnap.val(), graph = graphSnap.val();
      if (!graph || hashGraph(graph) !== data.graphHash) return res.status(409).json({ error: 'avatars_graph_mismatch' });
      if (!graph.metadata || typeof graph.metadata.head !== 'string' || typeof graph.metadata.generatedAt !== 'string' ||
          (data.contributors !== undefined && (!data.contributors || typeof data.contributors !== 'object'))) throw new Error('Invalid snapshot');
      const avatars = {};
      for (const [id, item] of Object.entries(data.contributors || {})) {
        if (!/^contributor:(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(id) || !item || typeof item.dataUrl !== 'string' ||
            item.dataUrl.length > 175000 ||
            !/^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(item.dataUrl)) continue;
        avatars[id] = item.dataUrl;
      }
      return res.status(200).json({ graphHead: graph.metadata.head, graphGeneratedAt: graph.metadata.generatedAt, avatars });
    } catch (_) {
      return res.status(503).json({ error: 'avatars_unavailable' });
    }
  };
}
module.exports = { createGitAvatarsHandler };
