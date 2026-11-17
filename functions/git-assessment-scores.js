'use strict';

// Version 1 is deliberately a description of observed Git activity, not an
// assessment of a person. Changing sampling, mapping or normalization requires
// a new methodology version.
const METHODOLOGY_VERSION = 'git-graph-proxies-v1';
const LIMITS = Object.freeze({
  graphBytes: 4_000_000, contributors: 1000, commits: 5000, files: 10000,
  edges: 50000, authors: 20, commitsPerAuthor: 5, pathsPerCommit: 10,
});
const AREA_MAPPING = Object.freeze([
  Object.freeze({ prefix: 'products/', area: 'products directory' }),
  Object.freeze({ prefix: 'frontend/src/', area: 'frontend source directory' }),
  Object.freeze({ prefix: 'posthog/api/', area: 'API directory' }),
]);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = value => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
const validText = (value, max) => typeof value === 'string' && value.trim().length > 0 &&
  value.length <= max && !/[\u0000-\u001f\u007f@]/.test(value);

function collection(value) {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) throw new Error('Invalid graph collection');
    return value;
  }
  if (!object(value)) throw new Error('Invalid graph collection');
  const keys = Object.keys(value);
  if (!keys.every((key, i) => key === String(i))) throw new Error('Invalid graph collection');
  return keys.map(key => value[key]);
}

function normalizeScores(authors, field) {
  const values = authors.map(author => author[field].value).filter(value => value !== null);
  const max = values.length ? Math.max(...values) : null;
  for (const author of authors) {
    const metric = author[field];
    metric.score = metric.value === null ? null : max === 0 ? 0 : Math.round(metric.value / max * 10000) / 100;
    metric.cohort_max = max;
  }
}

/**
 * scoreGitGraph(raw): pure, synchronous graph scoring. Input is a schemaVersion
 * 1 graph as stored in RTDB (arrays, dense numeric-key objects, or absent empty
 * collections). See the returned methodology for the complete v1 contract.
 * Invalid or oversized graphs throw; the input is never modified.
 */
function scoreGitGraph(raw) {
  if (!object(raw) || raw.schemaVersion !== 1 || (raw.metadata !== undefined && !object(raw.metadata))) {
    throw new Error('Invalid graph');
  }
  let json;
  try { json = JSON.stringify(raw); } catch { throw new Error('Invalid graph'); }
  if (!json || Buffer.byteLength(json) > LIMITS.graphBytes) throw new Error('Invalid or oversized graph');
  const contributors = collection(raw.contributors);
  const commits = collection(raw.commits);
  const files = collection(raw.files);
  const edges = collection(raw.edges);
  if (contributors.length > LIMITS.contributors || commits.length > LIMITS.commits ||
      files.length > LIMITS.files || edges.length > LIMITS.edges) throw new Error('Graph exceeds limits');

  const maps = [contributors, commits, files].map((entries, index) => {
    const prefix = ['contributor:', 'commit:', 'file:'][index];
    const map = new Map();
    for (const entry of entries) {
      if (!object(entry) || typeof entry.id !== 'string' || !entry.id.startsWith(prefix) ||
          entry.id.length <= prefix.length || entry.id.length > 140 || map.has(entry.id)) {
        throw new Error('Invalid graph node');
      }
      map.set(entry.id, entry);
    }
    return map;
  });
  const [authorsById, commitsById, filesById] = maps;
  for (const author of contributors) {
    if (!hash(author.id.slice('contributor:'.length)) || !validText(author.name, 200) ||
        (author.commitCount != null && (!Number.isSafeInteger(author.commitCount) || author.commitCount < 0))) {
      throw new Error('Invalid graph author');
    }
  }
  for (const commit of commits) {
    if (!hash(commit.hash) || commit.id !== `commit:${commit.hash}`) throw new Error('Invalid graph commit');
  }
  for (const file of files) {
    if (!validText(file.path, 240)) throw new Error('Invalid graph path');
  }
  const authored = new Map(), changed = new Map(), seen = new Set(), commitAuthors = new Set();
  for (const edge of edges) {
    if (!object(edge) || typeof edge.source !== 'string' || typeof edge.target !== 'string') {
      throw new Error('Invalid graph edge');
    }
    const key = JSON.stringify([edge.type, edge.source, edge.target]);
    if (seen.has(key)) throw new Error('Duplicate graph edge');
    seen.add(key);
    if (edge.type === 'authored' && authorsById.has(edge.source) && commitsById.has(edge.target)) {
      if (commitAuthors.has(edge.target)) throw new Error('Commit has multiple authors');
      commitAuthors.add(edge.target);
      if (!authored.has(edge.source)) authored.set(edge.source, []);
      authored.get(edge.source).push(edge.target);
    } else if (edge.type === 'changed' && commitsById.has(edge.source) && filesById.has(edge.target)) {
      if (!changed.has(edge.source)) changed.set(edge.source, []);
      changed.get(edge.source).push(edge.target);
    } else throw new Error('Invalid graph edge');
  }

  const ranked = [...contributors].sort((a, b) => {
    if (a.commitCount == null && b.commitCount != null) return 1;
    if (b.commitCount == null && a.commitCount != null) return -1;
    return (b.commitCount ?? 0) - (a.commitCount ?? 0) || a.id.localeCompare(b.id);
  }).slice(0, LIMITS.authors);

  const authors = ranked.map((author, index) => {
    const commitIds = authored.get(author.id) || [];
    const paths = new Set();
    const evidence = commitIds.slice(0, LIMITS.commitsPerAuthor).map(id => {
      const commit = commitsById.get(id);
      const fileIds = changed.get(id) || [];
      const sampledPaths = fileIds.slice(0, LIMITS.pathsPerCommit).map(fileId => {
        const path = filesById.get(fileId).path;
        paths.add(path);
        const match = AREA_MAPPING.find(item => path.startsWith(item.prefix));
        return { file_id: fileId, path, mapped_area: match ? match.area : null };
      });
      return {
        commit_id: id, hash: commit.hash,
        graph_path_count: fileIds.length,
        changed_path_count: Number.isSafeInteger(commit.changedPathCount) &&
          commit.changedPathCount >= fileIds.length ? commit.changedPathCount : null,
        paths_included: sampledPaths.length, paths: sampledPaths,
      };
    });
    const mapped = [...paths].filter(path => AREA_MAPPING.some(item => path.startsWith(item.prefix))).length;
    return {
      author_id: author.id, author_name: author.name, rank: index + 1,
      algorithmic: { value: author.commitCount ?? null },
      subjective_proxy: { value: paths.size || null },
      business_proxy: { value: mapped ? mapped / paths.size : null },
      counts: {
        graph_sampled_commits: commitIds.length, commits_included: evidence.length,
        distinct_sampled_paths: paths.size, distinct_mapped_paths: mapped,
      },
      evidence,
    };
  });
  for (const field of ['algorithmic', 'subjective_proxy', 'business_proxy']) normalizeScores(authors, field);
  return {
    methodology_version: METHODOLOGY_VERSION,
    source: { type: 'git_graph', schema_version: 1, head: typeof raw.metadata?.head === 'string' &&
      hash(raw.metadata.head) ? raw.metadata.head : null },
    methodology: {
      cohort: 'First 20 contributors by graph non-merge commit count descending, ties by contributor ID using localeCompare; missing counts last.',
      sampling: 'For each author use the first 5 authored commits in graph edge order and first 10 changed paths per commit in graph edge order. The graph itself may already be sampled, truncated, redacted or shallow.',
      normalization: 'For each metric separately, divide each available value by the maximum available value in the same selected cohort and multiply by 100, rounded to 2 decimals. If all available values are zero, their scores are zero. Missing values and scores are null.',
      algorithmic: 'Graph non-merge commit count; missing count is null.',
      subjective_proxy: 'Distinct sampled file paths across selected commits; no sampled paths means null. This is a coverage proxy, not a subjective evaluation.',
      business_proxy: 'Proportion of distinct sampled file paths matching the listed directory prefixes. No matched paths or no sampled paths means null, not zero; this is a directory-mapping proxy, not actual business impact or business relevance.',
      limitations: 'Heuristics describe sampled graph data, not quality, collaboration, actual business impact or sole credit. Paths do not establish purpose. Git identities may merge or split people; bots may be included. Samples are not necessarily representative.',
      area_mapping: AREA_MAPPING.map(item => ({ ...item })),
      limits: { ...LIMITS },
    },
    authors,
  };
}

module.exports = { scoreGitGraph, METHODOLOGY_VERSION };
