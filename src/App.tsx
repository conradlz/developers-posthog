import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDownRight, ArrowUpRight, BarChart3, BookOpen, ChevronRight, CircleHelp, Code2, GitCommitHorizontal, Github, Layers3, Sparkles } from 'lucide-react'
import { Button } from './components/ui/button'
import ContributorPerspectives, { safeUrl } from './ContributorPerspectives'

const ActivityChart = lazy(() => import('./ActivityChart'))

type Contributor = {
  login: string
  profile_url: string
  avatar_url: string | null
  all_time_default_branch_commits: number
  commits: { count: number; incomplete: boolean }
  merged_pull_requests: { count: number; incomplete: boolean }
  issues_commented_on: { count: number; incomplete: boolean }
}
type Dashboard = {
  contributors: Contributor[]
  generated_at: string
  activity_window: { start_date: string; end_date: string; days: number; timezone: string }
  stale: boolean
}

const format = (value: number) => new Intl.NumberFormat('en-US', { notation: value >= 10000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(value)

const REFRESH_AGE = 12 * 60 * 60 * 1000
const RETRY_DELAY = 15 * 60 * 1000
const CLOCK_INTERVAL = 60 * 1000
const REQUEST_TIMEOUT = 30 * 1000

function snapshotTime(value: unknown): number | null {
  // Require an explicit timezone so an invalid or ambiguous timestamp is never shown as UTC.
  if (typeof value !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return null
  const time = Date.parse(value)
  return Number.isFinite(time) ? time : null
}

function relativeAge(time: number, now: number): string {
  const age = now - time
  if (age < 0) return 'timestamp is in the future'
  const minutes = Math.floor(age / 60000)
  if (minutes < 1) return 'less than a minute ago'
  if (minutes < 60) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`
  const days = Math.floor(hours / 24)
  return `${days} ${days === 1 ? 'day' : 'days'} ago`
}

function isDashboard(value: unknown): value is Dashboard {
  if (!value || typeof value !== 'object') return false
  const result = value as Partial<Dashboard>
  const metric = (item: unknown) => {
    if (!item || typeof item !== 'object') return false
    const value = item as { count?: unknown; incomplete?: unknown }
    return Number.isSafeInteger(value.count) && (value.count as number) >= 0 && typeof value.incomplete === 'boolean'
  }
  return typeof result.stale === 'boolean' && Array.isArray(result.contributors) && result.contributors.every((person) =>
    person && typeof person.login === 'string' && person.login.length > 0 &&
    typeof person.profile_url === 'string' && (person.avatar_url === null || typeof person.avatar_url === 'string') &&
    Number.isSafeInteger(person.all_time_default_branch_commits) && person.all_time_default_branch_commits >= 0 &&
    metric(person.commits) && metric(person.merged_pull_requests) && metric(person.issues_commented_on))
}

function App() {
  const [data, setData] = useState<Dashboard | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [selected, setSelected] = useState('')
  const [error, setError] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [now, setNow] = useState(Date.now)
  const dataRef = useRef<Dashboard | null>(null)
  const requestRef = useRef<AbortController | null>(null)
  const nextAttemptRef = useRef(0)

  const load = useCallback(async () => {
    if (requestRef.current) return
    const controller = new AbortController()
    requestRef.current = controller
    nextAttemptRef.current = Date.now() + RETRY_DELAY
    if (dataRef.current) setRefreshing(true)
    else setStatus('loading')
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT)
    try {
      const response = await fetch('/api/contributors', { signal: controller.signal, cache: 'no-cache' })
      if (!response.ok) throw new Error(response.status === 429
        ? 'The data service is receiving too many requests. Please wait a moment and try again.'
        : `The data service could not be reached (HTTP ${response.status}).`)
      const result: unknown = await response.json()
      if (!isDashboard(result)) throw new Error('The data service returned an unexpected response.')
      if (requestRef.current !== controller) return
      dataRef.current = result
      setData(result)
      setNow(Date.now())
      setSelected((current) => result.contributors.some((contributor) => contributor.login === current) ? current : result.contributors[0]?.login ?? '')
      setError('')
      setStatus('ready')
    } catch (err) {
      if (requestRef.current !== controller) return
      setError(controller.signal.aborted ? 'The request timed out. Please try again.' : err instanceof Error ? err.message : 'Something went wrong.')
      if (!dataRef.current) setStatus('error')
    } finally {
      window.clearTimeout(timeout)
      if (requestRef.current === controller) {
        requestRef.current = null
        setRefreshing(false)
        nextAttemptRef.current = Date.now() + RETRY_DELAY
      }
    }
  }, [])
  useEffect(() => {
    void load()
    const interval = window.setInterval(() => {
      const currentTime = Date.now()
      setNow(currentTime)
      const current = dataRef.current
      const generated = snapshotTime(current?.generated_at)
      if (currentTime >= nextAttemptRef.current && (!current || current.stale || generated === null || generated > currentTime || currentTime - generated >= REFRESH_AGE)) void load()
    }, CLOCK_INTERVAL)
    return () => {
      window.clearInterval(interval)
      const request = requestRef.current
      requestRef.current = null
      request?.abort()
    }
  }, [load])

  const contributors = data?.contributors ?? []
  const generated = snapshotTime(data?.generated_at)
  const ageStale = generated !== null && now - generated >= REFRESH_AGE
  const person = contributors.find((contributor) => contributor.login === selected) ?? contributors[0]
  const maxCommits = Math.max(...contributors.map((contributor) => contributor.all_time_default_branch_commits), 1)
  const chartNames = useMemo(() => contributors.slice(0, 6).map((contributor) => contributor.login), [data])
  const chartValues = useMemo(() => contributors.slice(0, 6).map((contributor) => contributor.all_time_default_branch_commits), [data])

  return <div className="app">
    <aside className="sidebar" aria-label="Site navigation">
      <a className="brand-mark" href="/" aria-label="Contributor Atlas home"><Layers3 size={20} /></a>
      <nav className="side-nav">
        <a className="side-icon active" href="#leaderboard" aria-label="Leaderboard" title="Leaderboard"><BarChart3 size={19} /></a>
        <a className="side-icon" href="#about" aria-label="About this project" title="About"><BookOpen size={18} /></a>
      </nav>
      <a className="sidebar-bottom" href="#about" aria-label="Methodology"><CircleHelp size={18} /></a>
    </aside>
    <main className="main">
      <header className="topbar">
        <div className="wordmark">contributor atlas <span>/</span> <span style={{ color: '#59665b', margin: 0, fontWeight: 500 }}>posthog</span></div>
        <div className="top-right">
          <div className="live"><span className="dot" /> OPEN SOURCE, OPEN DATA</div>
          <a className="repo-link" href="https://github.com/PostHog/posthog" target="_blank" rel="noreferrer" aria-label="PostHog on GitHub (opens in a new tab)"><Github size={16} /><span>PostHog on GitHub</span><ArrowUpRight size={13} /></a>
        </div>
      </header>

      <section className="intro">
        <div>
          <div className="eyebrow"><span className="tiny-line" /> THE PEOPLE BEHIND THE PRODUCT</div>
          <h1>Built in the open. <em>Together.</em></h1>
          <p>A little appreciation for the people building PostHog, one contribution at a time.</p>
        </div>
        <div className="intro-actions">
          <div className="pill"><Github size={15} /> posthog / posthog <ArrowUpRight size={12} /></div>
          <div className="pill period"><span className="dot" /> {data && (data.stale || ageStale) ? 'Outdated contributor data' : data && (generated === null || generated > now) ? 'Contributor freshness unknown' : 'GitHub activity'}</div>
        </div>
      </section>

      <div className="dashboard">
        <section className="card leaderboard" id="leaderboard">
          <div className="card-heading">
            <div><div className="label">THE PEOPLE MAKING IT HAPPEN</div><h2>Contributor leaderboard</h2><p className="sub">A closer look at the humans behind the commits.</p></div>
            <span className="count-badge">TOP CONTRIBUTORS</span>
          </div>
          <div className="table-head"><span>RANK</span><span>CONTRIBUTOR</span><span>COMMITS</span><span>COUNT</span><span /></div>
          {status === 'loading' && <div className="empty"><strong>Gathering the good stuff…</strong>Loading the latest public GitHub activity.</div>}
          {status === 'error' && <div className="empty" role="alert"><strong>Couldn't load contributors</strong>{error}<br />For local development, start the Firebase emulators and configure a GitHub token as described in the project README.<br /><Button variant="outline" className="error-button" onClick={() => void load()}>Try again</Button></div>}
          {data && <div className="refresh-status" role="status">
            {refreshing ? 'Refreshing contributor data…' : error ? <>Couldn't refresh contributor data. Showing the previous snapshot. {error} <button className="retry-insights" type="button" onClick={() => void load()}>Try again</button></> : data.stale ? 'The service returned a stale contributor snapshot; we’ll retry later.' : ageStale ? 'Contributor data is over 12 hours old; we’ll retry later.' : generated === null || generated > now ? 'Contributor snapshot time is unavailable or in the future; we’ll retry later.' : null}
          </div>}
          {status === 'ready' && contributors.length === 0 && <div className="empty"><strong>No contributors found yet.</strong>Please try again later.</div>}
          {contributors.slice(0, 6).map((contributor, index) => <button className={`contributor ${person?.login === contributor.login ? 'selected' : ''}`} onClick={() => setSelected(contributor.login)} key={contributor.login} aria-pressed={person?.login === contributor.login}>
            <span className={`rank ${index === 0 ? 'first' : ''}`}>{String(index + 1).padStart(2, '0')}</span>
            <span className="person">{contributor.avatar_url ? <img className="avatar" src={contributor.avatar_url} alt="" loading={index > 2 ? 'lazy' : 'eager'} /> : <span className="avatar" />}<span className="person-name"><span className="name">{contributor.login}</span><span className="handle">@{contributor.login}</span></span></span>
            <span className="bar-wrap"><span className="bar-track"><span className="bar" style={{ display: 'block', width: `${Math.max(2, contributor.all_time_default_branch_commits / maxCommits * 100)}%` }} /></span><span className="bar-value">{Math.round(contributor.all_time_default_branch_commits / maxCommits * 100)}%</span></span>
            <span className="number">{format(contributor.all_time_default_branch_commits)}</span><ChevronRight className="chevron" size={15} />
          </button>)}
          <div className="table-foot"><span>All-time default-branch commits · Select a contributor</span><a href="https://github.com/PostHog/posthog/graphs/contributors" target="_blank" rel="noreferrer">View on GitHub <ArrowUpRight size={12} /></a></div>
        </section>

        <div className="right-stack">
          <section className="card profile" aria-label="Selected contributor profile">
            <div className="profile-title"><div><div className="label">A LITTLE SPOTLIGHT</div><h2>Contributor profile</h2></div><Sparkles size={17} color="#b8c8ae" /></div>
            {person ? <>
              <div className="profile-main">{person.avatar_url ? <img className="avatar" src={person.avatar_url} alt="" /> : <span className="avatar" />}<div aria-live="polite" aria-atomic="true"><div className="profile-name">{person.login}</div><div className="profile-handle">@{person.login}</div></div>{safeUrl(person.profile_url) && <a className="profile-link" href={safeUrl(person.profile_url)} target="_blank" rel="noopener noreferrer" aria-label={`View ${person.login} on GitHub (opens in a new tab)`}><ArrowUpRight size={15} /></a>}</div>
              <ContributorPerspectives person={person} window={data?.activity_window} />
            </> : <div className="empty">Select a contributor to see their activity.</div>}
          </section>
          <section className="card chart-card">
            <div className="chart-header"><div><div className="label">THE BIGGER PICTURE</div><h2>Contributions at a glance</h2><p className="sub">A little perspective on the work behind PostHog.</p></div><div className="chart-legend"><span className="legend-dot" /> Commits</div></div>
            {contributors.length ? <Suspense fallback={<div className="chart-empty">Loading chart…</div>}><ActivityChart names={chartNames} values={chartValues} label="Commits" /></Suspense> : <div className="chart-empty">Your contribution chart will appear here.</div>}
          </section>
        </div>
      </div>
      <footer className="bottom-note" id="about">
        <div className="footer-left"><Code2 size={14} className="footer-icon" /><span>Made for the people who build in the open. Not affiliated with PostHog.</span></div>
        <div>{data && <>{generated === null ? 'Contributor snapshot time unknown' : <>Contributor snapshot: {relativeAge(generated, now)} · <time dateTime={new Date(generated).toISOString()}>{new Date(generated).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC')}</time></>} · </>}<a href="https://github.com/PostHog/posthog" target="_blank" rel="noreferrer">Public GitHub data</a> <ArrowDownRight size={11} style={{ verticalAlign: 'middle' }} /></div>
      </footer>
      <p className="sub" style={{ padding: '0 2px 12px' }}><GitCommitHorizontal size={12} style={{ verticalAlign: 'middle' }} /> GitHub's top contributors by all-time default-branch commits; this candidate selection favors historical commit volume. GitHub Bot accounts are excluded, though some automated accounts may remain. Counts do not measure quality, innovation, or a person's full impact. Recent activity is based on GitHub search and may have a different scope; issue counts are distinct issues commented on over all time. AI perspectives are sampled interpretations, not performance rankings, and may omit private or unobserved work.</p>
    </main>
  </div>
}

export default App
