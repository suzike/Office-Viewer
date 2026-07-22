import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { DesktopApp } from './DesktopApp'
import { initI18n } from '../react/i18n/i18nConfig'
import './styles.css'

initI18n(navigator.language)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <DesktopApp />
  </StrictMode>,
)
