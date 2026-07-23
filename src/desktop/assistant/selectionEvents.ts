/**
 * Cross-viewer selection bus: iframe-based viewers (HTML preview, Markdown editor)
 * cannot share a DOM selection with the shell window, so they forward the selected
 * text plus an anchor point through this CustomEvent. The assistant controller
 * listens here in addition to the native `selectionchange` event.
 */
export const ASSISTANT_SELECTION_EVENT = 'office-assistant-selection'

export interface AssistantSelectionDetail {
  text: string
  x?: number
  y?: number
}

export function publishAssistantSelection(detail: AssistantSelectionDetail): void {
  window.dispatchEvent(new CustomEvent<AssistantSelectionDetail>(ASSISTANT_SELECTION_EVENT, { detail }))
}

export function subscribeAssistantSelection(listener: (detail: AssistantSelectionDetail) => void): () => void {
  const wrapped = (event: Event) => listener((event as CustomEvent<AssistantSelectionDetail>).detail ?? { text: '' })
  window.addEventListener(ASSISTANT_SELECTION_EVENT, wrapped)
  return () => window.removeEventListener(ASSISTANT_SELECTION_EVENT, wrapped)
}
