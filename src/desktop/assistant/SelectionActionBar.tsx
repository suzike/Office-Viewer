import { useLayoutEffect, useRef, useState } from 'react'

export type SelectionBarAction = 'explain' | 'translate' | 'quote'

interface SelectionActionBarProps {
  readonly text: string
  readonly anchor: { readonly x: number; readonly y: number } | null
  readonly onAction: (action: SelectionBarAction) => void
}

const BAR_WIDTH = 216
const BAR_HEIGHT = 34
const VIEWPORT_MARGIN = 8

/**
 * Floating toolbar shown next to a document text selection: explains, translates
 * or quotes the selection into the assistant panel. Rendered fixed above the
 * document surface; the anchor is the selection midpoint (viewport coordinates).
 */
export function SelectionActionBar({ text, anchor, onAction }: SelectionActionBarProps) {
  const barRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)

  useLayoutEffect(() => {
    if (!anchor || !text) {
      setPosition(null)
      return
    }
    const width = barRef.current?.offsetWidth ?? BAR_WIDTH
    const height = barRef.current?.offsetHeight ?? BAR_HEIGHT
    const left = Math.min(Math.max(anchor.x - width / 2, VIEWPORT_MARGIN), Math.max(VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN))
    const above = anchor.y - height - 10
    const top = above >= VIEWPORT_MARGIN ? above : Math.min(anchor.y + 18, Math.max(VIEWPORT_MARGIN, window.innerHeight - height - VIEWPORT_MARGIN))
    setPosition({ left, top })
  }, [anchor, text])

  if (!text || !anchor) return null

  return (
    <div
      ref={barRef}
      className="assistant-selection-bar"
      role="toolbar"
      aria-label="选区快捷操作"
      style={position ? { left: position.left, top: position.top } : { left: -9999, top: -9999 }}
    >
      <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => onAction('explain')}>解释</button>
      <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => onAction('translate')}>翻译</button>
      <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => onAction('quote')}>引用到助手</button>
    </div>
  )
}
