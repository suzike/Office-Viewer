import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement>

const base = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
}

export function AppMark({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 28 28" aria-hidden="true">
      <path fill="currentColor" d="M3 3h22v22H3z" />
      <path fill="var(--mark-cut)" d="M8 8h12v3H8zm0 5h8v3H8zm0 5h12v3H8z" />
    </svg>
  )
}

export function FolderIcon(props: IconProps) {
  return <svg {...base} {...props}><path d="M3.5 6.5h6l2 2h9v9.7a1.8 1.8 0 0 1-1.8 1.8H5.3a1.8 1.8 0 0 1-1.8-1.8z" /><path d="M3.5 10h17" /></svg>
}

export function ClockIcon(props: IconProps) {
  return <svg {...base} {...props}><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3.2 2" /></svg>
}

export function SunIcon(props: IconProps) {
  return <svg {...base} {...props}><circle cx="12" cy="12" r="3.4" /><path d="M12 2.8v2M12 19.2v2M2.8 12h2M19.2 12h2M5.5 5.5l1.4 1.4M17.1 17.1l1.4 1.4M18.5 5.5l-1.4 1.4M6.9 17.1l-1.4 1.4" /></svg>
}

export function MoonIcon(props: IconProps) {
  return <svg {...base} {...props}><path d="M19.5 15.1A8.4 8.4 0 0 1 8.9 4.5 8.4 8.4 0 1 0 19.5 15z" /></svg>
}

export function CloseIcon(props: IconProps) {
  return <svg {...base} {...props}><path d="m7 7 10 10M17 7 7 17" /></svg>
}

export function MinusIcon(props: IconProps) {
  return <svg {...base} {...props}><path d="M6 12h12" /></svg>
}

export function MaximizeIcon(props: IconProps) {
  return <svg {...base} {...props}><rect x="6.5" y="6.5" width="11" height="11" /></svg>
}

export function MoreIcon(props: IconProps) {
  return <svg {...base} {...props}><circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" /></svg>
}

export function FileIcon(props: IconProps) {
  return <svg {...base} {...props}><path d="M6 3.5h7l5 5v12H6z" /><path d="M13 3.5v5h5" /></svg>
}

export function WarningIcon(props: IconProps) {
  return <svg {...base} {...props}><path d="M12 3.5 21 20H3z" /><path d="M12 9v5M12 17.5v.1" /></svg>
}

export function ReloadIcon(props: IconProps) {
  return <svg {...base} {...props}><path d="M19 8V4.5l-2 2A8 8 0 1 0 19.7 15" /><path d="M19 4.5h-3.5" /></svg>
}

export function ChevronIcon(props: IconProps) {
  return <svg {...base} {...props}><path d="m9 7 5 5-5 5" /></svg>
}
