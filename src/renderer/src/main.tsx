import React from 'react'
import ReactDOM from 'react-dom/client'
import '@fontsource-variable/inter'
import './styles.css'
import App from './App'
import { track } from './lib/telemetry'

// report the first few renderer errors of a session (message only, no paths)
let reported = 0
const report = (msg: unknown) => {
  if (reported++ < 5) track('error', { msg: String(msg).slice(0, 120), where: 'renderer', screen: (location.hash.slice(1) || '/').split(/[/?]/)[1] || 'home' })
}
addEventListener('error', (e) => report(e.message))
addEventListener('unhandledrejection', (e) => report((e.reason && e.reason.message) || e.reason))

ReactDOM.createRoot(document.getElementById('root')!).render(<App />)
