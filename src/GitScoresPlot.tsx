import { useEffect, useId, useMemo, useRef, useState } from 'react'
import AuthorAvatar from './AuthorAvatar'
import './GitScoresPlot.css'

export type GitScore = {
  authorId: string
  name: string
  rank: number
  commitCount: number | null
  activity: number | null
  subjective: number | null
  business: number | null
}

export type GitScoresPlotProps = {
  scores: GitScore[]
  onSelect: (authorId: string) => void
  avatars: Record<string, string>
}

type Metric = 'activity' | 'subjective' | 'business'
const metricKeys: Metric[] = ['activity', 'subjective', 'business']
const metrics: Record<Metric, string> = {
  activity: 'Activity',
  subjective: 'Subjective',
  business: 'Business',
}

function validScore(value: number | null): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
}

function validCount(value: number | null): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function formatScore(value: number | null): string {
  return validScore(value) ? String(Number(value.toFixed(2))) : 'Missing'
}

// Plotly interprets a subset of HTML in text and hover labels.
function escapePlotText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

type PlotEvent = { points?: { pointNumber?: number }[] }
type PlotElement = HTMLDivElement & {
  on: (event: string, handler: (event: PlotEvent) => void) => void
}
type PlotlyApi = {
  react: (element: HTMLElement, data: unknown[], layout: Record<string, unknown>, config: Record<string, unknown>) => Promise<unknown>
  purge: (element: HTMLElement) => void
  Plots: { resize: (element: HTMLElement) => Promise<unknown> }
}

function ScoreChart({ authors, metric, onSelect }: {
  authors: GitScore[]
  metric: Metric
  onSelect: (authorId: string) => void
}) {
  const chartRef = useRef<HTMLDivElement>(null)
  const queue = useRef<Promise<void>>(Promise.resolve())
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')

  useEffect(() => {
    const element = chartRef.current
    if (!element) return
    let disposed = false
    let observer: ResizeObserver | undefined
    let plotly: PlotlyApi | undefined
    setStatus('loading')

    // Serialize renders and cleanup, including under React Strict Mode.
    queue.current = queue.current.catch(() => {}).then(async () => {
      if (disposed) return
      try {
        plotly = (await import('plotly.js-basic-dist-min')).default as PlotlyApi
        if (disposed) return
        const maxCommits = Math.max(0, ...authors.map((author) => author.commitCount ?? 0))
        await plotly.react(element, [{
          type: 'scatter', mode: 'markers+text',
          x: authors.map((author) => author.commitCount),
          y: authors.map((author) => author[metric]),
          text: authors.map((author) => escapePlotText(author.name)),
          textposition: authors.map((author) => (author.commitCount ?? 0) > maxCommits * 0.8 ? 'top left' : 'top right'),
          textfont: { color: '#526b59', size: 10 },
          marker: { color: '#5c8b6c', size: 11, line: { color: '#ffffff', width: 2 } },
          customdata: authors.map((author) => [escapePlotText(author.name), author.rank]),
          hovertemplate: `<b>%{customdata[0]}</b><br>Rank %{customdata[1]}<br>Commits: %{x:,}<br>${metrics[metric]}: %{y:.2f}<extra></extra>`,
          cliponaxis: true,
        }], {
          autosize: true, height: 390,
          margin: { l: 62, r: 35, t: 30, b: 65 },
          paper_bgcolor: '#fbfcfa', plot_bgcolor: '#fbfcfa',
          font: { family: 'inherit', color: '#667a6a', size: 11 },
          hovermode: 'closest', showlegend: false,
          xaxis: { title: { text: 'Commit count' }, rangemode: 'tozero', gridcolor: '#e8eee6', zerolinecolor: '#cbd9ca', automargin: true },
          yaxis: { title: { text: `${metrics[metric]} score` }, range: [0, 100], dtick: 20, gridcolor: '#e8eee6', zerolinecolor: '#cbd9ca', automargin: true },
        }, { displayModeBar: false, responsive: false, displaylogo: false })
        if (disposed) {
          plotly.purge(element)
          return
        }
        ;(element as PlotElement).on('plotly_click', (event) => {
          const index = event.points?.[0]?.pointNumber
          if (typeof index === 'number' && authors[index]) onSelect(authors[index].authorId)
        })
        if (typeof ResizeObserver !== 'undefined') {
          observer = new ResizeObserver(() => {
            if (!disposed && element.clientWidth > 0) void plotly?.Plots.resize(element).catch(() => {})
          })
          observer.observe(element)
        } else {
          window.addEventListener('resize', resize)
        }
        setStatus('ready')
      } catch {
        if (!disposed) setStatus('error')
      }
    })
    function resize() {
      if (!disposed && element && element.clientWidth > 0) void plotly?.Plots.resize(element).catch(() => {})
    }
    return () => {
      disposed = true
      observer?.disconnect()
      window.removeEventListener('resize', resize)
      queue.current = queue.current.catch(() => {}).then(() => {
        if (plotly) plotly.purge(element)
      })
    }
  }, [authors, metric, onSelect])

  return <div className="git-scores-chart-wrap">
    <div ref={chartRef} className="git-scores-chart" role="img" aria-label={`${metrics[metric]} score by commit count. The table below provides the same data and author selection.`} />
    {status === 'loading' && <p className="git-scores-chart-message" role="status">Loading chart…</p>}
    {status === 'error' && <p className="git-scores-chart-message" role="status">The chart could not be loaded. Use the table below to explore and select authors.</p>}
    {status === 'ready' && authors.length === 0 && <p className="git-scores-chart-message">No authors have a valid commit count and score for this view.</p>}
  </div>
}

export default function GitScoresPlot({ scores, onSelect, avatars }: GitScoresPlotProps) {
  const titleId = useId()
  const descriptionId = useId()
  const tabId = useId()
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([])
  const [metric, setMetric] = useState<Metric>('activity')
  const authors = useMemo(() => [...scores].sort((a, b) => a.rank - b.rank).slice(0, 20), [scores])
  const plotted = useMemo(() => authors.filter((author) => validCount(author.commitCount) && validScore(author[metric])), [authors, metric])
  const omitted = authors.length - plotted.length

  return <section className="git-scores" aria-labelledby={titleId}>
    <header className="git-scores-header">
      <div>
        <div className="git-scores-eyebrow">EXPERIMENTAL EXPLORER</div>
        <h2 id={titleId}>Git author score map</h2>
        <p id={descriptionId}>Explore published, approved assessments of Git author activity. Authors can include bots and are not necessarily individual people.</p>
      </div>
      <span className="git-scores-badge">TOP 20 AUTHORS</span>
    </header>

    <div className="git-scores-tabs" role="tablist" aria-label="Score view">
      {metricKeys.map((key, index) => <button
        key={key} ref={(element) => { tabRefs.current[index] = element }}
        type="button" role="tab" id={`${tabId}-${key}`} aria-controls={`${tabId}-panel`}
        aria-selected={metric === key} tabIndex={metric === key ? 0 : -1}
        onClick={() => setMetric(key)}
        onKeyDown={(event) => {
          let next = index
          if (event.key === 'ArrowRight') next = (index + 1) % metricKeys.length
          else if (event.key === 'ArrowLeft') next = (index + metricKeys.length - 1) % metricKeys.length
          else if (event.key === 'Home') next = 0
          else if (event.key === 'End') next = metricKeys.length - 1
          else return
          event.preventDefault()
          setMetric(metricKeys[next])
          tabRefs.current[next]?.focus()
        }}
      >{metrics[key]}</button>)}
    </div>

    <div role="tabpanel" id={`${tabId}-panel`} aria-labelledby={`${tabId}-${metric}`} aria-describedby={descriptionId}>
      <div className="git-scores-chart-heading">
        <div><h3>{metrics[metric]} score vs. commits</h3><p>Each point represents a Git author.</p></div>
        <span><i className="git-scores-swatch" /> Author</span>
      </div>
      <ScoreChart authors={plotted} metric={metric} onSelect={onSelect} />
      <p className="git-scores-note">{plotted.length} of {authors.length} authors plotted.
        {omitted > 0 && ` ${omitted} omitted because the commit count or selected score is missing or invalid.`}
        {' '}Hover for details or click a point to select an author. Use the table to select any author with a keyboard, including overlapping or omitted points.
      </p>
    </div>

    <div className="git-scores-methodology">
      <strong>About these scores</strong>
      <p>Activity is activity-weighted and cohort-scaled. Subjective and business scores are AI-estimated, activity-weighted sampled-path proxies—not measures of actual code quality or business impact. Scores are relative to this cohort and do not capture all work.</p>
      <p>{authors.filter((author) => !validScore(author.subjective) || !validScore(author.business)).length} authors have at least one unavailable AI-weighted score. Missing or invalid values are shown as missing, never fabricated or replaced with zero.</p>
    </div>

    <div className="git-scores-table-wrap">
      <table className="git-scores-table">
        <caption>Author scores and selection</caption>
        <thead><tr><th scope="col">Rank</th><th scope="col">Author</th><th scope="col">Commits</th>{metricKeys.map((key) => <th key={key} scope="col">{metrics[key]}</th>)}<th scope="col">Chart</th></tr></thead>
        <tbody>{authors.map((author) => <tr key={author.authorId}>
          <td>{author.rank}</td>
          <td><button type="button" onClick={() => onSelect(author.authorId)} aria-label={`Select ${author.name}, rank ${author.rank}`}><AuthorAvatar name={author.name} data={avatars[author.authorId]} /> {author.name}</button></td>
          <td>{validCount(author.commitCount) ? author.commitCount.toLocaleString() : 'Missing'}</td>
          {metricKeys.map((key) => <td key={key}>{formatScore(author[key])}</td>)}
          <td>{validCount(author.commitCount) && validScore(author[metric]) ? 'Plotted' : 'Not plotted'}</td>
        </tr>)}</tbody>
      </table>
      {!authors.length && <p className="git-scores-table-empty">No published author scores available.</p>}
    </div>
  </section>
}
