import { useMemo, useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import {
  Check,
  ExternalLink,
  FolderOpen,
  Loader2,
  Plus,
  RefreshCcw,
  Trash2,
} from 'lucide-react'

import {
  importExistingLinks,
  openInExplorer,
  scanExistingLinks,
  toErrorMessage,
} from '@/lib/api'
import {
  AlertDialogCancel,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type {
  AppSettings,
  AppStateResponse,
  ImportExistingLinkItem,
  ScannedLink,
  ThemeMode,
  UpdateSettingsRequest,
} from '@/lib/types'

interface SettingsPanelProps {
  settings: AppSettings
  storagePath: string
  disabled?: boolean
  saving?: boolean
  onSubmit: (settings: UpdateSettingsRequest) => Promise<void>
  onImported: (nextState: AppStateResponse) => void
  onNotify: (title: string, message: string, tone: 'success' | 'error' | 'destructive') => void
  onPreviewThemeChange: (themeMode: ThemeMode | null) => void
}

function getScanStatusText(item: ScannedLink) {
  if (item.alreadyManaged) {
    return '已在管理中'
  }

  if (item.targetExists) {
    return '可导入'
  }

  return '目标缺失'
}

export function SettingsPanel({
  settings,
  storagePath,
  disabled = false,
  saving = false,
  onSubmit,
  onImported,
  onNotify,
  onPreviewThemeChange,
}: SettingsPanelProps) {
  const [draft, setDraft] = useState<UpdateSettingsRequest>({
    ...settings,
    storagePath,
  })
  const [managedRootInput, setManagedRootInput] = useState('')
  const [scanning, setScanning] = useState(false)
  const [importing, setImporting] = useState(false)
  const [scanResults, setScanResults] = useState<ScannedLink[]>([])
  const [selectedScanIds, setSelectedScanIds] = useState<string[]>([])

  const selectedImportItems = useMemo<ImportExistingLinkItem[]>(() => {
    const selected = new Set(selectedScanIds)
    return scanResults
      .filter((item) => selected.has(item.id) && !item.alreadyManaged)
      .map((item) => ({
        name: item.name,
        kind: item.kind,
        linkPath: item.linkPath,
        targetPath: item.targetPath,
        linkType: item.linkType,
      }))
  }, [scanResults, selectedScanIds])

  function addManagedRoot(rawPath: string) {
    const nextRoot = rawPath.trim()
    if (!nextRoot) {
      return
    }

    setDraft((current) => {
      const exists = current.managedRoots.some(
        (item) => item.trim().toLowerCase() === nextRoot.toLowerCase(),
      )
      if (exists) {
        return current
      }

      return {
        ...current,
        managedRoots: [...current.managedRoots, nextRoot],
      }
    })
    setManagedRootInput('')
  }

  async function pickManagedRoot() {
    const selected = await open({
      multiple: false,
      directory: true,
    })

    if (typeof selected === 'string') {
      setManagedRootInput(selected)
    }
  }

  async function handleScanExisting() {
    if (draft.managedRoots.length === 0) {
      onNotify('扫描失败', '请先添加至少一个固定目录。', 'error')
      return
    }

    setScanning(true)

    try {
      const results = await scanExistingLinks({ roots: draft.managedRoots })
      setScanResults(results)
      setSelectedScanIds([])
      onNotify('扫描完成', `共发现 ${results.length} 个已有链接。`, 'success')
    } catch (error) {
      onNotify('扫描失败', toErrorMessage(error), 'error')
    } finally {
      setScanning(false)
    }
  }

  function toggleScanSelection(id: string, checked: boolean) {
    setSelectedScanIds((current) => {
      if (checked) {
        return current.includes(id) ? current : [...current, id]
      }

      return current.filter((item) => item !== id)
    })
  }

  function selectAllImportable() {
    setSelectedScanIds(
      scanResults.filter((item) => !item.alreadyManaged).map((item) => item.id),
    )
  }

  async function handleImportSelected() {
    if (selectedImportItems.length === 0) {
      onNotify('导入失败', '请先勾选要加入管理的链接。', 'error')
      return
    }

    setImporting(true)

    try {
      const nextState = await importExistingLinks({ items: selectedImportItems })
      onImported(nextState)
      const importedIds = new Set(selectedImportItems.map((item) => item.linkPath.toLowerCase()))
      setScanResults((current) =>
        current.map((item) =>
          importedIds.has(item.linkPath.toLowerCase())
            ? { ...item, alreadyManaged: true }
            : item,
        ),
      )
      setSelectedScanIds([])
      onNotify('导入完成', `已导入 ${selectedImportItems.length} 个链接。`, 'success')
      onPreviewThemeChange(draft.themeMode)
    } catch (error) {
      onNotify('导入失败', toErrorMessage(error), 'error')
    } finally {
      setImporting(false)
    }
  }

  return (
    <>
      <AlertDialogHeader>
        <AlertDialogTitle>全局设置</AlertDialogTitle>
        <AlertDialogDescription>
          当前仅支持全局配置。可维护固定目录列表，并扫描其中已有的软链接后按需加入管理。
        </AlertDialogDescription>
      </AlertDialogHeader>

      <div className="grid max-h-[70vh] gap-4 overflow-y-auto py-2 pr-1">
        <div className="grid gap-2 rounded-lg border border-slate-200 p-4 dark:border-slate-700">
          <Label htmlFor="themeMode">界面主题</Label>
          <div className="grid grid-cols-3 gap-2" id="themeMode">
            {([
              ['dark', '夜间', 'bg-slate-950 text-white border-slate-950 hover:bg-black'],
              ['light', '白日', 'border-slate-300 bg-slate-100 text-slate-800 hover:bg-slate-200'],
              ['system', '系统', 'border-emerald-500 bg-emerald-500 text-white hover:bg-emerald-600'],
            ] as const).map(([value, label, baseClassName]) => {
              const active = draft.themeMode === value
              return (
                <button
                  key={value}
                  className={[
                    'relative inline-flex h-12 items-center justify-center rounded-lg border px-3 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                    baseClassName,
                    active ? 'border-[#C3B091] ring-1 ring-[#C3B091]' : 'opacity-85',
                  ].join(' ')}
                  disabled={disabled || saving || importing}
                  onClick={() => {
                    setDraft((current) => ({
                      ...current,
                      themeMode: value,
                    }))
                    onPreviewThemeChange(value)
                  }}
                  type="button"
                >
                  {active ? <Check className="absolute left-2.5 h-4 w-4" /> : null}
                  <span>{label}</span>
                </button>
              )
            })}
          </div>
          <p className="text-sm text-slate-500 dark:text-slate-400">夜间使用深色界面，白日使用浅色界面，系统会跟随当前系统配色。</p>
        </div>

        <div className="grid gap-2 rounded-lg border border-slate-200 p-4 dark:border-slate-700">
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="storagePath">数据文件路径</Label>
            <Button
              disabled={disabled || saving || importing || !draft.storagePath.trim()}
              onClick={() => {
                void openInExplorer(draft.storagePath.trim()).catch((error) => {
                  onNotify('打开失败', error instanceof Error ? error.message : '打开目录失败', 'error')
                })
              }}
              size="sm"
              type="button"
              variant="outline"
            >
              <ExternalLink className="h-4 w-4" />
              打开目录
            </Button>
          </div>
          <Input
            id="storagePath"
            disabled={disabled || saving || importing}
            onChange={(event) => {
              setDraft((current) => ({
                ...current,
                storagePath: event.target.value,
              }))
            }}
            placeholder="例如：D:\\SoftLink\\state.json"
            value={draft.storagePath}
          />
          <p className="text-sm text-slate-500 dark:text-slate-400">保存时会迁移当前状态文件到新路径；如果目标文件已存在则不会覆盖。</p>
        </div>

        <div className="grid gap-3 rounded-lg border border-slate-200 p-4 dark:border-slate-700">
          <div className="space-y-1">
            <p className="text-sm font-medium text-slate-900 dark:text-slate-100">固定目录</p>
            <p className="text-sm text-slate-500 dark:text-slate-400">用于统一扫描系统里已有的文件符号链接和目录 junction。</p>
          </div>

          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              disabled={disabled || saving || scanning || importing}
              onChange={(event) => setManagedRootInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  addManagedRoot(managedRootInput)
                }
              }}
              placeholder="例如：D:\\Workspace"
              value={managedRootInput}
            />
            <div className="flex gap-2">
              <Button
                disabled={disabled || saving || scanning || importing}
                onClick={() => void pickManagedRoot()}
                type="button"
                variant="outline"
              >
                <FolderOpen className="h-4 w-4" />
                选择目录
              </Button>
              <Button
                disabled={disabled || saving || scanning || importing || !managedRootInput.trim()}
                onClick={() => addManagedRoot(managedRootInput)}
                type="button"
              >
                <Plus className="h-4 w-4" />
                添加
              </Button>
            </div>
          </div>

          {draft.managedRoots.length === 0 ? (
            <div className="rounded-lg border border-dashed border-slate-200 px-4 py-6 text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
              还没有固定目录。先添加一个再扫描。
            </div>
          ) : (
            <div className="grid gap-2">
              {draft.managedRoots.map((root) => (
                <div
                  key={root}
                  className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 px-3 py-2 text-sm dark:border-slate-700"
                >
                  <span className="break-all text-slate-700 dark:text-slate-200">{root}</span>
                  <div className="flex shrink-0 gap-2">
                    <Button
                      disabled={disabled || saving || scanning || importing}
                      onClick={() => {
                        void openInExplorer(root).catch((error) => {
                          onNotify('打开失败', toErrorMessage(error), 'error')
                        })
                      }}
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      <ExternalLink className="h-4 w-4" />
                    </Button>
                    <Button
                      disabled={disabled || saving || scanning || importing}
                      onClick={() => {
                        setDraft((current) => ({
                          ...current,
                          managedRoots: current.managedRoots.filter((item) => item !== root),
                        }))
                      }}
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

          <p className="text-sm text-slate-500 dark:text-slate-400">扫描时会使用当前列表；未保存的目录也会参与本次扫描。</p>
        </div>

        <div className="grid gap-3 rounded-lg border border-slate-200 p-4 dark:border-slate-700">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-1">
              <p className="text-sm font-medium text-slate-900 dark:text-slate-100">扫描已有软链接</p>
              <p className="text-sm text-slate-500 dark:text-slate-400">扫描全部固定目录，并从结果中勾选加入管理。</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={disabled || saving || scanning || importing || draft.managedRoots.length === 0}
                onClick={() => void handleScanExisting()}
                type="button"
                variant="outline"
              >
                <RefreshCcw className={`h-4 w-4 ${scanning ? 'animate-spin' : ''}`} />
                {scanning ? '扫描中' : '扫描'}
              </Button>
              <Button
                disabled={disabled || saving || scanning || importing || scanResults.length === 0}
                onClick={selectAllImportable}
                type="button"
                variant="outline"
              >
                全选可导入
              </Button>
              <Button
                disabled={disabled || saving || scanning || importing || selectedImportItems.length === 0}
                onClick={() => void handleImportSelected()}
                type="button"
              >
                {importing ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                导入选中（{selectedImportItems.length}）
              </Button>
            </div>
          </div>

          {scanResults.length === 0 ? (
            <div className="rounded-lg border border-dashed border-slate-200 px-4 py-8 text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
              还没有扫描结果。
            </div>
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
                  {scanResults.map((item) => {
                    const checked = selectedScanIds.includes(item.id)
                    return (
                      <tr key={item.id}>
                        <td className="px-3 py-3 text-center align-middle">
                          <input
                            checked={checked}
                            className="h-4 w-4"
                            disabled={item.alreadyManaged || disabled || saving || scanning || importing}
                            onChange={(event) => toggleScanSelection(item.id, event.target.checked)}
                            type="checkbox"
                          />
                        </td>
                        <td className="px-3 py-3 text-center align-middle font-medium text-slate-900 dark:text-slate-50">{item.name}</td>
                        <td className="px-3 py-3 text-center align-middle">
                          <div>{item.kind === 'file' ? '文件' : '目录'}</div>
                          <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                            {item.linkType === 'junction'
                              ? 'junction'
                              : item.linkType === 'directory-symlink'
                                ? '目录符号链接'
                                : '文件符号链接'}
                          </div>
                        </td>
                        <td className="px-3 py-3 text-center align-middle text-xs leading-5 text-slate-600 dark:text-slate-300">
                          <button
                            className="inline-flex max-w-full items-center justify-center gap-1 text-center text-sky-700 hover:text-sky-900 hover:underline dark:text-sky-300 dark:hover:text-sky-200"
                            onClick={() =>
                              void openInExplorer(item.linkPath).catch((error) =>
                                onNotify('打开失败', toErrorMessage(error), 'error'),
                              )
                            }
                            type="button"
                          >
                            <span className="break-all">{item.linkPath}</span>
                            <ExternalLink className="h-3.5 w-3.5 shrink-0" />
                          </button>
                        </td>
                        <td className="px-3 py-3 text-center align-middle text-xs leading-5 text-slate-600 dark:text-slate-300">
                          <button
                            className="inline-flex max-w-full items-center justify-center gap-1 text-center text-sky-700 hover:text-sky-900 hover:underline dark:text-sky-300 dark:hover:text-sky-200"
                            onClick={() =>
                              void openInExplorer(item.targetPath).catch((error) =>
                                onNotify('打开失败', toErrorMessage(error), 'error'),
                              )
                            }
                            type="button"
                          >
                            <span className="break-all">{item.targetPath}</span>
                            <ExternalLink className="h-3.5 w-3.5 shrink-0" />
                          </button>
                        </td>
                        <td className="px-3 py-3 text-center align-middle text-xs leading-5 text-slate-600 dark:text-slate-300">
                          <span className="break-all">{item.scanRoot}</span>
                        </td>
                        <td className="px-3 py-3 text-center align-middle">
                          <span className="inline-flex rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset ring-slate-200 dark:ring-slate-700">
                            {getScanStatusText(item)}
                          </span>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <AlertDialogFooter>
        <AlertDialogCancel
          disabled={saving || importing || scanning}
          onClick={() => onPreviewThemeChange(null)}
        >
          取消
        </AlertDialogCancel>
        <Button
          disabled={disabled || saving || importing || scanning || !draft.storagePath.trim()}
          onClick={() =>
            void onSubmit({
              ...draft,
              storagePath: draft.storagePath.trim(),
              managedRoots: draft.managedRoots.map((item) => item.trim()).filter(Boolean),
            })
          }
          type="button"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          保存设置
        </Button>
      </AlertDialogFooter>
    </>
  )
}
