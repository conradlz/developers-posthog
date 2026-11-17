import { useEffect, useRef, useState } from 'react'

type ActivityPerson = {
  login: string
  commits: { count: number; incomplete: boolean }
  merged_pull_requests: { count: number; incomplete: boolean }
  issues_commented_on: { count: number; incomplete: boolean }
}

type Claim = { text: string; source_ids: string[] }
type Perspective = { observations: Claim[]; interpretations: Claim[]; limitations: string[] }
type Source = { id: string; title: string; url: string; date: string }
type Insight = { subjective?: Perspective; business?: Perspective; sources: Source[]; sample_summary?: string }
type Snapshot = {
  generated_at?: string
  window?: { start_date?: string; end_date?: string }
  contributors: Record<string, Insight>
  stale?: boolean
}
type Tab = 'activity' | 'subjective' | 'business'
type LoadState = 'loading' | 'ready' | 'unavailable' | 'error'

const tabs: { id: Tab; label: string }[] = [
  { id: 'activity', label: 'Activity' },
  { id: 'subjective', label: 'Contribution story' },
  { id: 'business', label: 'Business context' },
]

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0

export function safeUrl(value: unknown): string | undefined {
  if (!nonempty(value)) return undefined
  try {
    const url = new URL(value)
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password ? url.href : undefined
  } catch {
    return undefined
  }
}

function parsePerspective(value: unknown): Perspective | undefined {
  if (!isRecord(value) || !Array.isArray(value.observations) || !Array.isArray(value.interpretations) || !Array.isArray(value.limitations)) return undefined
  const claims = (items: unknown[]): Claim[] => items.flatMap((item) =>
    isRecord(item) && nonempty(item.text) && Array.isArray(item.source_ids) && item.source_ids.length > 0 && item.source_ids.every(nonempty)
      ? [{ text: item.text, source_ids: item.source_ids as string[] }]
      : [])
  return {
    observations: claims(value.observations),
    interpretations: claims(value.interpretations),
    limitations: value.limitations.filter(nonempty),
  }
}

function parseSnapshot(value: unknown): Snapshot | undefined {
  if (!isRecord(value) || !isRecord(value.contributors)) return undefined
  const contributors: Record<string, Insight> = Object.create(null)
  for (const [login, item] of Object.entries(value.contributors)) {
    if (!isRecord(item)) continue
    const sources = Array.isArray(item.sources) ? item.sources.flatMap((source): Source[] => {
      if (!isRecord(source) || !nonempty(source.id) || !nonempty(source.title)) return []
      const url = safeUrl(source.url)
      return url ? [{ id: source.id, title: source.title, url, date: typeof source.date === 'string' ? source.date : '' }] : []
    }) : []
    contributors[login] = {
      subjective: parsePerspective(item.subjective),
      business: parsePerspective(item.business),
      sources,
      sample_summary: nonempty(item.sample_summary) ? item.sample_summary : undefined,
    }
  }
  return {
    contributors,
    generated_at: typeof value.generated_at === 'string' ? value.generated_at : undefined,
    window: isRecord(value.window) ? {
      start_date: typeof value.window.start_date === 'string' ? value.window.start_date : undefined,
      end_date: typeof value.window.end_date === 'string' ? value.window.end_date : undefined,
    } : undefined,
    stale: typeof value.stale === 'boolean' ? value.stale : undefined,
  }
}

function dateLabel(value?: string, includeTime = false): string {
  if (!value) return 'Unknown'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Unknown'
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC',
    ...(includeTime ? { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' } : {}),
  }).format(date)
}

function Evidence({ snapshot, person, tab }: { snapshot: Snapshot; person: ActivityPerson; tab: 'subjective' | 'business' }) {
  const insight = snapshot.contributors[person.login]
  const perspective = insight?.[tab]
  // Ambiguous or missing IDs cannot support a displayed claim.
  const sources = new Map<string, Source>()
  const duplicateIds = new Set<string>()
  for (const source of insight?.sources ?? []) {
    if (sources.has(source.id)) duplicateIds.add(source.id)
    sources.set(source.id, source)
  }
  const supported = (claim: Claim) => claim.source_ids.every((id) => sources.has(id) && !duplicateIds.has(id))
  const observations = perspective?.observations.filter(supported) ?? []
  const interpretations = perspective?.interpretations.filter(supported) ?? []
  const omitted = perspective && (observations.length !== perspective.observations.length || interpretations.length !== perspective.interpretations.length)

  const claimList = (claims: Claim[]) => <ul className="evidence-list">{claims.map((claim, index) => <li key={`${index}-${claim.text}`}>
    <span>{claim.text}</span>
    <span className="citations">{claim.source_ids.map((id, sourceIndex) => {
      const source = sources.get(id)!
      return <a key={`${id}-${sourceIndex}`} href={source.url} target="_blank" rel="noopener noreferrer">
        {source.title}{source.date ? ` · ${dateLabel(source.date)}` : ' · Date unknown'} <span aria-hidden="true">↗</span><span className="sr-only"> (opens in a new tab)</span>
      </a>
    })}</span>
  </li>)}</ul>

  return <div className="evidence">
    <p className="ai-notice"><strong>AI-generated interpretation.</strong> Based on sampled public evidence, not a measure of a person’s ability or impact. Citations can be inspected, but do not guarantee a claim is correct.</p>
    <div className="evidence-meta">
      <div><strong>Generated:</strong> {dateLabel(snapshot.generated_at, true)}</div>
      <div><strong>Evidence window:</strong> {dateLabel(snapshot.window?.start_date)} – {dateLabel(snapshot.window?.end_date)} UTC</div>
      <div><strong>Sample:</strong> {insight?.sample_summary ?? 'Unknown'}</div>
      <div><strong>Freshness:</strong> {snapshot.stale === true ? 'Stale snapshot' : snapshot.stale === false ? 'Current snapshot' : 'Unknown'}</div>
    </div>
    {snapshot.stale && <p className="evidence-warning" role="status">This analysis may be out of date.</p>}
    {!insight || !perspective
      ? <p className="evidence-empty"><strong>Unknown.</strong> This perspective is unavailable for this contributor.</p>
      : <>
        {observations.length > 0 && <section><h3>Observed</h3>{claimList(observations)}</section>}
        {interpretations.length > 0 && <section><h3>Interpretation</h3>{claimList(interpretations)}</section>}
        {!observations.length && !interpretations.length && <p className="evidence-empty"><strong>Unknown.</strong> Not enough public evidence to show a supported {tab === 'business' ? 'business connection' : 'contribution story'}.</p>}
        {omitted && <p className="evidence-warning">Some claims were withheld because their sources could not be verified.</p>}
        <section><h3>Unknown &amp; limitations</h3>
          {perspective.limitations.length ? <ul className="limitations">{perspective.limitations.map((limitation, index) => <li key={`${index}-${limitation}`}>{limitation}</li>)}</ul> : <p>Coverage limitations were not provided. Private work and contributions outside this sample are unknown.</p>}
        </section>
      </>}
    <a className="methodology-link" href="#about">View methodology ↓</a>
  </div>
}

export default function ContributorPerspectives({ person, window }: {
  person: ActivityPerson
  window?: { start_date: string; end_date: string }
}) {
  const [tab, setTab] = useState<Tab>('activity')
  const [status, setStatus] = useState<LoadState>('loading')
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [attempt, setAttempt] = useState(0)
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([])

  useEffect(() => {
    const controller = new AbortController()
    setStatus('loading')
    fetch('/api/insights', { signal: controller.signal })
      .then(async (response) => {
        if (response.status === 404) {
          setStatus('unavailable')
          return
        }
        if (!response.ok) throw new Error('Insights unavailable')
        const parsed = parseSnapshot(await response.json())
        if (!parsed) throw new Error('Invalid insights response')
        setSnapshot(parsed)
        setStatus('ready')
      })
      .catch(() => {
        if (!controller.signal.aborted) setStatus('error')
      })
    return () => controller.abort()
  }, [attempt])

  const selectWithKeyboard = (event: React.KeyboardEvent, index: number) => {
    let next = index
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length
    else if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = tabs.length - 1
    else return
    event.preventDefault()
    setTab(tabs[next].id)
    tabRefs.current[next]?.focus()
  }
  const format = (value: number) => new Intl.NumberFormat('en-US', { notation: value >= 10000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(value)

  return <>
    <div className="profile-tabs" role="tablist" aria-label={`Perspectives for ${person.login}`}>
      {tabs.map((item, index) => <button key={item.id} ref={(node) => { tabRefs.current[index] = node }} type="button" role="tab"
        id={`tab-${item.id}`} aria-controls={`panel-${item.id}`} aria-selected={tab === item.id} tabIndex={tab === item.id ? 0 : -1}
        onClick={() => setTab(item.id)} onKeyDown={(event) => selectWithKeyboard(event, index)}>{item.label}</button>)}
    </div>
    {tabs.map((item) => <div key={item.id} id={`panel-${item.id}`} role="tabpanel" aria-labelledby={`tab-${item.id}`} hidden={tab !== item.id} tabIndex={0}>
      {tab === item.id && (item.id === 'activity' ? <>
        <div className="profile-stats"><div><div className="stat-value">{format(person.commits.count)}{person.commits.incomplete ? '*' : ''}</div><div className="stat-label">Commits · 90d</div></div><div><div className="stat-value">{format(person.merged_pull_requests.count)}{person.merged_pull_requests.incomplete ? '*' : ''}</div><div className="stat-label">Merged PRs · 90d</div></div><div><div className="stat-value">{format(person.issues_commented_on.count)}{person.issues_commented_on.incomplete ? '*' : ''}</div><div className="stat-label">Distinct issues commented on · all time</div></div></div>
        <div className="insight"><strong>More than a number.</strong> Recent activity covers {window?.start_date ?? 'an unknown start date'} to {window?.end_date ?? 'an unknown end date'} UTC. * indicates an incomplete GitHub search result. Recent commit search and all-time default-branch commits have different scopes.</div>
        <a className="methodology-link" href="#about">View methodology ↓</a>
      </> : status === 'loading' ? <p className="evidence-empty" role="status">Loading AI-generated insights…</p>
        : status === 'unavailable' ? <p className="evidence-empty" role="status"><strong>Unknown.</strong> AI-generated insights are not available yet.</p>
          : status === 'error' ? <div className="evidence-empty" role="status"><strong>Unknown.</strong> AI-generated insights could not be loaded. Activity remains available. <button className="retry-insights" type="button" onClick={() => setAttempt((value) => value + 1)}>Try again</button></div>
            : snapshot && <Evidence snapshot={snapshot} person={person} tab={item.id} />)}
    </div>)}
  </>
}
