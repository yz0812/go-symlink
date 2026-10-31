import { Loader2 } from 'lucide-react'

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
import type { DiffLink, StateDiff } from '@/lib/types'

// 每类最多列出的条目数，避免超大备份撑爆对话框
const MAX_LISTED = 50

interface BackupPreviewDialogProps {
  /** 备份来源的展示名称；为 null 时对话框关闭 */
  sourceLabel: string | null
  diff: StateDiff | null
  confirming: boolean
  onConfirm: () => void
  onCancel: () => void
}

function DiffGroup({ title, items, tone }: { title: string; items: DiffLink[]; tone: string }) {
  if (items.length === 0) {
    return null
  }

  return (
    <details className="rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-700" open={items.length <= 5}>
      <summary className={`cursor-pointer select-none text-sm font-medium ${tone}`}>
        {title}（{items.length}）
      </summary>
      <ul className="mt-2 max-h-48 space-y-1.5 overflow-auto text-xs text-slate-600 dark:text-slate-300">
        {items.slice(0, MAX_LISTED).map((item) => (
          <li key={item.linkPath} className="break-all">
            <span className="font-medium text-slate-900 dark:text-slate-100">{item.name}</span>
            <span className="text-slate-400"> · </span>
            {item.linkPath}
            <span className="text-slate-400"> → </span>
            {item.targetPath}
          </li>
        ))}
        {items.length > MAX_LISTED ? <li className="text-slate-400">…还有 {items.length - MAX_LISTED} 项</li> : null}
      </ul>
    </details>
  )
}

export function BackupPreviewDialog({ sourceLabel, diff, confirming, onConfirm, onCancel }: BackupPreviewDialogProps) {
  const unchanged =
    diff !== null && diff.added.length + diff.removed.length + diff.changed.length === 0 && !diff.settingsChanged

  return (
    <AlertDialog
      open={sourceLabel !== null}
      onOpenChange={(open) => {
        if (!open && !confirming) {
          onCancel()
        }
      }}
    >
      <AlertDialogContent className="max-w-2xl">
        <AlertDialogHeader>
          <AlertDialogTitle>恢复前确认</AlertDialogTitle>
          <AlertDialogDescription>
            {`将用 ${sourceLabel ?? ''} 替换当前的设置和链接记录。恢复前会自动保存当前数据的快照；恢复只改记录，不会创建或删除磁盘上的链接。`}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {diff ? (
          <div className="grid gap-2">
            <div className="grid grid-cols-2 gap-2 text-center text-sm sm:grid-cols-4">
              <Stat label="新增" value={diff.added.length} />
              <Stat label="移除" value={diff.removed.length} />
              <Stat label="变更" value={diff.changed.length} />
              <Stat label="不变" value={diff.unchangedCount} />
            </div>
            {diff.settingsChanged ? (
              <p className="text-sm text-amber-700 dark:text-amber-300">设置（主题、固定目录、WebDAV 等）也会被备份中的值替换。</p>
            ) : null}
            {unchanged ? <p className="text-sm text-slate-500 dark:text-slate-400">备份内容与当前数据一致。</p> : null}
            <DiffGroup items={diff.added} title="新增的链接记录" tone="text-emerald-700 dark:text-emerald-300" />
            <DiffGroup items={diff.removed} title="将被移除的链接记录" tone="text-red-700 dark:text-red-300" />
            <DiffGroup items={diff.changed} title="目标或名称有变化" tone="text-amber-700 dark:text-amber-300" />
          </div>
        ) : null}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={confirming}>取消</AlertDialogCancel>
          <Button disabled={confirming || diff === null} onClick={onConfirm} type="button">
            {confirming ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            确认恢复
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-700">
      <div className="text-lg font-semibold text-slate-900 dark:text-slate-50">{value}</div>
      <div className="text-xs text-slate-500 dark:text-slate-400">{label}</div>
    </div>
  )
}
