declare module 'plotly.js-basic-dist-min' {
  const Plotly: {
    react: (element: HTMLElement, data: unknown[], layout: Record<string, unknown>, config: Record<string, unknown>) => Promise<unknown>
  }
  export default Plotly
}
