#!/usr/bin/env node
import { spawn, execFileSync } from 'child_process'
import { createHash } from 'crypto'
import { once } from 'events'
import { promises as fs } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const defaults = {
  repo: resolve(root, '.local/posthog'),
  output: resolve(root, '.local/git-graph.json'),
  ref: 'HEAD',
  'source-url': 'https://github.com/PostHog/posthog',
  contributors: 40,
  commits: 400,
  'commits-per-contributor': 20,
  files: 600,
  'files-per-commit': 30,
}

function optionsFrom(args) {
  const options = { ...defaults }
  for (let i = 0; i < args.length; i++) {
    const key = args[i].replace(/^--/, '')
    if (!args[i].startsWith('--') || !(key in options) || i + 1 >= args.length) {
      throw new Error(`Unknown or incomplete option: ${args[i]}`)
    }
    const value = args[++i]
    if (typeof defaults[key] === 'number') {
      if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
        throw new Error(`--${key} must be a positive integer`)
      }
      options[key] = Number(value)
    } else options[key] = value
  }
  const source = new URL(options['source-url'])
  if (source.protocol !== 'https:' || source.username || source.password || source.search || source.hash || decodeURIComponent(source.pathname).includes('@')) {
    throw new Error('--source-url must be a public HTTPS repository URL without credentials, query or fragment')
  }
  options['source-url'] = source.href.replace(/\/+$/, '').replace(/\.git$/, '')
  return options
}

const env = { ...process.env, GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }
function git(repo, args, extraEnv = {}) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: { ...env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function runGit(repo, args) {
  const child = spawn('git', ['-C', repo, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  child.stdin.on('error', () => {})
  let error = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => { error += chunk })
  const done = new Promise((resolveDone, reject) => {
    child.on('error', reject)
    child.on('close', code => code === 0 ? resolveDone() : reject(new Error(`git ${args[0]} failed: ${error.trim()}`)))
  })
  // Attach a handler immediately, even if the stream consumer fails first.
  done.catch(() => {})
  return { child, done }
}

async function* nulTokens(stream) {
  let remaining = Buffer.alloc(0)
  for await (const chunk of stream) {
    remaining = remaining.length ? Buffer.concat([remaining, chunk]) : chunk
    let start = 0
    for (let i = 0; i < remaining.length; i++) {
      if (remaining[i] === 0) {
        yield remaining.subarray(start, i).toString('utf8')
        start = i + 1
      }
    }
    remaining = remaining.subarray(start)
  }
  if (remaining.length) throw new Error('Incomplete NUL-delimited git output')
}

// Git author names can themselves contain an email address.
const hasEmail = value => value.includes('@')
const safeName = name => hasEmail(name) ? 'Redacted author' : (name.trim() || 'Unknown author')
const identityKey = (name, email) => email.trim() ? `email:${email.trim().toLowerCase()}` : `name:${name.trim()}`
const encodePath = path => path.split('/').map(encodeURIComponent).join('/')

async function scanHistory(repo, head, mailmapConfig, visit) {
  const args = [...mailmapConfig, 'log', '--no-merges', '--date-order', '-z', '--format=%H%x00%aN%x00%aE%x00%aI', head, '--']
  const { child, done } = runGit(repo, args)
  child.stdin.end()
  let fields = []
  try {
    for await (const token of nulTokens(child.stdout)) {
      fields.push(token)
      if (fields.length === 4) {
        visit(...fields)
        fields = []
      }
    }
    await done
    if (fields.length) throw new Error('Incomplete commit record')
  } catch (error) {
    child.kill()
    throw error
  }
}

async function getPaths(repo, commits, onPath) {
  const { child, done } = runGit(repo, ['diff-tree', '--stdin', '-r', '--root', '--no-renames', '--name-only', '-z', '--format=%x00%H%x00'])
  const writer = (async () => {
    for (const commit of commits) {
      if (!child.stdin.write(`${commit.hash}\n`)) await once(child.stdin, 'drain')
    }
    child.stdin.end()
  })()
  writer.catch(() => {})
  let expectingHash = false
  let expectingSeparator = false
  let commit = null
  let firstPath = false
  try {
    for await (const token of nulTokens(child.stdout)) {
      if (expectingSeparator) {
        if (token !== '') throw new Error('Malformed diff-tree separator')
        expectingSeparator = false
      } else if (token === '') {
        if (expectingHash) throw new Error('Malformed diff-tree output')
        expectingHash = true
      } else if (expectingHash) {
        commit = token
        expectingHash = false
        expectingSeparator = true
        firstPath = true
      } else if (commit) {
        // Git inserts exactly one separator newline before the first path.
        const path = firstPath && token.startsWith('\n') ? token.slice(1) : token
        firstPath = false
        onPath(commit, path)
      } else throw new Error('Malformed diff-tree output')
    }
    await writer
    await done
    if (expectingHash || expectingSeparator) throw new Error('Incomplete diff-tree output')
  } catch (error) {
    child.kill()
    throw error
  }
}

export async function buildGraph(options) {
  const repo = resolve(options.repo)
  const head = git(repo, ['rev-parse', '--verify', `${options.ref}^{commit}`, '--'])
  const shallow = git(repo, ['rev-parse', '--is-shallow-repository']) === 'true'
  // A no-checkout clone does not expose HEAD's .mailmap as a working tree file.
  // Use its blob only when locally present; never trigger a partial-clone fetch.
  const treeEntry = git(repo, ['ls-tree', head, '--', '.mailmap'])
  const mailmapConfig = []
  let headMailmap = 'absent'
  if (treeEntry) {
    try {
      git(repo, ['cat-file', '-e', `${head}:.mailmap`])
    } catch {
      throw new Error('HEAD .mailmap exists but its blob is not available locally; cannot apply it without downloading')
    }
    mailmapConfig.push('-c', `mailmap.blob=${head}:.mailmap`)
    headMailmap = 'applied'
  }

  const authors = new Map()
  let totalCommits = 0
  await scanHistory(repo, head, mailmapConfig, (hash, name, email) => {
    const key = identityKey(name, email)
    let author = authors.get(key)
    if (!author) authors.set(key, author = { name: safeName(name), count: 0, anchor: hash })
    author.count++
    if (hash < author.anchor) author.anchor = hash
    totalCommits++
  })
  const ranked = [...authors.entries()].sort((a, b) => b[1].count - a[1].count || a[1].anchor.localeCompare(b[1].anchor))
  const top = ranked.slice(0, options.contributors)
  const selected = new Map(top.map(([key, author]) => [key, { ...author, id: `contributor:${author.anchor}`, samples: [] }]))

  await scanHistory(repo, head, mailmapConfig, (hash, name, email, date) => {
    const author = selected.get(identityKey(name, email))
    if (author && author.samples.length < options['commits-per-contributor']) {
      author.samples.push({ id: `commit:${hash}`, hash, author: author.id, date })
    }
  })
  // Round-robin prevents prolific contributors from consuming the whole sample.
  const commits = []
  for (let i = 0; i < options['commits-per-contributor'] && commits.length < options.commits; i++) {
    let added = false
    for (const author of selected.values()) {
      if (author.samples[i] && commits.length < options.commits) {
        commits.push(author.samples[i])
        added = true
      }
    }
    if (!added) break
  }

  const byHash = new Map(commits.map(commit => [commit.hash, commit]))
  const files = new Map()
  const edges = commits.map(commit => ({ source: commit.author, target: commit.id, type: 'authored' }))
  for (const commit of commits) {
    commit.sourceUrl = `${options['source-url']}/commit/${commit.hash}`
    commit.changedPathCount = 0
    commit.sampledPathCount = 0
    delete commit.author
  }
  let pathOccurrences = 0
  let redactedPathOccurrences = 0
  await getPaths(repo, commits, (hash, path) => {
    const commit = byHash.get(hash)
    if (!commit) throw new Error(`Unexpected diff-tree commit: ${hash}`)
    commit.changedPathCount++
    pathOccurrences++
    if (hasEmail(path)) {
      redactedPathOccurrences++
      return
    }
    if (commit.sampledPathCount >= options['files-per-commit']) return
    let file = files.get(path)
    if (!file && files.size >= options.files) return
    if (!file) {
      file = {
        id: `file:${createHash('sha256').update(path).digest('hex')}`,
        path,
        sourceUrl: `${options['source-url']}/commits/${hash}/${encodePath(path)}`,
        sampledCommitCount: 0,
      }
      files.set(path, file)
    }
    file.sampledCommitCount++
    commit.sampledPathCount++
    edges.push({ source: commit.id, target: file.id, type: 'changed' })
  })

  const contributors = [...selected.values()].map(author => ({
    id: author.id, name: author.name, commitCount: author.count,
    sourceUrl: `${options['source-url']}/commit/${author.anchor}`,
    sampledCommitCount: edges.filter(edge => edge.type === 'authored' && edge.source === author.id).length,
  }))
  return {
    schemaVersion: 1,
    metadata: {
      generatedAt: new Date().toISOString(),
      repositoryUrl: options['source-url'],
      head,
      headUrl: `${options['source-url']}/commit/${head}`,
      requestedRef: hasEmail(options.ref) ? '[redacted]' : options.ref,
      shallow,
      headMailmap,
      scope: 'Non-merge commits reachable from the pinned ref; all parents traversed. Shallow repositories contain only locally reachable history.',
      identity: 'Git mailmap-normalized author email, case-insensitive; name fallback when email is empty. Git also reads configured and working-tree mailmaps. IDs and contributor links use an anchor commit, not a GitHub login. Identity mapping can merge or split people and IDs can change when history or mailmap changes.',
      paths: 'Tree differences from the single parent (or empty tree for roots); renames are represented as deletion and addition. Paths containing @ are omitted. Paths are decoded as UTF-8; non-UTF-8 names may be lossy.',
      sampling: 'Top contributors by full-history non-merge commit count; per-contributor commits in git date-order, selected round-robin. Files are first encountered in sampled-commit and git path order, subject to global and per-commit limits.',
      limits: { contributors: options.contributors, commits: options.commits, commitsPerContributor: options['commits-per-contributor'], files: options.files, filesPerCommit: options['files-per-commit'] },
      totals: { nonMergeCommits: totalCommits, contributorIdentities: authors.size, sampledContributors: contributors.length, sampledCommits: commits.length, sampledFiles: files.size, sampledCommitPathOccurrences: pathOccurrences, includedCommitPathOccurrences: edges.length - commits.length, redactedPathOccurrences },
    },
    contributors,
    commits,
    files: [...files.values()],
    edges,
  }
}

async function main() {
  const options = optionsFrom(process.argv.slice(2))
  const graph = await buildGraph(options)
  const output = resolve(options.output)
  await fs.mkdir(dirname(output), { recursive: true })
  const temporary = `${output}.${process.pid}.tmp`
  await fs.writeFile(temporary, JSON.stringify(graph))
  await fs.rename(temporary, output)
  console.log(`Wrote ${output}: ${graph.contributors.length} contributors, ${graph.commits.length} commits, ${graph.files.length} files`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
