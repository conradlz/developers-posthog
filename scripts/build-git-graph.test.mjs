import { strict as assert } from 'assert'
import { execFileSync } from 'child_process'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

const { mkdtemp, mkdir, readFile, writeFile } = fs
const tests = []
const test = (name, fn) => tests.push({ name, fn })

const script = resolve('scripts/build-git-graph.mjs')
const cleanEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }

test('builds a bounded graph from mailmapped, non-merge history', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'git-graph-'))
  const repo = join(dir, 'repo')
  const output = join(dir, 'graph.json')
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { env: cleanEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const commit = (name, email, message) => execFileSync('git', ['-C', repo, 'commit', '-m', message], {
    env: { ...cleanEnv, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.test' },
    stdio: 'pipe',
  })
  const build = (...extra) => {
    execFileSync(process.execPath, [script, '--repo', repo, '--output', output, '--source-url', 'https://github.com/example/project', ...extra], { env: cleanEnv, stdio: 'pipe' })
    return readFile(output, 'utf8').then(JSON.parse)
  }
  try {
    await mkdir(repo)
    git('init', '-q')
    await writeFile(join(repo, '.mailmap'), 'Alice Canonical <alice@example.test> Alice Alias <alias@example.test>\n')
    await writeFile(join(repo, 'first.txt'), 'first')
    git('add', '.')
    commit('Alice Canonical', 'alice@example.test', 'root')
    const rootHash = git('rev-parse', 'HEAD')
    git('branch', 'side')
    await writeFile(join(repo, 'main space.txt'), 'main')
    await writeFile(join(repo, 'private@example.test'), 'private')
    git('add', '.')
    commit('Alice Alias', 'alias@example.test', 'main')
    git('checkout', '-q', 'side')
    await writeFile(join(repo, 'side.txt'), 'side')
    git('add', '.')
    commit('Bob', 'bob@example.test', 'side')
    const sideHash = git('rev-parse', 'HEAD')
    git('checkout', '-q', '-')
    execFileSync('git', ['-C', repo, 'merge', '--no-ff', 'side', '-m', 'merge'], {
      env: { ...cleanEnv, GIT_AUTHOR_NAME: 'Merger', GIT_AUTHOR_EMAIL: 'merger@example.test', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.test' },
      stdio: 'pipe',
    })
    const mergeHash = git('rev-parse', 'HEAD')
    git('mv', 'first.txt', 'renamed.txt')
    commit('Alice Canonical', 'alice@example.test', 'rename')
    const renameHash = git('rev-parse', 'HEAD')

    const graph = await build()
    assert.equal(graph.metadata.totals.nonMergeCommits, 4)
    assert.equal(graph.metadata.totals.contributorIdentities, 2)
    assert.equal(graph.metadata.headMailmap, 'applied')
    assert.equal(graph.metadata.shallow, false)
    assert.equal(graph.contributors[0].name, 'Alice Canonical')
    assert.equal(graph.contributors[0].commitCount, 3)
    assert.equal(graph.contributors[1].commitCount, 1)
    assert(!graph.commits.some(c => c.hash === mergeHash))
    assert(graph.commits.some(c => c.hash === sideHash))
    assert(graph.commits.some(c => c.hash === rootHash))
    assert(!JSON.stringify(graph).includes('@example.test'))
    assert.equal(graph.metadata.totals.redactedPathOccurrences, 1)

    const nodes = new Set([...graph.contributors, ...graph.commits, ...graph.files].map(n => n.id))
    assert(graph.edges.every(e => nodes.has(e.source) && nodes.has(e.target)))
    const renameCommit = graph.commits.find(c => c.hash === renameHash)
    assert.equal(renameCommit.changedPathCount, 2)
    const renameFiles = graph.edges.filter(e => e.source === renameCommit.id).map(e => graph.files.find(f => f.id === e.target).path).sort()
    assert.deepEqual(renameFiles, ['first.txt', 'renamed.txt'])
    assert(graph.files.find(f => f.path === 'main space.txt').sourceUrl.includes('main%20space.txt'))

    const limited = await build('--contributors', '1', '--commits', '1', '--commits-per-contributor', '1', '--files', '1', '--files-per-commit', '1')
    assert.equal(limited.contributors.length, 1)
    assert.equal(limited.contributors[0].commitCount, 3)
    assert.equal(limited.contributors[0].sampledCommitCount, 1)
    assert.equal(limited.commits.length, 1)
    assert.equal(limited.commits[0].changedPathCount, 2)
    assert.equal(limited.commits[0].sampledPathCount, 1)
    assert.equal(limited.files.length, 1)
    assert.equal(limited.edges.length, 2)
    assert.equal(limited.metadata.totals.sampledCommitPathOccurrences, 2)
    assert.equal(limited.metadata.totals.includedCommitPathOccurrences, 1)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('rejects invalid limits and credential-bearing source URLs', async () => {
  for (const args of [['--commits', '0'], ['--source-url', 'https://secret@example.com/repo']]) {
    assert.throws(() => execFileSync(process.execPath, [script, ...args], { env: cleanEnv, stdio: 'pipe' }))
  }
})

async function runTests() {
  for (const { name, fn } of tests) {
    try {
      await fn()
      console.log(`ok - ${name}`)
    } catch (error) {
      console.error(`not ok - ${name}`, error)
      process.exitCode = 1
    }
  }
}
runTests()
