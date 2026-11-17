import { useEffect, useState } from 'react'

type Statement = { text: string; sourceIds: string[] }
type Section = { observations: Statement[]; interpretations: Statement[]; limitations: string[] }
type Source = { id: string; title: string; url: string; date: string }
type Assessment = { algorithmic: Statement; subjective: Section; business: Section; sources: Source[] }
type Snapshot = { graphHead: string; graphGeneratedAt: string; generatedAt: string; assessments: Record<string, Assessment> }
type State = { status: 'loading' } | { status: 'error' } | { status: 'ready'; snapshot: Snapshot }

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(text)
const statement = (value: unknown): value is Statement => {
  const item = record(value)
  return !!item && text(item.text) && strings(item.sourceIds)
}
const section = (value: unknown): value is Section => {
  const item = record(value)
  return !!item && Array.isArray(item.observations) && item.observations.every(statement) &&
    Array.isArray(item.interpretations) && item.interpretations.every(statement) && strings(item.limitations)
}

function parseSnapshot(value: unknown): Snapshot {
  const data = record(value)
  const entries = record(data?.assessments)
  if (!data || !text(data.graphHead) || !text(data.graphGeneratedAt) || !text(data.generatedAt) || !entries ||
      !/(?:Z|[+-]\d{2}:\d{2})$/i.test(data.generatedAt) || !Number.isFinite(Date.parse(data.generatedAt))) {
    throw new Error('Invalid assessment snapshot')
  }
  for (const [id, value] of Object.entries(entries)) {
    const item = record(value)
    if (!text(id) || !item || !statement(item.algorithmic) || !section(item.subjective) || !section(item.business) ||
        !Array.isArray(item.sources) || !item.sources.every((value: unknown) => {
          const source = record(value)
          return !!source && text(source.id) && text(source.title) && text(source.url) && text(source.date)
        }) || new Set(item.sources.map((source: Source) => source.id)).size !== item.sources.length) {
      throw new Error('Invalid assessment record')
    }
  }
  return data as Snapshot
}

function safeUrl(value: string): string | undefined {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined
  } catch { return undefined }
}

function Citations({ ids, sources }: { ids: string[]; sources: Source[] }) {
  if (!ids.length) return <span className="git-citations"> No sources provided.</span>
  return <span className="git-citations"> Sources: {ids.map((id, index) => {
    const source = sources.find((item) => item.id === id)
    const href = source && safeUrl(source.url)
    return <span key={`${id}-${index}`}>{index > 0 && '; '}{source
      ? href ? <a href={href} target="_blank" rel="noopener noreferrer">{source.title} ({source.date})</a>
        : <span>{source.title} ({source.date}; link unavailable)</span>
      : <span>Unknown source ({id})</span>}</span>
  })}.</span>
}

function Statements({ title, items, sources }: { title: string; items: Statement[]; sources: Source[] }) {
  return <div><h5>{title}</h5>{items.length
    ? <ul>{items.map((item, index) => <li key={index}>{item.text}<Citations ids={item.sourceIds} sources={sources} /></li>)}</ul>
    : <p>None provided.</p>}</div>
}

function AssessmentSection({ title, section, sources }: { title: string; section: Section; sources: Source[] }) {
  return <section className="git-assessment-section"><h4>{title}</h4>
    <Statements title="Observed" items={section.observations} sources={sources} />
    <Statements title="Interpreted" items={section.interpretations} sources={sources} />
    <div><h5>Limitations</h5>{section.limitations.length
      ? <ul>{section.limitations.map((item, index) => <li key={index}>{item}</li>)}</ul>
      : <p>None provided.</p>}</div>
  </section>
}

export default function GitAssessments({ graphHead, graphGeneratedAt, authorId, authorName, authorRank, now }: {
  graphHead: string; graphGeneratedAt: string; authorId?: string; authorName?: string; authorRank: number; now: number
}) {
  const [state, setState] = useState<State>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    setState({ status: 'loading' })
    async function load() {
      try {
        const response = await fetch('/api/git-assessments', { signal: controller.signal, cache: 'no-cache' })
        if (!response.ok) throw new Error('Assessment service unavailable')
        const snapshot = parseSnapshot(await response.json() as unknown)
        if (!controller.signal.aborted) setState({ status: 'ready', snapshot })
      } catch {
        if (!controller.signal.aborted) setState({ status: 'error' })
      }
    }
    void load()
    return () => controller.abort()
  }, [attempt, graphHead, graphGeneratedAt])

  const snapshot = state.status === 'ready' ? state.snapshot : null
  const assessment = snapshot && authorId && Object.prototype.hasOwnProperty.call(snapshot.assessments, authorId) ? snapshot.assessments[authorId] : undefined
  const assessmentTime = snapshot ? Date.parse(snapshot.generatedAt) : NaN
  const graphTime = Date.parse(graphGeneratedAt)
  const assessmentAge = Number.isFinite(assessmentTime) && assessmentTime <= now ? now - assessmentTime : null
  const graphAge = /(?:Z|[+-]\d{2}:\d{2})$/i.test(graphGeneratedAt) && Number.isFinite(graphTime) && graphTime <= now ? now - graphTime : null

  return <section className="git-assessments" aria-labelledby="assessment-title">
    <div className="git-section-heading"><div><div className="git-label">PUBLISHED ASSESSMENTS</div>
      <h2 id="assessment-title">Assessment for {authorName ?? 'selected Git author'}</h2>
      <p>For the top 20 Git authors by non-merge commits. Git authors may include bot accounts and are not necessarily individual people.</p>
    </div><span className="git-badge">AI-GENERATED</span></div>
    <div className="git-assessment-body" aria-live="polite">
      {state.status === 'loading' && <p role="status">Loading published assessments…</p>}
      {state.status === 'error' && <div role="status"><p>Published assessments are unavailable or invalid. The Git history explorer remains available.</p><button type="button" onClick={() => setAttempt((value) => value + 1)}>Retry assessments</button></div>}
      {snapshot && (snapshot.graphHead !== graphHead || snapshot.graphGeneratedAt !== graphGeneratedAt) && <p role="status">Assessments are for a different Git graph snapshot and are hidden. No matching published assessment is available for this graph.</p>}
      {snapshot && snapshot.graphHead === graphHead && snapshot.graphGeneratedAt === graphGeneratedAt && <>
        <p className="git-assessment-meta">Assessment snapshot generated <time dateTime={snapshot.generatedAt}>{new Date(assessmentTime).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC')}</time>.
          {' '}{assessmentAge === null ? 'Assessment freshness unknown.' : assessmentAge >= 12 * 60 * 60 * 1000 ? 'Assessment snapshot is at least 12 hours old.' : 'Assessment snapshot is within 12 hours.'}
          {' '}{graphAge === null ? 'Graph freshness unknown.' : graphAge >= 12 * 60 * 60 * 1000 ? 'The matching graph snapshot is at least 12 hours old.' : 'The matching graph snapshot is within 12 hours.'}</p>
        {!authorId ? <p>Select a Git author to view their assessment.</p>
          : authorRank < 0 || authorRank >= 20 ? <p>Assessments are only shown for the top 20 Git authors in this graph.</p>
          : !assessment ? <p>No published assessment is available for this Git author in the matching snapshot.</p>
          : <>
            <p className="git-assessment-notice">AI-generated content can be incomplete or incorrect. Interpretations are not established facts; review the cited evidence and limitations.</p>
            <section className="git-assessment-section"><h4>Algorithmic explanation</h4><p>{assessment.algorithmic.text} Derived from the full graph snapshot.</p></section>
            <div className="git-assessment-grid">
              <AssessmentSection title="Subjective assessment" section={assessment.subjective} sources={assessment.sources} />
              <AssessmentSection title="Business assessment" section={assessment.business} sources={assessment.sources} />
            </div>
          </>}
      </>}
    </div>
  </section>
}
