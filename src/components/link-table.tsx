import { ExternalLink, RefreshCcw, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

import { openInExplorer } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import type { ManagedLink } from '@/lib/types'

interface LinkTableProps {
  links: ManagedLink[]
  refreshing?: boolean
  deletingId?: string | null
  onRefresh: () => void
  onCreate: () => void
  onDelete: (link: ManagedLink) => void
}

const statusStyles: Record<ManagedLink['status'], string> = {
  healthy: 'bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-300 dark:ring-emerald-500/20',
  'missing-link': 'bg-amber-50 text-amber-700 ring-1 ring-inset ring-amber-200 dark:bg-amber-500/15 dark:text-amber-300 dark:ring-amber-500/20',
  'missing-target': 'bg-orange-50 text-orange-700 ring-1 ring-inset ring-orange-200 dark:bg-orange-500/15 dark:text-orange-300 dark:ring-orange-500/20',
  broken: 'bg-red-50 text-red-700 ring-1 ring-inset ring-red-200 dark:bg-red-500/15 dark:text-red-300 dark:ring-red-500/20',
}

async function handleOpenPath(path: string) {
  try {
    await openInExplorer(path)
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '打开目录失败')
  }
}

export function LinkTable({
  links,
  refreshing = false,
  deletingId = null,
  onRefresh,
  onCreate,
  onDelete,
}: LinkTableProps) {
  return (
    <Card className="flex h-full min-h-0 flex-col">
      <CardHeader className="shrink-0 gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <CardTitle>已管理链接</CardTitle>
          <CardDescription>展示原路径、真实目标路径、链接类型和当前检查状态。</CardDescription>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={onCreate} size="sm" type="button">
            新建链接
          </Button>
          <Button onClick={onRefresh} size="sm" type="button" variant="outline">
            <RefreshCcw className={cn('h-4 w-4', refreshing && 'animate-spin')} />
            刷新状态
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col">
        {links.length === 0 ? (
          <div className="flex flex-1 items-center justify-center rounded-lg border border-dashed border-slate-200 px-6 py-10 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
            还没有受管链接。先在上面创建一个。
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-slate-200 dark:border-slate-800">
            <table className="min-w-full divide-y divide-slate-200 text-sm dark:divide-slate-800">
              <thead className="bg-slate-50 text-slate-500 dark:bg-slate-900 dark:text-slate-400">
                <tr>
                  <th className="px-4 py-3 text-center font-medium">名称</th>
                  <th className="px-4 py-3 text-center font-medium">类型</th>
                  <th className="px-4 py-3 text-center font-medium">原路径</th>
                  <th className="px-4 py-3 text-center font-medium">真实目标</th>
                  <th className="px-4 py-3 text-center font-medium">状态</th>
                  <th className="px-4 py-3 text-center font-medium">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 bg-white text-slate-700 dark:divide-slate-800 dark:bg-slate-950 dark:text-slate-200">
                {links.map((link) => (
                  <tr key={link.id}>
                    <td className="px-4 py-4 text-center align-middle font-medium text-slate-900 dark:text-slate-50">{link.name}</td>
                    <td className="px-4 py-4 text-center align-middle">
                      <div>{link.kind === 'file' ? '文件' : '目录'}</div>
                      <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                        {link.linkType === 'junction'
                          ? 'junction'
                          : link.linkType === 'directory-symlink'
                            ? '目录符号链接'
                            : '文件符号链接'}
                      </div>
                      <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                        {link.managementMode === 'tracked' ? '仅登记' : '托管'}
                      </div>
                    </td>
                    <td className="px-4 py-4 text-center align-middle text-xs leading-5 text-slate-600 dark:text-slate-300">
                      <button
                        className="inline-flex max-w-full items-center justify-center gap-1 text-center text-sky-700 hover:text-sky-900 hover:underline dark:text-sky-300 dark:hover:text-sky-200"
                        onClick={() => void handleOpenPath(link.linkPath)}
                        type="button"
                      >
                        <span className="break-all">{link.linkPath}</span>
                        <ExternalLink className="h-3.5 w-3.5 shrink-0" />
                      </button>
                    </td>
                    <td className="px-4 py-4 text-center align-middle text-xs leading-5 text-slate-600 dark:text-slate-300">
                      <button
                        className="inline-flex max-w-full items-center justify-center gap-1 text-center text-sky-700 hover:text-sky-900 hover:underline dark:text-sky-300 dark:hover:text-sky-200"
                        onClick={() => void handleOpenPath(link.targetPath)}
                        type="button"
                      >
                        <span className="break-all">{link.targetPath}</span>
                        <ExternalLink className="h-3.5 w-3.5 shrink-0" />
                      </button>
                    </td>
                    <td className="px-4 py-4 text-center align-middle">
                      <span className={cn('inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium', statusStyles[link.status])}>
                        {link.statusText}
                      </span>
                    </td>
                    <td className="px-4 py-4 text-center align-middle">
                      <Button
                        disabled={deletingId === link.id}
                        onClick={() => onDelete(link)}
                        size="sm"
                        type="button"
                        variant="destructive"
                      >
                        <Trash2 className="h-4 w-4" />
                        {deletingId === link.id ? '处理中' : '删除'}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
