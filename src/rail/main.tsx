import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './rail.css'
import RailApp from './RailApp.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RailApp />
  </StrictMode>
)
