import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { kindLabels, kindStyles, linkTypeLabels, managementModeLabels, statusStyles } from '@/lib/labels'
import type { ManagedLink } from '@/lib/types'
import { cn } from '@/lib/utils'

interface LinkDetailsDialogProps {
  link: ManagedLink | null
  onClose: () => void
  onOpenPath: (path: string, select: boolean) => void
  onRevert: (link: ManagedLink) => void
}

const badgeClassName = 'inline-flex rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset'

export function LinkDetailsDialog({ link, onClose, onOpenPath, onRevert }: LinkDetailsDialogProps) {
  return (
    <AlertDialog
      open={link !== null}
      onOpenChange={(open) => {
        if (!open) {
          onClose()
        }
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>链接详情</AlertDialogTitle>
          <AlertDialogDescription>查看当前受管链接的完整信息，点击路径可在资源管理器中定位。</AlertDialogDescription>
        </AlertDialogHeader>
        {link ? (
          <div className="grid gap-3 text-sm">
            <div className="grid gap-1">
              <div className="text-slate-500 dark:text-slate-400">名称</div>
              <div className="break-all font-medium text-slate-900 dark:text-slate-50">{link.name}</div>
            </div>
            <div className="grid gap-1">
              <div className="text-slate-500 dark:text-slate-400">原路径</div>
              <button
                className="w-full rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-left text-sky-700 transition-colors hover:bg-sky-100 dark:border-sky-500/20 dark:bg-sky-500/10 dark:text-sky-300 dark:hover:bg-sky-500/15"
                onClick={() => onOpenPath(link.linkPath, true)}
                type="button"
              >
                <span className="block break-all">{link.linkPath}</span>
              </button>
            </div>
            <div className="grid gap-1">
              <div className="text-slate-500 dark:text-slate-400">真实目标</div>
              <button
                className="w-full rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-left text-emerald-700 transition-colors hover:bg-emerald-100 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-300 dark:hover:bg-emerald-500/15"
                onClick={() => onOpenPath(link.targetPath, link.kind === 'file')}
                type="button"
              >
                <span className="block break-all">{link.targetPath}</span>
              </button>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="grid gap-1">
                <div className="text-slate-500 dark:text-slate-400">类型</div>
                <div>
                  <span className={cn(badgeClassName, kindStyles[link.kind])}>{kindLabels[link.kind]}</span>
                </div>
              </div>
              <div className="grid gap-1">
                <div className="text-slate-500 dark:text-slate-400">链接方式</div>
                <div className="text-slate-900 dark:text-slate-50">{linkTypeLabels[link.linkType]}</div>
              </div>
              <div className="grid gap-1">
                <div className="text-slate-500 dark:text-slate-400">管理方式</div>
                <div className="text-slate-900 dark:text-slate-50">{managementModeLabels[link.managementMode]}</div>
              </div>
              <div className="grid gap-1 sm:col-span-3">
                <div className="text-slate-500 dark:text-slate-400">状态</div>
                <div>
                  <span className={cn(badgeClassName, statusStyles[link.status])}>{link.statusText}</span>
                </div>
              </div>
            </div>
          </div>
        ) : null}
        <AlertDialogFooter>
          {link?.managementMode === 'managed' && link.status === 'healthy' ? (
            <Button onClick={() => onRevert(link)} type="button" variant="outline">
              撤销（移回原位置）
            </Button>
          ) : null}
          <AlertDialogCancel>关闭</AlertDialogCancel>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
