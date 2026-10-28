import { useState, type ButtonHTMLAttributes, type ReactNode } from 'react'

export type IconName = 'home' | 'compass' | 'heart' | 'thumbUp' | 'thumbDown' | 'bookmark' | 'user' | 'search' | 'plus' | 'arrow' | 'wallet' | 'filter' | 'grid' | 'layers' | 'pixel' | 'activity' | 'bell' | 'check' | 'close' | 'spark' | 'share' | 'copy' | 'more' | 'chevron' | 'settings' | 'comment' | 'image' | 'briefcase' | 'gallery' | 'palette' | 'chart'

const paths: Record<IconName, ReactNode> = {
  home: <><path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1Z" /></>,
  compass: <><circle cx="12" cy="12" r="9" /><path d="m15.5 8.5-2 5-5 2 2-5Z" /></>,
  heart: <path d="M20.8 8.6c0 5.3-8.8 10.1-8.8 10.1S3.2 13.9 3.2 8.6A4.7 4.7 0 0 1 12 6.1a4.7 4.7 0 0 1 8.8 2.5Z" />,
  thumbUp: <><path d="M7 10v11H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2Z" /><path d="M7 10 12 3a3 3 0 0 1 2 3v4h4.5a2.5 2.5 0 0 1 2.4 3.2l-1.8 6A2.5 2.5 0 0 1 18.7 21H7" /></>,
  thumbDown: <><path d="M7 14V3H4a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2Z" /><path d="m7 14 5 7a3 3 0 0 0 2-3v-4h4.5a2.5 2.5 0 0 0 2.4-3.2l-1.8-6A2.5 2.5 0 0 0 18.7 3H7" /></>,
  bookmark: <path d="M6 4.5A1.5 1.5 0 0 1 7.5 3h9A1.5 1.5 0 0 1 18 4.5V21l-6-3.5L6 21Z" />,
  user: <><circle cx="12" cy="8" r="3.5" /><path d="M4.8 20a7.2 7.2 0 0 1 14.4 0" /></>,
  search: <><circle cx="10.8" cy="10.8" r="6.8" /><path d="m16 16 4.5 4.5" /></>,
  plus: <><path d="M12 5v14M5 12h14" /></>,
  arrow: <><path d="M5 12h13M13 7l5 5-5 5" /></>,
  wallet: <><path d="M4 6.5A2.5 2.5 0 0 1 6.5 4H18a2 2 0 0 1 2 2v12.5A1.5 1.5 0 0 1 18.5 20h-12A2.5 2.5 0 0 1 4 17.5Z" /><path d="M4 7h14.5A1.5 1.5 0 0 1 20 8.5V12h-4a2 2 0 0 0 0 4h4" /><circle cx="16" cy="14" r=".7" fill="currentColor" stroke="none" /></>,
  filter: <><path d="M4 6h16M7 12h10M10 18h4" /></>,
  grid: <><rect x="4" y="4" width="6" height="6" rx="1" /><rect x="14" y="4" width="6" height="6" rx="1" /><rect x="4" y="14" width="6" height="6" rx="1" /><rect x="14" y="14" width="6" height="6" rx="1" /></>,
  layers: <><path d="m12 3 9 5-9 5-9-5 9-5Z" /><path d="m3 12 9 5 9-5M3 16l9 5 9-5" /></>,
  pixel: <><rect x="3.5" y="3.5" width="5" height="5" rx=".5" /><rect x="10" y="3.5" width="5" height="5" rx=".5" /><rect x="16.5" y="3.5" width="4" height="5" rx=".5" /><rect x="3.5" y="10" width="5" height="5" rx=".5" /><rect x="16.5" y="10" width="4" height="5" rx=".5" /><rect x="3.5" y="16.5" width="5" height="4" rx=".5" /><rect x="10" y="16.5" width="5" height="4" rx=".5" /><rect x="16.5" y="16.5" width="4" height="4" rx=".5" /></>,
  activity: <><path d="M3 12h4l2.2-6 4.1 12 2.2-6H21" /></>,
  bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" /><path d="M10 21h4" /></>,
  check: <path d="m5 12 4.5 4.5L19 7" />,
  close: <><path d="m6 6 12 12M18 6 6 18" /></>,
  spark: <><path d="m12 2 1.7 6.3L20 10l-6.3 1.7L12 18l-1.7-6.3L4 10l6.3-1.7Z" /><path d="m19 17 .7 2.3L22 20l-2.3.7L19 23l-.7-2.3L16 20l2.3-.7Z" /></>,
  share: <><circle cx="18" cy="5" r="2" /><circle cx="6" cy="12" r="2" /><circle cx="18" cy="19" r="2" /><path d="m8 11 8-5M8 13l8 5" /></>,
  copy: <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" /></>,
  more: <><circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" /></>,
  chevron: <path d="m9 5 7 7-7 7" />,
  settings: <><circle cx="12" cy="12" r="3" /><path d="m19.4 15 .1.1 1.4 1.1-1.4 2.4-1.7-.7a8 8 0 0 1-1.5.9l-.3 1.8h-2.8l-.3-1.8a8 8 0 0 1-1.5-.9l-1.7.7-1.4-2.4 1.4-1.1a7 7 0 0 1 0-1.8l-1.4-1.1 1.4-2.4 1.7.7a8 8 0 0 1 1.5-.9l.3-1.8h2.8l.3 1.8a8 8 0 0 1 1.5.9l1.7-.7 1.4 2.4-1.4 1.1a7 7 0 0 1 0 1.8Z" transform="translate(-1 -1) scale(1.08)" /></>,
  comment: <path d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5H5l1.9-3.1A7.5 7.5 0 1 1 20 11.5Z" />,
  image: <><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="8.5" cy="9" r="1.5" /><path d="m21 15-5-5L5 20" /></>,
  briefcase: <><rect x="3" y="7" width="18" height="14" rx="2" /><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 12h18M10 12v2h4v-2" /></>,
  gallery: <><path d="M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /><path d="M7 17h10M7 14l3-3 2 2 3-4 2 5" /><circle cx="8" cy="8" r="1" /></>,
  palette: <><path d="M12 3a9 9 0 1 0 0 18h1.2a2 2 0 0 0 1.5-3.3 1.8 1.8 0 0 1 1.4-3h1.4A3.5 3.5 0 0 0 21 11.2 8.2 8.2 0 0 0 12 3Z" /><circle cx="7.5" cy="11" r="1" /><circle cx="10" cy="7.5" r="1" /><circle cx="15" cy="8" r="1" /></>,
  chart: <><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></>,
}

export function Icon({ name, size = 20, strokeWidth = 1.8 }: { name: IconName; size?: number; strokeWidth?: number }) {
  return <svg aria-hidden="true" className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>
}

export function PrismMark({ small = false, size, className = '' }: { small?: boolean; size?: number; className?: string }) {
  return <img className={`stellanova-mark ${small ? 'stellanova-mark--small' : ''} ${className}`} src="/icon-512.png" width={size ?? (small ? 29 : 36)} height={size ?? (small ? 29 : 36)} alt="" aria-hidden="true" />
}

export function mediaSource(src: string) {
  if (import.meta.env.DEV && /^https:\/\/res\.cloudinary\.com\//i.test(src)) {
    return `/api/media/proxy?url=${encodeURIComponent(src)}`
  }
  return src
}

export function Avatar({ src, alt, size = 'md', ring = false }: { src: string; alt: string; size?: 'xs' | 'sm' | 'md' | 'lg'; ring?: boolean }) {
  const className = `avatar avatar--${size} ${ring ? 'avatar--ring' : ''}`
  const [failed, setFailed] = useState(false)
  if (!src || failed) {
    const initials = alt.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase()
    return <span className={`${className} avatar--fallback`} role="img" aria-label={alt}>{initials}</span>
  }
  return <img className={className} src={mediaSource(src)} alt={alt} onError={(event) => {
    const image = event.currentTarget
    if (!image.dataset.proxyAttempted && /^https:\/\/res\.cloudinary\.com\//i.test(image.src)) {
      image.dataset.proxyAttempted = 'true'
      image.src = `/api/media/proxy?url=${encodeURIComponent(image.src)}`
      return
    }
    setFailed(true)
  }} />
}

export function Verified() {
  return <span className="verified" aria-label="Verified creator"><Icon name="check" size={12} strokeWidth={2.5} /></span>
}

export function Button({ children, variant = 'primary', className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'quiet' | 'outline' | 'icon'; children: ReactNode }) {
  return <button className={`button button--${variant} ${className}`} {...props}>{children}</button>
}

export function Toast({ children }: { children: ReactNode }) {
  return <div className="toast" role="status" aria-live="polite" aria-atomic="true"><span className="toast__icon" aria-hidden="true"><Icon name="check" size={16} /></span><span className="toast__message">{children}</span></div>
}

export function Meta({ label, value, onClick }: { label: string; value: string; onClick?: () => void }) {
  return <div className="meta-item"><small>{label}</small>{onClick ? <button onClick={onClick}>{value} <Icon name="chevron" size={12} /></button> : <b>{value}</b>}</div>
}
