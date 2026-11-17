'use strict';

const COLLECTIONS = ['contributors', 'commits', 'files', 'edges'];

function normalizeGraph(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 1) {
    throw new Error('Invalid graph');
  }
  const graph = { ...value };
  // RTDB removes empty objects and arrays. Only restore fields whose types are
  // specified by the graph schema; arbitrary missing fields cannot be inferred.
  if (graph.metadata === undefined) graph.metadata = {};
  if (!graph.metadata || typeof graph.metadata !== 'object' || Array.isArray(graph.metadata)) {
    throw new Error('Invalid graph metadata');
  }
  for (const key of COLLECTIONS) {
    const entries = graph[key];
    if (entries === undefined) {
      graph[key] = [];
    } else if (!Array.isArray(entries)) {
      // RTDB may represent numeric keys as an object. Do not silently discard
      // non-index keys or manufacture holes for malformed stored collections.
      if (!entries || typeof entries !== 'object') throw new Error('Invalid graph collection');
      const keys = Object.keys(entries);
      if (!keys.every((index, i) => index === String(i))) throw new Error('Invalid graph collection');
      graph[key] = keys.map(index => entries[index]);
    }
  }
  return graph;
}

function createGitGraphHandler({ db }) {
  return async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (req.method !== 'GET') {
      res.set('Allow', 'GET');
      return res.status(405).json({ error: 'method_not_allowed' });
    }
    try {
      const snapshot = await db.ref('git_graph').get();
      if (!snapshot.exists()) return res.status(404).json({ error: 'git_graph_not_found' });
      return res.status(200).json(normalizeGraph(snapshot.val()));
    } catch (_) {
      return res.status(503).json({ error: 'git_graph_unavailable' });
    }
  };
}

module.exports = { createGitGraphHandler };
