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

export function AssistantMark(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M6.5 5.5h11v10h-6l-3.7 3v-3H6.5z" />
      <path d="M9 9.2h6M9 12h4" />
      <path d="M18.8 3v3.4M17.1 4.7h3.4" />
    </svg>
  )
}

export function CollapseIcon(props: IconProps) {
  return <svg {...base} {...props}><path d="m8 9 4 4 4-4" /></svg>
}

export function SendIcon(props: IconProps) {
  return <svg {...base} {...props}><path d="m4 4 16 8-16 8 3-8zM7 12h13" /></svg>
}

export function StopIcon(props: IconProps) {
  return <svg {...base} {...props}><rect x="7" y="7" width="10" height="10" /></svg>
}

export function ClearIcon(props: IconProps) {
  return <svg {...base} {...props}><path d="M5 7h14M9 4h6l1 3H8zM8 10v7M12 10v7M16 10v7M7 7l1 13h8l1-13" /></svg>
}

export function SettingsIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19 13.6v-3.2l-2-.5a7 7 0 0 0-.7-1.6l1-1.8-2.3-2.3-1.8 1a7 7 0 0 0-1.6-.7L11.1 2H8l-.5 2.5a7 7 0 0 0-1.6.7l-1.8-1L1.8 6.5l1 1.8a7 7 0 0 0-.7 1.6l-2 .5v3.2l2 .5a7 7 0 0 0 .7 1.6l-1 1.8 2.3 2.3 1.8-1a7 7 0 0 0 1.6.7L8 22h3.1l.5-2.5a7 7 0 0 0 1.6-.7l1.8 1 2.3-2.3-1-1.8a7 7 0 0 0 .7-1.6z" transform="translate(2) scale(.83)" />
    </svg>
  )
}

export function SparkIcon(props: IconProps) {
  return <svg {...base} {...props}><path d="m12 3 1.4 4.1L17.5 8.5l-4.1 1.4L12 14l-1.4-4.1-4.1-1.4 4.1-1.4zM18.5 14.5l.7 2.1 2.1.7-2.1.7-.7 2.1-.7-2.1-2.1-.7 2.1-.7zM6 15l1 2.8 2.8 1L7 20l-1 2.8L5 20l-2.8-1L5 17.8z" /></svg>
}

export function WarningIcon(props: IconProps) {
  return <svg {...base} {...props}><path d="M12 3.5 21 20H3z" /><path d="M12 9v5M12 17.5v.1" /></svg>
}

export function DocumentIcon(props: IconProps) {
  return <svg {...base} {...props}><path d="M6 3.5h7l5 5v12H6z" /><path d="M13 3.5v5h5M9 13h6M9 16h4" /></svg>
}

export function CopyIcon(props: IconProps) {
  return <svg {...base} {...props}><rect x="8" y="8" width="11" height="11" /><path d="M16 8V5H5v11h3" /></svg>
}

export function DownloadIcon(props: IconProps) {
  return <svg {...base} {...props}><path d="M12 4v11m0 0 4.5-4.5M12 15l-4.5-4.5M4.5 19.5h15" /></svg>
}

export function RegenerateIcon(props: IconProps) {
  return <svg {...base} {...props}><path d="M19 12a7 7 0 1 1-2.05-4.95M19 3.5V8h-4.5" /></svg>
}

export function EditIcon(props: IconProps) {
  return <svg {...base} {...props}><path d="M14.5 4.5 19.5 9.5 8 21H3v-5zM12.5 6.5l5 5" /></svg>
}
