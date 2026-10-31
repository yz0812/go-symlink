import { useMemo, useState } from 'react'
import { Eye, Pencil, RefreshCcw, Search, Trash2, Wrench, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { kindLabels, kindStyles, statusLabels, statusStyles } from '@/lib/labels'
import { cn } from '@/lib/utils'
import type { LinkKind, LinkStatus, ManagedLink } from '@/lib/types'

interface LinkTableProps {
  links: ManagedLink[]
  refreshing?: boolean
  deletingId?: string | null
  renamingId?: string | null
  repairing?: boolean
  batchDeleting?: boolean
  onRefresh: () => void
  onCreate: () => void
  onMigrate: () => void
  onRepair: (links: ManagedLink[]) => void
  onBatchDelete: (links: ManagedLink[]) => void
  onView: (link: ManagedLink) => void
  onRename: (link: ManagedLink) => void
  onDelete: (link: ManagedLink) => void
}

type StatusFilter = 'all' | 'problem' | LinkStatus
type KindFilter = 'all' | LinkKind
type SortKey = 'created-desc' | 'created-asc' | 'name' | 'status'

// 状态排序时把问题项排在前面
const statusOrder: Record<LinkStatus, number> = {
  broken: 0,
  'missing-target': 1,
  'missing-link': 2,
  healthy: 3,
}

const nameCollator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })

function compareLinks(sortKey: SortKey) {
  return (a: ManagedLink, b: ManagedLink) => {
    switch (sortKey) {
      case 'created-asc':
        return a.createdAt - b.createdAt
      case 'name':
        return nameCollator.compare(a.name, b.name)
      case 'status':
        return statusOrder[a.status] - statusOrder[b.status] || nameCollator.compare(a.name, b.name)
      default:
        return b.createdAt - a.createdAt
    }
  }
}

function matchesQuery(link: ManagedLink, query: string) {
  if (!query) {
    return true
  }

  return [link.name, link.linkPath, link.targetPath].some((value) => value.toLowerCase().includes(query))
}

export function LinkTable({
  links,
  refreshing = false,
  deletingId = null,
  renamingId = null,
  repairing = false,
  batchDeleting = false,
  onRefresh,
  onCreate,
  onMigrate,
  onRepair,
  onBatchDelete,
  onView,
  onRename,
  onDelete,
}: LinkTableProps) {
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [kindFilter, setKindFilter] = useState<KindFilter>('all')
  const [sortKey, setSortKey] = useState<SortKey>('created-desc')
  const [selectedIds, setSelectedIds] = useState<string[]>([])

  const repairable = links.filter((link) => link.status === 'missing-link')
  const filtering = query.trim() !== '' || statusFilter !== 'all' || kindFilter !== 'all'

  const visibleLinks = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    return links
      .filter((link) => {
        if (statusFilter === 'problem' ? link.status === 'healthy' : statusFilter !== 'all' && link.status !== statusFilter) {
          return false
        }
        if (kindFilter !== 'all' && link.kind !== kindFilter) {
          return false
        }
        return matchesQuery(link, normalizedQuery)
      })
      .sort(compareLinks(sortKey))
  }, [links, query, statusFilter, kindFilter, sortKey])

  // 只保留仍然可见的勾选项，筛选或删除后自动收敛
  const selectedLinks = useMemo(() => {
    const selected = new Set(selectedIds)
    return visibleLinks.filter((link) => selected.has(link.id))
  }, [visibleLinks, selectedIds])
  const selectedRepairable = selectedLinks.filter((link) => link.status === 'missing-link')
  const allVisibleSelected = visibleLinks.length > 0 && selectedLinks.length === visibleLinks.length
  const busy = batchDeleting || repairing

  function toggleOne(id: string, checked: boolean) {
    setSelectedIds((current) => (checked ? [...current, id] : current.filter((item) => item !== id)))
  }

  function toggleAll(checked: boolean) {
    setSelectedIds(checked ? visibleLinks.map((link) => link.id) : [])
  }

  function resetFilters() {
    setQuery('')
    setStatusFilter('all')
    setKindFilter('all')
  }

  return (
    <Card className="flex h-full min-h-0 flex-col">
      <CardHeader className="shrink-0 gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <CardTitle>已管理链接</CardTitle>
          <CardDescription>展示名称、链接类型和当前检查状态。窗口重新获得焦点时会自动刷新。</CardDescription>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={onCreate} size="sm" type="button">
            新建链接
          </Button>
          <Button onClick={onMigrate} size="sm" type="button" variant="outline">
            迁移并链接
          </Button>
          {repairable.length > 0 ? (
            <Button disabled={busy} onClick={() => onRepair(repairable)} size="sm" type="button" variant="outline">
              <Wrench className="h-4 w-4" />
              全部修复（{repairable.length}）
            </Button>
          ) : null}
          <Button onClick={onRefresh} size="sm" type="button" variant="outline">
            <RefreshCcw className={cn('h-4 w-4', refreshing && 'animate-spin')} />
            刷新状态
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col gap-3">
        {links.length > 0 ? (
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <div className="relative min-w-[200px] flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <Input
                aria-label="搜索链接"
                className="pl-9"
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索名称或路径"
                value={query}
              />
            </div>
            <Select onValueChange={(value) => setStatusFilter(value as StatusFilter)} value={statusFilter}>
              <SelectTrigger aria-label="按状态筛选" className="w-[132px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部状态</SelectItem>
                <SelectItem value="problem">需要处理</SelectItem>
                {(Object.keys(statusLabels) as LinkStatus[]).map((status) => (
                  <SelectItem key={status} value={status}>
                    {statusLabels[status]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select onValueChange={(value) => setKindFilter(value as KindFilter)} value={kindFilter}>
              <SelectTrigger aria-label="按类型筛选" className="w-[112px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部类型</SelectItem>
                <SelectItem value="directory">目录</SelectItem>
                <SelectItem value="file">文件</SelectItem>
              </SelectContent>
            </Select>
            <Select onValueChange={(value) => setSortKey(value as SortKey)} value={sortKey}>
              <SelectTrigger aria-label="排序方式" className="w-[132px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="created-desc">最新创建</SelectItem>
                <SelectItem value="created-asc">最早创建</SelectItem>
                <SelectItem value="name">按名称</SelectItem>
                <SelectItem value="status">问题优先</SelectItem>
              </SelectContent>
            </Select>
          </div>
        ) : null}

        {selectedLinks.length > 0 ? (
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-800 dark:border-sky-500/20 dark:bg-sky-500/10 dark:text-sky-200">
            <span>已选择 {selectedLinks.length} 项</span>
            <div className="flex flex-wrap gap-2">
              {selectedRepairable.length > 0 ? (
                <Button
                  disabled={busy}
                  onClick={() => onRepair(selectedRepairable)}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  <Wrench className="h-4 w-4" />
                  修复选中（{selectedRepairable.length}）
                </Button>
              ) : null}
              <Button disabled={busy} onClick={() => onBatchDelete(selectedLinks)} size="sm" type="button" variant="destructive">
                <Trash2 className="h-4 w-4" />
                删除选中
              </Button>
              <Button disabled={busy} onClick={() => setSelectedIds([])} size="sm" type="button" variant="outline">
                <X className="h-4 w-4" />
                取消选择
              </Button>
            </div>
          </div>
        ) : null}

        {links.length === 0 ? (
          <div className="flex flex-1 items-center justify-center rounded-lg border border-dashed border-slate-200 px-6 py-10 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
            还没有受管链接。先在上面创建一个，或在设置中扫描已有链接。
          </div>
        ) : visibleLinks.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-slate-200 px-6 py-10 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
            没有匹配的链接。
            {filtering ? (
              <Button onClick={resetFilters} size="sm" type="button" variant="outline">
                清除筛选
              </Button>
            ) : null}
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-slate-200 dark:border-slate-800">
            <table className="min-w-full divide-y divide-slate-200 text-sm dark:divide-slate-800">
              <thead className="sticky top-0 z-10 bg-slate-50 text-slate-500 dark:bg-slate-900 dark:text-slate-400">
                <tr>
                  <th className="w-10 px-3 py-3 text-center font-medium">
                    <input
                      aria-label="全选"
                      checked={allVisibleSelected}
                      className="h-4 w-4 align-middle"
                      disabled={busy}
                      onChange={(event) => toggleAll(event.target.checked)}
                      type="checkbox"
                    />
                  </th>
                  <th className="min-w-[220px] px-4 py-3 text-left font-medium">名称</th>
                  <th className="w-[96px] px-4 py-3 text-center font-medium">类型</th>
                  <th className="w-[120px] px-4 py-3 text-center font-medium">状态</th>
                  <th className="w-[192px] min-w-[192px] px-4 py-3 text-center font-medium">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 bg-white text-slate-700 dark:divide-slate-800 dark:bg-slate-950 dark:text-slate-200">
                {visibleLinks.map((link) => {
                  const rowBusy = deletingId === link.id || renamingId === link.id || busy
                  return (
                    <tr key={link.id}>
                      <td className="px-3 py-4 text-center align-middle">
                        <input
                          aria-label={`选择 ${link.name}`}
                          checked={selectedIds.includes(link.id)}
                          className="h-4 w-4 align-middle"
                          disabled={busy}
                          onChange={(event) => toggleOne(link.id, event.target.checked)}
                          type="checkbox"
                        />
                      </td>
                      <td className="max-w-0 px-4 py-3 align-middle">
                        <div className="truncate font-medium text-slate-900 dark:text-slate-50" title={link.name}>
                          {link.name}
                        </div>
                        <div className="truncate text-xs text-slate-500 dark:text-slate-400" title={link.linkPath}>
                          {link.linkPath}
                        </div>
                      </td>
                      <td className="px-4 py-4 text-center align-middle">
                        <span
                          className={cn(
                            'inline-flex min-w-14 items-center justify-center rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset',
                            kindStyles[link.kind],
                          )}
                        >
                          {kindLabels[link.kind]}
                        </span>
                      </td>
                      <td className="px-4 py-4 text-center align-middle">
                        <span
                          className={cn(
                            'inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset',
                            statusStyles[link.status],
                          )}
                        >
                          {link.statusText}
                        </span>
                      </td>
                      <td className="w-[192px] min-w-[192px] whitespace-nowrap px-4 py-4 text-center align-middle">
                        <div className="flex flex-nowrap items-center justify-center gap-2">
                          {link.status === 'missing-link' ? (
                            <Button
                              aria-label="修复链接"
                              className="w-9 px-0"
                              disabled={rowBusy}
                              onClick={() => onRepair([link])}
                              size="sm"
                              title="按原记录重新创建链接"
                              type="button"
                              variant="outline"
                            >
                              <Wrench className="h-4 w-4" />
                            </Button>
                          ) : null}
                          <Button
                            aria-label="查看详情"
                            className="w-9 px-0"
                            disabled={rowBusy}
                            onClick={() => onView(link)}
                            size="sm"
                            title="查看详情"
                            type="button"
                            variant="outline"
                          >
                            <Eye className="h-4 w-4" />
                          </Button>
                          <Button
                            aria-label="修改名称"
                            className="w-9 px-0"
                            disabled={rowBusy}
                            onClick={() => onRename(link)}
                            size="sm"
                            title={renamingId === link.id ? '修改中' : '修改名称'}
                            type="button"
                            variant="outline"
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            aria-label="删除链接"
                            className="w-9 px-0"
                            disabled={rowBusy}
                            onClick={() => onDelete(link)}
                            size="sm"
                            title={deletingId === link.id ? '删除中' : '删除链接'}
                            type="button"
                            variant="destructive"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
