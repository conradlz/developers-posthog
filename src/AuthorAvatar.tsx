import { useState } from 'react'
import './AuthorAvatar.css'

export default function AuthorAvatar({ name, data, large = false }: { name: string; data?: string; large?: boolean }) {
  const [failedData, setFailedData] = useState<string | null>(null)
  const valid = data && data !== failedData && data.length <= 175000 &&
    /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(data)
  const initials = name.trim().split(/\s+/u).slice(0, 2).map(part => Array.from(part)[0] || '').join('').toLocaleUpperCase() || '?'
  return <span className={`author-avatar${large ? ' author-avatar--large' : ''}`} aria-hidden="true">
    {valid ? <img src={data} alt="" loading="lazy" onError={() => setFailedData(data)} /> : initials}
  </span>
}
