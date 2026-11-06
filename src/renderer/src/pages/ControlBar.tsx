import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { Square, X } from 'lucide-react'
import { fmtTime, modKey } from '@/lib/utils'
import { LogoMark } from '@/components/Brand'

/**
 * Recording controls: a slim vertical pill on the right edge of the screen,
 * out of the way of what you're showing. Hidden from the capture itself.
 * Drag it by the logo or the grip to move it.
 */
export default function ControlBar({ start }: { start: number }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    document.body.classList.add('transparent')
    const iv = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(iv)
  }, [])
  const elapsed = Math.max(0, (now - (start || now)) / 1000)
  return (
    // the window leaves a transparent margin around the pill so its shadow can fade out softly;
    // the pill is drawn at 70% (zoom) of its original 84 x 324 design
    <div className="grid h-screen w-screen place-items-center overflow-hidden">
      <motion.div
        initial={{ x: 18, opacity: 0, scale: 0.96 }}
        animate={{ x: 0, opacity: 1, scale: 1 }}
        transition={{ type: 'spring', stiffness: 380, damping: 30 }}
        style={{ zoom: 0.7, width: 84, height: 324 }}
        className="drag relative flex flex-col items-center rounded-[34px] bg-[#0d0d12]/95 py-3 shadow-[0_0_0_1px_rgba(255,255,255,.09),0_10px_24px_-4px_rgba(0,0,0,.5),0_2px_6px_rgba(0,0,0,.35)]"
      >
        <div className="grid h-10 w-10 place-items-center rounded-full bg-white/[0.05]" title="Drag to move">
          <LogoMark className="h-5 w-5" />
        </div>

        <div className="mt-4 flex flex-col items-center gap-1.5">
          <span className="relative flex h-2.5 w-2.5">
            <span className="absolute inset-0 animate-ping rounded-full bg-red-500/70" />
            <span className="relative h-2.5 w-2.5 rounded-full bg-red-500" />
          </span>
          <span className="text-[13px] font-semibold tabular-nums text-white">{fmtTime(elapsed)}</span>
        </div>

        <div className="my-4 h-px w-8 bg-white/10" />

        <button
          title={`Stop recording (${modKey}+Shift+2)`}
          onClick={() => window.ilf.rec.requestStop()}
          className="no-drag grid h-12 w-12 place-items-center rounded-full bg-[#ff3b5c] text-white shadow-[0_8px_22px_-4px_rgba(255,59,92,.75)] transition-all hover:scale-105 hover:bg-[#ff4d6b] active:scale-95"
        >
          <Square className="h-4 w-4" fill="currentColor" />
        </button>
        <span className="mt-1.5 text-[9.5px] font-semibold uppercase tracking-[.12em] text-zinc-500">Stop</span>

        <button
          title="Discard this recording"
          onClick={() => window.ilf.rec.cancel()}
          className="no-drag mt-3 grid h-9 w-9 place-items-center rounded-full text-zinc-400 ring-1 ring-white/10 transition-colors hover:bg-white/10 hover:text-white"
        >
          <X className="h-4 w-4" />
        </button>

        <div className="mt-auto flex flex-col gap-[3px] pb-0.5 opacity-40" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <span key={i} className="flex gap-[3px]">
              <i className="h-[3px] w-[3px] rounded-full bg-white" />
              <i className="h-[3px] w-[3px] rounded-full bg-white" />
            </span>
          ))}
        </div>
      </motion.div>
    </div>
  )
}
