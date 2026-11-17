import { useEffect, useMemo, useState } from 'react'
import { ArrowUpRight, GitBranch, GitCommitHorizontal, Layers3 } from 'lucide-react'
import GitAssessments from './GitAssessments'
import PublishedScores from './PublishedScores'
import AuthorAvatar from './AuthorAvatar'
import './GitApp.css'

type Contributor = { id: string; name: string; commitCount: number; sampledCommitCount: number; sourceUrl: string }
type Commit = { id: string; hash: string; date: string; sourceUrl: string; changedPathCount: number; sampledPathCount: number }
type FileNode = { id: string; path: string; sourceUrl: string; sampledCommitCount: number }
type Edge = { source: string; target: string; type: 'authored' | 'changed' }
type Metadata = {
  generatedAt: string; head: string; headUrl?: string; repositoryUrl?: string
  scope: string; identity: string; paths: string; sampling: string
  limits: Record<string, number>; totals: Record<string, number>
}
type Graph = { metadata: Metadata; contributors: Contributor[]; commits: Commit[]; files: FileNode[]; edges: Edge[] }
type LoadState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; graph: Graph }

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
const isString = (value: unknown): value is string => typeof value === 'string' && value.length > 0
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

// Firebase omits empty arrays and may return sparse arrays as numeric-keyed objects.
function collection(value: unknown): unknown[] {
  if (value == null) return []
  if (Array.isArray(value)) return value.filter((item) => item != null)
  const items = record(value)
  if (!items || Object.keys(items).some((key) => !/^(0|[1-9]\d*)$/.test(key))) throw new Error('A graph collection has an invalid format.')
  return Object.entries(items).sort(([a], [b]) => Number(a) - Number(b)).map(([, item]) => item).filter((item) => item != null)
}

function parseGraph(value: unknown): Graph {
  const data = record(value)
  const meta = record(data?.metadata)
  const limits = record(meta?.limits)
  const totals = record(meta?.totals)
  if (data?.schemaVersion !== 1 || !meta || !limits || !totals ||
      !['generatedAt', 'head', 'scope', 'identity', 'paths', 'sampling'].every((key) => isString(meta[key])) ||
      !Object.values(limits).every(isCount) || !Object.values(totals).every(isCount)) {
    throw new Error('The graph snapshot has an unsupported or invalid schema.')
  }
  const contributors = collection(data.contributors)
  const commits = collection(data.commits)
  const files = collection(data.files)
  const edges = collection(data.edges)
  if (!contributors.every((item) => {
    const x = record(item)
    return x && isString(x.id) && isString(x.name) && isString(x.sourceUrl) && isCount(x.commitCount) && isCount(x.sampledCommitCount)
  }) || !commits.every((item) => {
    const x = record(item)
    return x && isString(x.id) && isString(x.hash) && isString(x.date) && isString(x.sourceUrl) && isCount(x.changedPathCount) && isCount(x.sampledPathCount)
  }) || !files.every((item) => {
    const x = record(item)
    return x && isString(x.id) && isString(x.path) && isString(x.sourceUrl) && isCount(x.sampledCommitCount)
  }) || !edges.every((item) => {
    const x = record(item)
    return x && isString(x.source) && isString(x.target) && (x.type === 'authored' || x.type === 'changed')
  })) throw new Error('The graph snapshot contains invalid records.')
  return {
    metadata: meta as Metadata,
    contributors: contributors as Contributor[], commits: commits as Commit[], files: files as FileNode[], edges: edges as Edge[],
  }
}

function safeUrl(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined
  } catch { return undefined }
}

function EvidenceLink({ url, children }: { url?: string; children: string }) {
  const href = safeUrl(url)
  return href ? <a className="git-evidence" href={href} target="_blank" rel="noopener noreferrer">{children} <ArrowUpRight size={13} aria-hidden="true" /></a> : null
}

const number = (value: number | undefined) => value === undefined ? '—' : value.toLocaleString('en-US')
const utc = (value: string) => {
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return null
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC') : null
}

function relativeAge(time: number, now: number) {
  if (!Number.isFinite(time) || time > now) return 'age unknown'
  const minutes = Math.floor((now - time) / 60_000)
  if (minutes < 1) return 'less than a minute ago'
  if (minutes < 60) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`
  const days = Math.floor(hours / 24)
  return `${days} ${days === 1 ? 'day' : 'days'} ago`
}

export default function GitApp() {
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const [authorId, setAuthorId] = useState('')
  const [commitId, setCommitId] = useState('')
  const [fileId, setFileId] = useState('')
  const [now, setNow] = useState(Date.now)
  const [avatars, setAvatars] = useState<Record<string, string>>({})

  useEffect(() => {
    const controller = new AbortController()
    setState({ status: 'loading' })
    async function load() {
      try {
        const response = await fetch('/api/git-graph', { signal: controller.signal, cache: 'no-cache' })
        if (!response.ok) throw new Error(`Snapshot service returned HTTP ${response.status}.`)
        const graph = parseGraph(await response.json() as unknown)
        if (controller.signal.aborted) return
        setAuthorId(graph.contributors[0]?.id ?? '')
        setCommitId('')
        setFileId('')
        setNow(Date.now())
        setState({ status: 'ready', graph })
      } catch (error) {
        if (!controller.signal.aborted) setState({ status: 'error', message: error instanceof Error ? error.message : 'Could not load the snapshot.' })
      }
    }
    void load()
    return () => controller.abort()
  }, [attempt])

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  const graph = state.status === 'ready' ? state.graph : null
  useEffect(() => {
    if (!graph) return
    const controller = new AbortController()
    setAvatars({})
    void (async () => {
      try {
        const response = await fetch('/api/git-avatars', { signal: controller.signal, cache: 'no-cache' })
        if (!response.ok) return
        const data = record(await response.json() as unknown)
        const entries = record(data?.avatars)
        if (data?.graphHead !== graph.metadata.head || data?.graphGeneratedAt !== graph.metadata.generatedAt || !entries) return
        const next: Record<string, string> = Object.create(null) as Record<string, string>
        for (const author of graph.contributors) {
          const value = entries[author.id]
          if (typeof value === 'string' && value.length <= 175000 && /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) next[author.id] = value
        }
        if (!controller.signal.aborted) setAvatars(next)
      } catch { /* Initials remain available if the avatar snapshot cannot be loaded. */ }
    })()
    return () => controller.abort()
  }, [graph])
  const view = useMemo(() => {
    if (!graph) return null
    const author = graph.contributors.find((item) => item.id === authorId)
    const commitIds = new Set(graph.edges.filter((edge) => edge.type === 'authored' && edge.source === authorId).map((edge) => edge.target))
    const commits = graph.commits.filter((item) => commitIds.has(item.id))
    const commit = commits.find((item) => item.id === commitId) ?? commits[0]
    const fileIds = new Set(graph.edges.filter((edge) => edge.type === 'changed' && edge.source === commit?.id).map((edge) => edge.target))
    const files = graph.files.filter((item) => fileIds.has(item.id))
    const file = files.find((item) => item.id === fileId) ?? files[0]
    return { author, commits, commit, files, file }
  }, [graph, authorId, commitId, fileId])

  const generated = graph ? utc(graph.metadata.generatedAt) : null
  const generatedMs = generated && graph ? Date.parse(graph.metadata.generatedAt) : NaN
  const freshness = !Number.isFinite(generatedMs) || generatedMs > now ? 'Freshness unknown' : now - generatedMs >= 12 * 60 * 60 * 1000 ? 'Snapshot at least 12 hours old' : 'Snapshot within 12 hours'

  return <div className="git-app">
    <header className="git-topbar">
      <div className="git-brand"><span className="git-brand-icon"><Layers3 size={20} /></span><span>contributor atlas <span className="git-brand-separator">/</span> <span className="git-brand-subtitle">git history</span></span></div>
      {graph && <EvidenceLink url={graph.metadata.repositoryUrl}>View repository</EvidenceLink>}
    </header>
    <main className="git-main">
      <section className="git-hero">
        <div><div className="git-eyebrow"><span /> GIT HISTORY IN CONTEXT</div><h1>Built in the open. <em>Together.</em></h1><p>Explore the Git authors, commits, and files connected in a snapshot of Git history.</p></div>
        {graph && <div className={`git-freshness ${freshness === 'Snapshot within 12 hours' ? '' : 'git-freshness--warning'}`}><span />{freshness}</div>}
      </section>
      {state.status === 'loading' && <div className="git-state" role="status">Loading the Git history snapshot…</div>}
      {state.status === 'error' && <div className="git-state" role="alert"><h2>Couldn’t load the snapshot</h2><p>{state.message}</p><button type="button" onClick={() => setAttempt((value) => value + 1)}>Try again</button></div>}
      {graph && view && <>
        <div className="git-snapshot"><span><GitBranch size={15} aria-hidden="true" /> PINNED HISTORY <EvidenceLink url={graph.metadata.headUrl}>{graph.metadata.head.slice(0, 12)}</EvidenceLink>{!safeUrl(graph.metadata.headUrl) && graph.metadata.head.slice(0, 12)}</span><span>Generated {relativeAge(generatedMs, now)} · {generated ? <time dateTime={graph.metadata.generatedAt}>{generated}</time> : 'UTC time unknown'}</span></div>
        <section className="git-coverage" aria-label="Snapshot coverage">
          <div><strong>{number(graph.metadata.totals.sampledContributors ?? graph.contributors.length)}</strong><span>sampled authors <small>of {number(graph.metadata.totals.contributorIdentities)} identities</small></span></div>
          <div><strong>{number(graph.metadata.totals.sampledCommits ?? graph.commits.length)}</strong><span>sampled commits <small>of {number(graph.metadata.totals.nonMergeCommits)} non-merge commits</small></span></div>
          <div><strong>{number(graph.metadata.totals.sampledFiles ?? graph.files.length)}</strong><span>sampled files <small>in selected commits</small></span></div>
          <div><strong>{number(graph.metadata.totals.includedCommitPathOccurrences)} / {number(graph.metadata.totals.sampledCommitPathOccurrences)}</strong><span>path occurrences <small>included / changed in sampled commits</small></span></div>
        </section>
        <PublishedScores graphHead={graph.metadata.head} graphGeneratedAt={graph.metadata.generatedAt} avatars={avatars} onSelect={(id) => { setAuthorId(id); setCommitId(''); setFileId('') }} />
        <section className="git-explorer" aria-labelledby="explorer-title">
          <div className="git-section-heading"><div><div className="git-label">FOLLOW THE CONNECTIONS</div><h2 id="explorer-title">Explore the history</h2><p>Select an author, then a commit and a changed file to follow the evidence. Avatars reflect GitHub’s attribution of one anchor commit; identities may be merged or split.</p></div><span className="git-badge">SAMPLED GRAPH</span></div>
          <div className="git-columns">
            <section className="git-column" aria-labelledby="authors-title"><div className="git-column-title"><h3 id="authors-title"><span>01</span> Git authors</h3><span>{number(graph.contributors.length)}</span></div><p>Ranked by non-merge commits; may include bots</p>
              {graph.contributors.length === 0 ? <div className="git-empty">No authors in this snapshot.</div> : <div className="git-list">{graph.contributors.map((author, index) => <button type="button" key={author.id} className={`git-row ${view.author?.id === author.id ? 'is-selected' : ''}`} aria-pressed={view.author?.id === author.id} onClick={() => { setAuthorId(author.id); setCommitId(''); setFileId('') }}><span className="git-row-number">{String(index + 1).padStart(2, '0')}</span><AuthorAvatar name={author.name} data={avatars[author.id]} /><span className="git-row-main"><strong>{author.name}</strong><small>{number(author.sampledCommitCount)} sampled / {number(author.commitCount)} commits</small></span><span aria-hidden="true">›</span></button>)}</div>}
            </section>
            <section className="git-column" aria-labelledby="commits-title"><div className="git-column-title"><h3 id="commits-title"><span>02</span> Commits</h3><span>{number(view.commits.length)}</span></div><p>Connected to selected author</p>
              {view.commits.length === 0 ? <div className="git-empty">No sampled commits connected to this author.</div> : <div className="git-list">{view.commits.map((commit) => <button type="button" key={commit.id} className={`git-row ${view.commit?.id === commit.id ? 'is-selected' : ''}`} aria-pressed={view.commit?.id === commit.id} onClick={() => { setCommitId(commit.id); setFileId('') }}><GitCommitHorizontal size={17} className="git-row-icon" aria-hidden="true" /><span className="git-row-main"><strong>{commit.hash.slice(0, 12)}</strong><small>{utc(commit.date) ?? 'Date unknown'}</small></span><span aria-hidden="true">›</span></button>)}</div>}
            </section>
            <section className="git-column" aria-labelledby="files-title"><div className="git-column-title"><h3 id="files-title"><span>03</span> Files</h3><span>{number(view.files.length)}</span></div><p>Connected to selected commit</p>
              {view.files.length === 0 ? <div className="git-empty">No sampled files connected to this commit.</div> : <div className="git-list">{view.files.map((file) => <button type="button" key={file.id} className={`git-row ${view.file?.id === file.id ? 'is-selected' : ''}`} aria-pressed={view.file?.id === file.id} onClick={() => setFileId(file.id)}><span className="git-file-dot" /><span className="git-row-main"><strong>{file.path}</strong><small>{number(file.sampledCommitCount)} sampled commits</small></span><span aria-hidden="true">›</span></button>)}</div>}
            </section>
          </div>
          <div className="git-selection" aria-live="polite"><div><div className="git-label">SELECTED EVIDENCE</div><h3 className="git-selected-author">{view.author && <AuthorAvatar name={view.author.name} data={avatars[view.author.id]} large />}{view.author?.name ?? 'Select an author'}</h3><p>{view.commit ? `${number(view.commit.sampledPathCount)} of ${number(view.commit.changedPathCount)} changed paths included for this commit.` : 'Select a sampled commit to explore its changed paths.'}</p>{view.file && <p className="git-selected-path">{view.file.path}</p>}</div><div className="git-evidence-links">{view.author && <EvidenceLink url={view.author.sourceUrl}>Author anchor commit</EvidenceLink>}{view.commit && <EvidenceLink url={view.commit.sourceUrl}>View commit</EvidenceLink>}{view.file && <EvidenceLink url={view.file.sourceUrl}>View file history</EvidenceLink>}</div></div>
        </section>
        <GitAssessments graphHead={graph.metadata.head} graphGeneratedAt={graph.metadata.generatedAt} authorId={view.author?.id} authorName={view.author?.name} authorRank={graph.contributors.findIndex((author) => author.id === view.author?.id)} now={now} />
        <details className="git-methodology"><summary>About the snapshot &amp; sampling limits</summary><div className="git-methodology-content"><p><strong>Scope.</strong> {graph.metadata.scope}</p><p><strong>Identity.</strong> {graph.metadata.identity}</p><p><strong>Sampling.</strong> {graph.metadata.sampling}</p><p><strong>Paths.</strong> {graph.metadata.paths}</p><p><strong>Limits.</strong> Up to {number(graph.metadata.limits.contributors)} authors, {number(graph.metadata.limits.commits)} commits, {number(graph.metadata.limits.commitsPerContributor)} commits per author, {number(graph.metadata.limits.files)} files, and {number(graph.metadata.limits.filesPerCommit)} files per commit. {number(graph.metadata.totals.redactedPathOccurrences)} path occurrences were redacted.</p><p>Connections indicate recorded changes, not ownership or expertise. This snapshot does not include all work.</p></div></details>
      </>}
      <footer className="git-footer">Exploring Git history in the open. <span>Read-only Git history snapshot.</span></footer>
    </main>
  </div>
}
