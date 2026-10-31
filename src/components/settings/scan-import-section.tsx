import { useMemo, useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { ExternalLink, FolderOpen, Loader2, Plus, RefreshCcw, Trash2 } from 'lucide-react'

import { EmptyHint, HelpText, SectionTitle, SettingsSection } from '@/components/settings/section'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { BusyTracker } from '@/hooks/use-busy'
import type { ShowFeedback } from '@/hooks/use-feedback'
import { importExistingLinks, scanExistingLinks, toErrorMessage } from '@/lib/api'
import { kindLabels, kindStyles, linkTypeShortLabels } from '@/lib/labels'
import type { AppStateResponse, ImportExistingLinkItem, ScannedLink } from '@/lib/types'
import { cn } from '@/lib/utils'

function getScanStatusText(item: ScannedLink) {
  if (item.alreadyManaged) {
    return '已在管理中'
  }

  return item.targetExists ? '可导入' : '目标缺失'
}

interface ScanImportSectionProps {
  managedRoots: string[]
  locked: boolean
  showHelp: boolean
  tasks: BusyTracker
  onManagedRootsChange: (roots: string[]) => void
  onImported: (nextState: AppStateResponse) => void
  onNotify: ShowFeedback
  onOpenPath: (path: string, select?: boolean) => void
}

export function ScanImportSection({
  managedRoots,
  locked,
  showHelp,
  tasks,
  onManagedRootsChange,
  onImported,
  onNotify,
  onOpenPath,
}: ScanImportSectionProps) {
  const [rootInput, setRootInput] = useState('')
  const [scanResults, setScanResults] = useState<ScannedLink[]>([])
  const [scanWarnings, setScanWarnings] = useState<string[]>([])
  const [selectedIds, setSelectedIds] = useState<string[]>([])

  const selectedImportItems = useMemo<ImportExistingLinkItem[]>(() => {
    const selected = new Set(selectedIds)
    return scanResults
      .filter((item) => selected.has(item.id) && !item.alreadyManaged)
      .map((item) => ({
        name: item.name,
        kind: item.kind,
        linkPath: item.linkPath,
        targetPath: item.targetPath,
        linkType: item.linkType,
      }))
  }, [scanResults, selectedIds])

  function addRoot(rawPath: string) {
    const nextRoot = rawPath.trim()
    if (!nextRoot) {
      return
    }

    const exists = managedRoots.some((item) => item.trim().toLowerCase() === nextRoot.toLowerCase())
    if (!exists) {
      onManagedRootsChange([...managedRoots, nextRoot])
    }
    setRootInput('')
  }

  async function pickRoot() {
    const selected = await open({ multiple: false, directory: true })
    if (typeof selected === 'string') {
      setRootInput(selected)
    }
  }

  async function handleScan() {
    if (managedRoots.length === 0) {
      onNotify('扫描失败', '请先添加至少一个固定目录。', 'error')
      return
    }

    await tasks.run('scan', async () => {
      try {
        const { items, warnings } = await scanExistingLinks({ roots: managedRoots })
        setScanResults(items)
        setScanWarnings(warnings)
        setSelectedIds([])
        onNotify(
          '扫描完成',
          warnings.length > 0
            ? `共发现 ${items.length} 个已有链接，${warnings.length} 个路径无法读取已跳过。`
            : `共发现 ${items.length} 个已有链接。`,
          'success',
        )
      } catch (error) {
        onNotify('扫描失败', toErrorMessage(error), 'error')
      }
    })
  }

  function toggleSelection(id: string, checked: boolean) {
    setSelectedIds((current) => {
      if (checked) {
        return current.includes(id) ? current : [...current, id]
      }

      return current.filter((item) => item !== id)
    })
  }

  async function handleImportSelected() {
    if (selectedImportItems.length === 0) {
      onNotify('导入失败', '请先勾选要加入管理的链接。', 'error')
      return
    }

    await tasks.run('import-links', async () => {
      try {
        const nextState = await importExistingLinks({ items: selectedImportItems })
        onImported(nextState)
        const importedPaths = new Set(selectedImportItems.map((item) => item.linkPath.toLowerCase()))
        setScanResults((current) =>
          current.map((item) => (importedPaths.has(item.linkPath.toLowerCase()) ? { ...item, alreadyManaged: true } : item)),
        )
        setSelectedIds([])
        onNotify('导入完成', `已导入 ${selectedImportItems.length} 个链接。`, 'success')
      } catch (error) {
        onNotify('导入失败', toErrorMessage(error), 'error')
      }
    })
  }

  return (
    <>
      <SettingsSection>
        <SectionTitle help="用于统一扫描系统里已有的文件符号链接和目录 junction。" showHelp={showHelp} title="固定目录" />

        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            disabled={locked}
            onChange={(event) => setRootInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                addRoot(rootInput)
              }
            }}
            placeholder="例如：D:\\Workspace"
            value={rootInput}
          />
          <div className="flex gap-2">
            <Button disabled={locked} onClick={() => void pickRoot()} type="button" variant="outline">
              <FolderOpen className="h-4 w-4" />
              选择目录
            </Button>
            <Button disabled={locked || !rootInput.trim()} onClick={() => addRoot(rootInput)} type="button">
              <Plus className="h-4 w-4" />
              添加
            </Button>
          </div>
        </div>

        {managedRoots.length === 0 ? (
          <EmptyHint>还没有固定目录。先添加一个再扫描。</EmptyHint>
        ) : (
          <div className="grid gap-2">
            {managedRoots.map((root) => (
              <div
                key={root}
                className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 px-3 py-2 text-sm dark:border-slate-700"
              >
                <span className="break-all text-slate-700 dark:text-slate-200">{root}</span>
                <div className="flex shrink-0 gap-2">
                  <Button disabled={locked} onClick={() => onOpenPath(root)} size="sm" type="button" variant="outline">
                    <ExternalLink className="h-4 w-4" />
                  </Button>
                  <Button
                    disabled={locked}
                    onClick={() => onManagedRootsChange(managedRoots.filter((item) => item !== root))}
                    size="sm"
                    type="button"
                    variant="destructive"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}

        {showHelp ? <HelpText>扫描时会使用当前列表；未保存的目录也会参与本次扫描。</HelpText> : null}
      </SettingsSection>

      <SettingsSection>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <SectionTitle help="扫描全部固定目录，并从结果中勾选加入管理。" showHelp={showHelp} title="扫描已有软链接" />
          <div className="flex flex-wrap gap-2">
            <Button disabled={locked || managedRoots.length === 0} onClick={() => void handleScan()} type="button" variant="outline">
              <RefreshCcw className={cn('h-4 w-4', tasks.isBusy('scan') && 'animate-spin')} />
              {tasks.isBusy('scan') ? '扫描中' : '扫描'}
            </Button>
            <Button
              disabled={locked || scanResults.length === 0}
              onClick={() => setSelectedIds(scanResults.filter((item) => !item.alreadyManaged).map((item) => item.id))}
              type="button"
              variant="outline"
            >
              全选可导入
            </Button>
            <Button disabled={locked || selectedImportItems.length === 0} onClick={() => void handleImportSelected()} type="button">
              {tasks.isBusy('import-links') ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              导入选中（{selectedImportItems.length}）
            </Button>
          </div>
        </div>

        {scanWarnings.length > 0 ? (
          <details className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
            <summary className="cursor-pointer select-none font-medium">{scanWarnings.length} 个路径无法读取，已跳过</summary>
            <ul className="mt-2 max-h-40 space-y-1 overflow-auto break-all">
              {scanWarnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </details>
        ) : null}

        {scanResults.length === 0 ? (
          <EmptyHint>还没有扫描结果。</EmptyHint>
        ) : (
          <div className="min-h-0 overflow-auto rounded-lg border border-slate-200 dark:border-slate-800">
            <table className="min-w-full divide-y divide-slate-200 text-sm dark:divide-slate-800">
              <thead className="bg-slate-50 text-slate-500 dark:bg-slate-900 dark:text-slate-400">
                <tr>
                  <th className="px-3 py-3 text-center font-medium">选择</th>
                  <th className="px-3 py-3 text-center font-medium">名称</th>
                  <th className="px-3 py-3 text-center font-medium">类型</th>
                  <th className="px-3 py-3 text-center font-medium">原路径</th>
                  <th className="px-3 py-3 text-center font-medium">真实目标</th>
                  <th className="px-3 py-3 text-center font-medium">来源目录</th>
                  <th className="px-3 py-3 text-center font-medium">状态</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 bg-white text-slate-700 dark:divide-slate-800 dark:bg-slate-950 dark:text-slate-200">
                {scanResults.map((item) => (
                  <tr key={item.id}>
                    <td className="px-3 py-3 text-center align-middle">
                      <input
                        checked={selectedIds.includes(item.id)}
                        className="h-4 w-4"
                        disabled={item.alreadyManaged || locked}
                        onChange={(event) => toggleSelection(item.id, event.target.checked)}
                        type="checkbox"
                      />
                    </td>
                    <td className="px-3 py-3 text-center align-middle font-medium text-slate-900 dark:text-slate-50">{item.name}</td>
                    <td className="px-3 py-3 text-center align-middle">
                      <div className="flex flex-col items-center gap-1.5">
                        <span
                          className={cn(
                            'inline-flex min-w-14 items-center justify-center rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset',
                            kindStyles[item.kind],
                          )}
                        >
                          {kindLabels[item.kind]}
                        </span>
                        <div className="text-xs text-slate-500 dark:text-slate-400">{linkTypeShortLabels[item.linkType]}</div>
                      </div>
                    </td>
                    <td className="px-3 py-3 text-center align-middle text-xs leading-5 text-slate-600 dark:text-slate-300">
                      <PathButton onClick={() => onOpenPath(item.linkPath, true)} path={item.linkPath} />
                    </td>
                    <td className="px-3 py-3 text-center align-middle text-xs leading-5 text-slate-600 dark:text-slate-300">
                      <PathButton onClick={() => onOpenPath(item.targetPath, item.kind === 'file')} path={item.targetPath} />
                    </td>
                    <td className="px-3 py-3 text-center align-middle text-xs leading-5 text-slate-600 dark:text-slate-300">
                      <span className="block max-w-[220px] truncate" title={item.scanRoot}>
                        {item.scanRoot}
                      </span>
                    </td>
                    <td className="px-3 py-3 text-center align-middle">
                      <span className="inline-flex rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset ring-slate-200 dark:ring-slate-700">
                        {getScanStatusText(item)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SettingsSection>
    </>
  )
}

function PathButton({ path, onClick }: { path: string; onClick: () => void }) {
  return (
    <button
      className="inline-flex w-full max-w-[240px] items-center justify-center gap-1 overflow-hidden text-center text-sky-700 hover:text-sky-900 hover:underline dark:text-sky-300 dark:hover:text-sky-200"
      onClick={onClick}
      title={path}
      type="button"
    >
      <span className="block truncate">{path}</span>
      <ExternalLink className="h-3.5 w-3.5 shrink-0" />
    </button>
  )
}
