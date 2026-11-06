import { Component, type ReactNode } from 'react'
import { RotateCcw, Home as HomeIcon } from 'lucide-react'
import { track } from '@/lib/telemetry'

/**
 * If a screen throws while rendering, show a calm recovery card instead of a blank
 * window, and report it (message + screen only) so it shows up in the health stats.
 */
export class ErrorBoundary extends Component<{ children: ReactNode; screen: string }, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error) {
    track('error', { msg: String(error?.message ?? error).slice(0, 120), where: 'render', screen: this.props.screen })
  }

  componentDidUpdate(prev: { screen: string }) {
    // moving to another screen gives it a fresh start
    if (prev.screen !== this.props.screen && this.state.error) this.setState({ error: null })
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="grid h-full place-items-center bg-ink-950 px-6 text-center">
        <div className="max-w-[420px]">
          <div className="text-[15px] font-semibold text-zinc-100">Something went wrong on this screen</div>
          <div className="mt-1.5 text-[12.5px] leading-relaxed text-zinc-400">Your projects are saved. Try again, or head home and reopen it. If it keeps happening, send us a note from the help menu.</div>
          <div className="mt-2 truncate font-mono text-[10.5px] text-zinc-600">{String(this.state.error.message || this.state.error)}</div>
          <div className="mt-5 flex justify-center gap-2">
            <button onClick={() => this.setState({ error: null })} className="flex h-8 items-center gap-1.5 rounded-lg bg-white px-3 text-[12.5px] font-medium text-black hover:bg-zinc-200">
              <RotateCcw className="h-3.5 w-3.5" /> Try again
            </button>
            <button
              onClick={() => {
                this.setState({ error: null })
                location.hash = '/'
              }}
              className="flex h-8 items-center gap-1.5 rounded-lg border border-white/10 px-3 text-[12.5px] text-zinc-200 hover:bg-white/[0.06]"
            >
              <HomeIcon className="h-3.5 w-3.5" /> Home
            </button>
          </div>
        </div>
      </div>
    )
  }
}
