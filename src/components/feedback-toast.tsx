import { AlertTriangle, Check, Trash2, X } from 'lucide-react'

import type { Feedback, FeedbackTone } from '@/hooks/use-feedback'
import { cn } from '@/lib/utils'

function getIconClassName(tone: FeedbackTone) {
  if (tone === 'success') {
    return 'bg-emerald-50 text-emerald-600 ring-1 ring-inset ring-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-300 dark:ring-emerald-500/20'
  }

  if (tone === 'destructive') {
    return 'bg-red-50 text-red-600 ring-1 ring-inset ring-red-200 dark:bg-red-500/15 dark:text-red-300 dark:ring-red-500/20'
  }

  return 'bg-amber-50 text-amber-600 ring-1 ring-inset ring-amber-200 dark:bg-amber-500/15 dark:text-amber-300 dark:ring-amber-500/20'
}

interface FeedbackToastProps {
  feedback: Feedback | null
  closing: boolean
  onClose: () => void
}

export function FeedbackToast({ feedback, closing, onClose }: FeedbackToastProps) {
  if (!feedback) {
    return null
  }

  return (
    <div className="pointer-events-none fixed inset-0 z-[70] flex items-center justify-center px-4">
      <section
        aria-live="polite"
        className={cn(
          'pointer-events-auto relative grid w-full max-w-[20rem] gap-3 rounded-2xl border border-slate-200/90 bg-white/95 px-4 py-4 text-center shadow-lg backdrop-blur-sm transition-[opacity,transform] duration-150 ease-out dark:border-slate-800/90 dark:bg-slate-950/95',
          closing ? 'translate-y-2 scale-[0.98] opacity-0' : 'translate-y-0 scale-100 opacity-100',
        )}
        role="status"
      >
        <button
          aria-label="关闭提示"
          className="absolute right-2.5 top-2.5 inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-50 dark:focus-visible:ring-slate-700"
          onClick={onClose}
          type="button"
        >
          <X className="h-3.5 w-3.5" />
        </button>

        <div className="flex justify-center pt-1">
          <div className={`inline-flex h-10 w-10 items-center justify-center rounded-full ${getIconClassName(feedback.tone)}`}>
            {feedback.tone === 'destructive' ? (
              <Trash2 className="h-5 w-5" />
            ) : feedback.tone === 'success' ? (
              <Check className="h-5 w-5" />
            ) : (
              <AlertTriangle className="h-5 w-5" />
            )}
          </div>
        </div>

        <div className="flex flex-col gap-1 text-center">
          <h2 className="text-sm font-semibold text-slate-950 dark:text-slate-50">{feedback.title}</h2>
          <p className="text-xs leading-5 text-slate-600 dark:text-slate-400">{feedback.message}</p>
        </div>
      </section>
    </div>
  )
}
