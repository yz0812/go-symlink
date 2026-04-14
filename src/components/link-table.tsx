import { Eye, Pencil, RefreshCcw, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import type { ManagedLink } from '@/lib/types'

interface LinkTableProps {
  links: ManagedLink[]
  refreshing?: boolean
  deletingId?: string | null
  renamingId?: string | null
  onRefresh: () => void
  onCreate: () => void
  onView: (link: ManagedLink) => void
  onRename: (link: ManagedLink) => void
  onDelete: (link: ManagedLink) => void
}

const statusStyles: Record<ManagedLink['status'], string> = {
  healthy: 'bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-300 dark:ring-emerald-500/20',
  'missing-link': 'bg-amber-50 text-amber-700 ring-1 ring-inset ring-amber-200 dark:bg-amber-500/15 dark:text-amber-300 dark:ring-amber-500/20',
  'missing-target': 'bg-orange-50 text-orange-700 ring-1 ring-inset ring-orange-200 dark:bg-orange-500/15 dark:text-orange-300 dark:ring-orange-500/20',
  broken: 'bg-red-50 text-red-700 ring-1 ring-inset ring-red-200 dark:bg-red-500/15 dark:text-red-300 dark:ring-red-500/20',
}

const kindStyles = {
  file: 'bg-sky-50 text-sky-700 ring-sky-200 dark:bg-sky-500/15 dark:text-sky-300 dark:ring-sky-500/20',
  directory: 'bg-violet-50 text-violet-700 ring-violet-200 dark:bg-violet-500/15 dark:text-violet-300 dark:ring-violet-500/20',
} satisfies Record<ManagedLink['kind'], string>

export function LinkTable({
  links,
  refreshing = false,
  deletingId = null,
  renamingId = null,
  onRefresh,
  onCreate,
  onView,
  onRename,
  onDelete,
}: LinkTableProps) {
  return (
    <Card className="flex h-full min-h-0 flex-col">
      <CardHeader className="shrink-0 gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <CardTitle>已管理链接</CardTitle>
          <CardDescription>展示名称、链接类型和当前检查状态。</CardDescription>
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
                  <th className="min-w-[220px] px-4 py-3 text-center font-medium">名称</th>
                  <th className="w-[220px] px-4 py-3 text-center font-medium">类型</th>
                  <th className="w-[150px] px-4 py-3 text-center font-medium">状态</th>
                  <th className="w-[148px] min-w-[148px] max-w-[148px] px-4 py-3 text-center font-medium">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 bg-white text-slate-700 dark:divide-slate-800 dark:bg-slate-950 dark:text-slate-200">
                {links.map((link) => (
                  <tr key={link.id}>
                    <td className="px-4 py-4 text-center align-middle font-medium text-slate-900 dark:text-slate-50">{link.name}</td>
                    <td className="px-4 py-4 text-center align-middle">
                      <span
                        className={cn(
                          'inline-flex min-w-14 items-center justify-center rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset',
                          kindStyles[link.kind],
                        )}
                      >
                        {link.kind === 'file' ? '文件' : '目录'}
                      </span>
                    </td>
                    <td className="px-4 py-4 text-center align-middle">
                      <span className={cn('inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium', statusStyles[link.status])}>
                        {link.statusText}
                      </span>
                    </td>
                    <td className="w-[148px] min-w-[148px] max-w-[148px] px-4 py-4 text-center align-middle whitespace-nowrap">
                      <div className="flex flex-nowrap items-center justify-center gap-2">
                        <Button
                          aria-label="查看详情"
                          disabled={deletingId === link.id || renamingId === link.id}
                          onClick={() => onView(link)}
                          size="sm"
                          title="查看详情"
                          type="button"
                          variant="outline"
                          className="w-9 px-0"
                        >
                          <Eye className="h-4 w-4" />
                        </Button>
                        <Button
                          aria-label="修改名称"
                          disabled={deletingId === link.id || renamingId === link.id}
                          onClick={() => onRename(link)}
                          size="sm"
                          title={renamingId === link.id ? '修改中' : '修改名称'}
                          type="button"
                          variant="outline"
                          className="w-9 px-0"
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          aria-label="删除链接"
                          disabled={deletingId === link.id || renamingId === link.id}
                          onClick={() => onDelete(link)}
                          size="sm"
                          title={deletingId === link.id ? '删除中' : '删除链接'}
                          type="button"
                          variant="destructive"
                          className="w-9 px-0"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
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
