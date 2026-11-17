import { useEffect, useState } from 'react'
import GitScoresPlot, { type GitScore } from './GitScoresPlot'

type ScoreSnapshot = { graphHead: string; graphGeneratedAt: string; scores: GitScore[] }
type State = { status: 'loading' } | { status: 'unavailable' } | { status: 'ready'; snapshot: ScoreSnapshot }
const record = (x: unknown): Record<string, unknown> | null =>
  x !== null && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : null
const score = (x: unknown): x is number | null => x === null ||
  (typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 100)

function parseSnapshot(value: unknown): ScoreSnapshot {
  const data = record(value)
  if (!data || typeof data.graphHead !== 'string' || typeof data.graphGeneratedAt !== 'string' ||
      !Array.isArray(data.scores) || data.scores.length > 20) throw new Error('Invalid score snapshot')
  for (const entry of data.scores) {
    const item = record(entry)
    if (!item || typeof item.authorId !== 'string' || typeof item.name !== 'string' ||
        !Number.isSafeInteger(item.rank) ||
        !(item.commitCount === null || typeof item.commitCount === 'number' && Number.isSafeInteger(item.commitCount) && item.commitCount >= 0) ||
        !score(item.activity) || !score(item.subjective) || !score(item.business)) {
      throw new Error('Invalid score')
    }
  }
  return data as ScoreSnapshot
}

export default function PublishedScores({ graphHead, graphGeneratedAt, onSelect, avatars }: {
  graphHead: string; graphGeneratedAt: string; onSelect: (authorId: string) => void; avatars: Record<string, string>
}) {
  const [state, setState] = useState<State>({ status: 'loading' })
  useEffect(() => {
    const controller = new AbortController()
    setState({ status: 'loading' })
    void (async () => {
      try {
        const response = await fetch('/api/git-scores', { cache: 'no-cache', signal: controller.signal })
        if (!response.ok) throw new Error('Unavailable')
        const snapshot = parseSnapshot(await response.json() as unknown)
        if (!controller.signal.aborted) setState({ status: 'ready', snapshot })
      } catch {
        if (!controller.signal.aborted) setState({ status: 'unavailable' })
      }
    })()
    return () => controller.abort()
  }, [graphHead, graphGeneratedAt])

  if (state.status === 'loading') return <p role="status">Loading published scores…</p>
  if (state.status === 'unavailable') return <p role="status">No reviewed score map is available for this snapshot. The score publication must be reviewed and published for this graph.</p>
  if (state.snapshot.graphHead !== graphHead || state.snapshot.graphGeneratedAt !== graphGeneratedAt) {
    return <p role="status">Published scores belong to a different graph snapshot.</p>
  }
  return <GitScoresPlot scores={state.snapshot.scores} onSelect={onSelect} avatars={avatars} />
}
