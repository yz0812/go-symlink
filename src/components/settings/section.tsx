import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'

export function SettingsSection({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('grid gap-3 rounded-lg border border-slate-200 p-4 dark:border-slate-700', className)}>{children}</div>
}

export function SectionTitle({ title, help, showHelp }: { title: string; help?: string; showHelp: boolean }) {
  return (
    <div className="space-y-1">
      <p className="text-sm font-medium text-slate-900 dark:text-slate-100">{title}</p>
      {showHelp && help ? <HelpText>{help}</HelpText> : null}
    </div>
  )
}

export function HelpText({ children }: { children: ReactNode }) {
  return <p className="text-sm text-slate-500 dark:text-slate-400">{children}</p>
}

export function EmptyHint({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-slate-200 px-4 py-6 text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
      {children}
    </div>
  )
}
