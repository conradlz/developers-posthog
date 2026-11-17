'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { scoreGitGraph, METHODOLOGY_VERSION } = require('./git-assessment-scores');

const hash = number => number.toString(16).padStart(40, '0');
const author = (number, count) => ({
  id: `contributor:${hash(number)}`, name: `Author ${number}`, commitCount: count,
});
function graph() {
  return { schemaVersion: 1, metadata: { head: hash(999) }, contributors: [], commits: [], files: [], edges: [] };
}
function addCommit(g, authorNumber, number, paths, changedPathCount = paths.length) {
  const id = `commit:${hash(number)}`;
  g.commits.push({ id, hash: hash(number), changedPathCount });
  g.edges.push({ type: 'authored', source: `contributor:${hash(authorNumber)}`, target: id });
  for (const path of paths) {
    let file = g.files.find(item => item.path === path);
    if (!file) {
      file = { id: `file:${hash(g.files.length + 1000)}`, path };
      g.files.push(file);
    }
    g.edges.push({ type: 'changed', source: id, target: file.id });
  }
}

test('calculates separate max-relative scores with distinct path evidence', () => {
  const g = graph();
  g.contributors.push(author(1, 20), author(2, 10), author(3, 5));
  addCommit(g, 1, 101, ['products/a.ts', 'docs/a.md', 'posthog/api/a.py']);
  addCommit(g, 1, 102, ['products/a.ts', 'README.md']);
  addCommit(g, 2, 103, ['frontend/src/a.ts', 'docs/a.md']);
  addCommit(g, 3, 104, ['products/b.ts']);
  const result = scoreGitGraph(g);
  assert.equal(result.methodology_version, METHODOLOGY_VERSION);
  assert.equal(result.source.head, hash(999));
  const [one, two, three] = result.authors;
  assert.deepEqual(result.authors.map(a => a.algorithmic.score), [100, 50, 25]);
  assert.deepEqual(result.authors.map(a => a.subjective_proxy.score), [100, 50, 25]);
  assert.deepEqual(result.authors.map(a => a.business_proxy.score), [50, 50, 100]);
  assert.equal(one.business_proxy.value, 0.5);
  assert.equal(two.business_proxy.cohort_max, 1);
  assert.equal(three.business_proxy.value, 1);
  assert.deepEqual(one.counts, { graph_sampled_commits: 2, commits_included: 2,
    distinct_sampled_paths: 4, distinct_mapped_paths: 2 });
  assert.deepEqual(one.evidence[0].paths.map(p => p.mapped_area),
    ['products directory', null, 'API directory']);
  assert.match(result.methodology.limitations, /not quality, collaboration, actual business impact/);
});

test('missing evidence is null, including unmatched paths; known zero counts remain zero', () => {
  const g = graph();
  g.contributors.push(author(1, 0), author(2, null), author(3, 0));
  addCommit(g, 3, 101, ['docs/only.md']);
  const result = scoreGitGraph(g);
  const one = result.authors.find(a => a.author_id === author(1, 0).id);
  const two = result.authors.find(a => a.author_id === author(2, null).id);
  const three = result.authors.find(a => a.author_id === author(3, 0).id);
  assert.deepEqual(one.algorithmic, { value: 0, score: 0, cohort_max: 0 });
  assert.deepEqual(two.algorithmic, { value: null, score: null, cohort_max: 0 });
  assert.equal(one.subjective_proxy.score, null);
  assert.equal(one.business_proxy.score, null);
  assert.equal(three.subjective_proxy.score, 100);
  assert.equal(three.business_proxy.value, null);
  assert.equal(three.business_proxy.cohort_max, null);
  assert.equal(three.counts.distinct_sampled_paths, 1);
  assert.equal(three.counts.distinct_mapped_paths, 0);
});

test('samples first five commits and ten paths per commit and reports graph truncation', () => {
  const g = graph();
  g.contributors.push(author(1, 100));
  for (let i = 0; i < 6; i++) {
    const paths = Array.from({ length: 12 }, (_, j) =>
      j === 11 ? `products/hidden${i}.ts` : `docs/${i}-${j}.md`);
    addCommit(g, 1, 101 + i, paths, 20);
  }
  const a = scoreGitGraph(g).authors[0];
  assert.equal(a.counts.graph_sampled_commits, 6);
  assert.equal(a.counts.commits_included, 5);
  assert.equal(a.counts.distinct_sampled_paths, 50);
  assert.equal(a.business_proxy.score, null);
  assert.equal(a.evidence[0].graph_path_count, 12);
  assert.equal(a.evidence[0].changed_path_count, 20);
  assert.equal(a.evidence[0].paths_included, 10);
  assert.equal(a.evidence[4].hash, hash(105));
});

test('limits cohort to 20, sorts ties as graph, normalizes within cohort, and is pure', () => {
  const g = graph();
  for (let i = 25; i >= 1; i--) {
    g.contributors.push(author(i, 10));
    if (i === 25) addCommit(g, i, 100 + i, ['products/a', 'products/b']);
    if (i === 1) addCommit(g, i, 100 + i, ['products/c']);
  }
  const before = structuredClone(g);
  const result = scoreGitGraph(g);
  assert.equal(result.authors.length, 20);
  assert.deepEqual(result.authors.map(a => a.author_id),
    Array.from({ length: 20 }, (_, i) => author(i + 1, 10).id));
  assert.deepEqual(result.authors.map(a => a.rank), Array.from({ length: 20 }, (_, i) => i + 1));
  assert.equal(result.authors[0].subjective_proxy.score, 100);
  assert.deepEqual(g, before);
  assert.deepEqual(scoreGitGraph(g), result);
});

test('accepts raw RTDB numeric collections and omitted empties', () => {
  const g = graph();
  g.contributors.push(author(1, 1));
  addCommit(g, 1, 101, ['products/x']);
  const expected = scoreGitGraph(g);
  for (const key of ['contributors', 'commits', 'files', 'edges']) g[key] = { ...g[key] };
  assert.deepEqual(scoreGitGraph(g), expected);
  assert.deepEqual(scoreGitGraph({ schemaVersion: 1 }).authors, []);
  assert.throws(() => scoreGitGraph({ schemaVersion: 1, contributors: { 1: author(1, 1) } }), /collection/);
});

test('rejects malformed, duplicated, oversized, or dangling data', () => {
  const g = graph();
  g.contributors.push(author(1, 1));
  addCommit(g, 1, 101, ['products/x']);
  const duplicate = structuredClone(g);
  duplicate.edges.push(duplicate.edges[0]);
  assert.throws(() => scoreGitGraph(duplicate), /Duplicate/);
  const dangling = structuredClone(g);
  dangling.edges[0].target = 'commit:missing';
  assert.throws(() => scoreGitGraph(dangling), /edge/);
  const malformed = structuredClone(g);
  malformed.files[0].path = '';
  assert.throws(() => scoreGitGraph(malformed), /path/);
  const invalidCount = structuredClone(g);
  invalidCount.contributors[0].commitCount = -1;
  assert.throws(() => scoreGitGraph(invalidCount), /author/);
  assert.throws(() => scoreGitGraph({ schemaVersion: 1, metadata: { data: 'x'.repeat(4_000_000) } }), /oversized/);
  assert.throws(() => scoreGitGraph({ schemaVersion: 1, contributors: Array(1001).fill(null) }), /limits/);
  const sparse = graph(); sparse.contributors = Array(1);
  assert.throws(() => scoreGitGraph(sparse), /collection/);
});

test('normalization rounds ratios and treats prefix matching as case sensitive', () => {
  const g = graph();
  g.contributors.push(author(1, 3), author(2, 1));
  addCommit(g, 1, 101, ['products/a', 'docs/a', 'docs/b']);
  addCommit(g, 2, 102, ['products/b', 'Products/c']);
  const [one, two] = scoreGitGraph(g).authors;
  assert.equal(one.business_proxy.score, 66.67);
  assert.equal(two.business_proxy.score, 100);
  assert.equal(two.algorithmic.score, 33.33);
  assert.equal(two.evidence[0].paths[1].mapped_area, null);
});
