import { useEffect, useRef } from 'react'

type Props = { names: string[]; values: number[]; label: string }

export default function ActivityChart({ names, values, label }: Props) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let disposed = false
    const node = ref.current
    if (!node || !values.length) return
    import('plotly.js-basic-dist-min').then(({ default: Plotly }) => {
      if (disposed) return
      Plotly.react(node, [{
        x: names,
        y: values,
        type: 'bar',
        marker: { color: values.map((_, i) => i === 0 ? '#849f7e' : '#dce8d8'), line: { width: 0 } },
        hovertemplate: '%{x}<br>%{y:,} ' + label.toLowerCase() + '<extra></extra>',
      }], {
        autosize: true,
        margin: { l: 38, r: 5, t: 12, b: 33 },
        paper_bgcolor: 'transparent',
        plot_bgcolor: 'transparent',
        font: { family: 'DM Sans, sans-serif', size: 9, color: '#a2aea0' },
        xaxis: { showgrid: false, tickfont: { size: 9 }, fixedrange: true },
        yaxis: { gridcolor: '#f0f3ed', zeroline: false, nticks: 4, fixedrange: true },
        bargap: 0.55,
        hoverlabel: { bgcolor: '#26322b', font: { color: '#fff' } },
      }, { responsive: true, displayModeBar: false })
    }).catch(() => {
      if (node && !disposed) node.textContent = 'Chart unavailable.'
    })
    return () => { disposed = true }
  }, [names, values, label])

  return <div ref={ref} className="chart" aria-label={`Bar chart comparing ${label.toLowerCase()} among contributors`} role="img" />
}
