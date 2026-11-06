import { useEffect, useState } from 'react'
import Home from './pages/Home'
import Editor from './pages/Editor'
import Shot from './pages/Shot'
import ControlBar from './pages/ControlBar'
import Countdown from './pages/Countdown'
import AreaPicker from './pages/AreaPicker'
import { TooltipProvider } from './components/ui/tooltip'
import { AccountPanel, LicenseGate, UpdateToast } from './components/Account'
import { Titlebar, LogoMark, Wordmark } from './components/Brand'
import { ChevronLeft } from 'lucide-react'
import { ProCelebration, ProTag } from './components/Pro'
import { FeedbackDialog } from './components/Feedback'
import { startAgentListener } from './lib/agent'
import { Tour } from './components/Tour'
import { ErrorBoundary } from './components/ErrorBoundary'

function useHashRoute() {
  const [hash, setHash] = useState(location.hash.slice(1) || '/')
  useEffect(() => {
    const on = () => setHash(location.hash.slice(1) || '/')
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return hash
}

export const navigate = (route: string) => (location.hash = route)

export default function App() {
  const route = useHashRoute()
  const [path, query] = route.split('?')
  const params = new URLSearchParams(query)
  if (path === '/controlbar') return <ControlBar start={Number(params.get('start'))} />
  if (path === '/countdown') return <Countdown n={Number(params.get('n') || 3)} />
  if (path === '/area') {
    let cur = null
    try {
      cur = JSON.parse(params.get('cur') || 'null')
    } catch {}
    return <AreaPicker W={Number(params.get('w'))} H={Number(params.get('h'))} sf={Number(params.get('sf') || 1)} initial={cur} />
  }
  return (
    <TooltipProvider delayDuration={250}>
      <div key={path.startsWith('/editor/') ? path : path} className="page-in h-full">
        <ErrorBoundary screen={path.startsWith('/editor/') ? 'editor' : path === '/account' ? 'account' : path === '/shot' ? 'shot' : 'home'}>
          {path.startsWith('/editor/') ? <Editor id={decodeURIComponent(path.slice(8))} /> : path === '/account' ? <AccountPage /> : path === '/shot' ? <Shot /> : <Home />}
        </ErrorBoundary>
      </div>
      <LicenseGate />
      <UpdateToast />
      <Tour />
      <FeedbackDialog />
      <ProCelebration />
      <AgentBridge />
    </TooltipProvider>
  )
}

/** Runs AI agent tool calls (only in the main window; see lib/agent.ts). */
function AgentBridge() {
  useEffect(() => {
    const off = startAgentListener()
    return () => {
      off()
    }
  }, [])
  return null
}

function AccountPage() {
  return (
    <div className="flex h-full flex-col bg-ink-950">
      <Titlebar>
        <button className="no-drag -ml-1 flex h-8 items-center gap-1 rounded-lg px-2 text-[12.5px] text-zinc-400 hover:bg-white/[0.06] hover:text-white" onClick={() => history.length > 1 ? history.back() : navigate('/')}>
          <ChevronLeft className="h-4 w-4" /> Back
        </button>
        <div className="h-4 w-px bg-white/10" />
        <LogoMark className="h-[20px] w-[20px]" />
        <Wordmark className="text-[13px]" />
        <ProTag />
      </Titlebar>
      <div className="relative min-h-0 flex-1 overflow-y-auto px-6 py-10">
        <div className="aurora-a pointer-events-none absolute left-1/2 top-0 h-[360px] w-[700px] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,rgba(139,92,246,.12),transparent)]" />
        <div className="relative">
          <AccountPanel />
        </div>
      </div>
    </div>
  )
}
