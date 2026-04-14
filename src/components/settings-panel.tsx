import { useEffect, useMemo, useRef, useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import {
  Check,
  ExternalLink,
  FolderOpen,
  Loader2,
  Plus,
  RefreshCcw,
  Trash2,
  Upload,
} from 'lucide-react'

import {
  backupStateToWebdav,
  deleteWebdavBackup,
  importBackupFile,
  importExistingLinks,
  listWebdavBackups,
  openInExplorer,
  restoreStateFromWebdav,
  scanExistingLinks,
  testWebdavConnection,
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
import { Switch } from '@/components/ui/switch'
import type {
  AppSettings,
  AppStateResponse,
  ImportExistingLinkItem,
  ScannedLink,
  ThemeMode,
  UpdateSettingsRequest,
  WebdavBackupFile,
} from '@/lib/types'

interface SettingsPanelProps {
  settings: AppSettings
  storagePath: string
  hasWebdavPassword: boolean
  disabled?: boolean
  saving?: boolean
  onSubmit: (settings: UpdateSettingsRequest) => Promise<void>
  onWebdavSubmit: (settings: UpdateSettingsRequest) => Promise<void>
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

const kindStyles = {
  file: 'bg-sky-50 text-sky-700 ring-sky-200 dark:bg-sky-500/15 dark:text-sky-300 dark:ring-sky-500/20',
  directory:
    'bg-violet-50 text-violet-700 ring-violet-200 dark:bg-violet-500/15 dark:text-violet-300 dark:ring-violet-500/20',
} satisfies Record<ScannedLink['kind'], string>

const linkTypeLabels = {
  'file-symlink': '文件链',
  'directory-symlink': '目录链',
  junction: 'J',
} satisfies Record<ScannedLink['linkType'], string>

function padDatePart(value: number) {
  return String(value).padStart(2, '0')
}

function formatReadableDate(date: Date) {
  return `${date.getFullYear()}-${padDatePart(date.getMonth() + 1)}-${padDatePart(date.getDate())} ${padDatePart(date.getHours())}:${padDatePart(date.getMinutes())}:${padDatePart(date.getSeconds())}`
}

function getBackupCreatedAt(file: WebdavBackupFile) {
  const matched = file.name.match(/_(\d{14})\.json$/i)
  if (matched) {
    const value = matched[1]
    const date = new Date(
      Number(value.slice(0, 4)),
      Number(value.slice(4, 6)) - 1,
      Number(value.slice(6, 8)),
      Number(value.slice(8, 10)),
      Number(value.slice(10, 12)),
      Number(value.slice(12, 14)),
    )

    if (!Number.isNaN(date.getTime())) {
      return formatReadableDate(date)
    }
  }

  if (!file.modifiedAt) {
    return '-'
  }

  const fallbackDate = new Date(file.modifiedAt)
  return Number.isNaN(fallbackDate.getTime()) ? file.modifiedAt : formatReadableDate(fallbackDate)
}

export function SettingsPanel({
  settings,
  storagePath,
  hasWebdavPassword,
  disabled = false,
  saving = false,
  onSubmit,
  onWebdavSubmit,
  onImported,
  onNotify,
  onPreviewThemeChange,
}: SettingsPanelProps) {
  const [draft, setDraft] = useState<UpdateSettingsRequest>({
    ...settings,
    storagePath,
    webdavPassword: '',
  })
  const [managedRootInput, setManagedRootInput] = useState('')
  const [showHelpText, setShowHelpText] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [importing, setImporting] = useState(false)
  const [scanResults, setScanResults] = useState<ScannedLink[]>([])
  const [selectedScanIds, setSelectedScanIds] = useState<string[]>([])
  const [backingUp, setBackingUp] = useState(false)
  const [loadingBackups, setLoadingBackups] = useState(false)
  const [restoringBackup, setRestoringBackup] = useState<string | null>(null)
  const [deletingBackup, setDeletingBackup] = useState<string | null>(null)
  const [testingWebdav, setTestingWebdav] = useState(false)
  const [importingBackup, setImportingBackup] = useState(false)
  const [backupFiles, setBackupFiles] = useState<WebdavBackupFile[]>([])
  const preserveLocalDraftRef = useRef(false)

  useEffect(() => {
    if (preserveLocalDraftRef.current) {
      preserveLocalDraftRef.current = false
      setDraft((current) => ({
        ...current,
        webdavEnabled: settings.webdavEnabled,
        webdavUrl: settings.webdavUrl,
        webdavUsername: settings.webdavUsername,
        webdavRemoteDir: settings.webdavRemoteDir,
        webdavAutoBackup: settings.webdavAutoBackup,
        webdavPassword: '',
      }))
      return
    }

    setDraft({
      ...settings,
      storagePath,
      webdavPassword: '',
    })
  }, [settings, storagePath])

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

  const webdavReady =
    draft.webdavEnabled &&
    draft.webdavUrl.trim() !== '' &&
    draft.webdavUsername.trim() !== '' &&
    draft.webdavRemoteDir.trim() !== '' &&
    (hasWebdavPassword || !!draft.webdavPassword?.trim())

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
      const importedIds = new Set(
        selectedImportItems.map((item) => item.linkPath.toLowerCase()),
      )
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

  async function handleBackupNow() {
    setBackingUp(true)

    try {
      const fileName = await backupStateToWebdav()
      onNotify('备份成功', `已上传到 WebDAV：${fileName}`, 'success')
      await handleLoadBackups(true)
    } catch (error) {
      onNotify('备份失败', toErrorMessage(error), 'error')
    } finally {
      setBackingUp(false)
    }
  }

  async function handleLoadBackups(silent = false) {
    setLoadingBackups(true)

    try {
      const files = await listWebdavBackups()
      setBackupFiles(files)
      if (!silent) {
        onNotify('读取成功', `共读取 ${files.length} 个远程备份。`, 'success')
      }
    } catch (error) {
      onNotify('读取失败', toErrorMessage(error), 'error')
    } finally {
      setLoadingBackups(false)
    }
  }

  async function handleRestore(fileName: string) {
    setRestoringBackup(fileName)

    try {
      const nextState = await restoreStateFromWebdav({ fileName })
      onImported(nextState)
      onNotify('恢复成功', `已从 ${fileName} 恢复配置。`, 'success')
      onPreviewThemeChange(nextState.settings.themeMode)
    } catch (error) {
      onNotify('恢复失败', toErrorMessage(error), 'error')
    } finally {
      setRestoringBackup(null)
    }
  }

  async function handleDeleteBackup(fileName: string) {
    if (!window.confirm(`确认删除远程备份 ${fileName} 吗？此操作不可恢复。`)) {
      return
    }

    setDeletingBackup(fileName)

    try {
      await deleteWebdavBackup({ fileName })
      await handleLoadBackups(true)
      onNotify('删除成功', `已删除远程备份：${fileName}`, 'success')
    } catch (error) {
      onNotify('删除失败', toErrorMessage(error), 'error')
    } finally {
      setDeletingBackup(null)
    }
  }

  async function handleTestWebdav() {
    setTestingWebdav(true)

    try {
      const result = await testWebdavConnection({
        webdavEnabled: draft.webdavEnabled,
        webdavUrl: draft.webdavUrl.trim(),
        webdavUsername: draft.webdavUsername.trim(),
        webdavRemoteDir: draft.webdavRemoteDir.trim(),
        webdavPassword: draft.webdavPassword?.trim() || undefined,
      })
      onNotify('测试成功', result.message, 'success')
    } catch (error) {
      onNotify('测试失败', toErrorMessage(error), 'error')
    } finally {
      setTestingWebdav(false)
    }
  }

  async function handleImportBackup() {
    const selected = await open({
      multiple: false,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })

    if (typeof selected !== 'string') {
      return
    }

    setImportingBackup(true)

    try {
      const nextState = await importBackupFile({ filePath: selected })
      onImported(nextState)
      onNotify('导入成功', `已导入本地备份：${selected.split(/[/\\]/).pop() ?? selected}`, 'success')
      onPreviewThemeChange(nextState.settings.themeMode)
    } catch (error) {
      onNotify('导入失败', toErrorMessage(error), 'error')
    } finally {
      setImportingBackup(false)
    }
  }

  async function handleWebdavSave() {
    preserveLocalDraftRef.current = true
    try {
      await onWebdavSubmit({
        ...settings,
        storagePath,
        managedRoots: settings.managedRoots,
        webdavEnabled: draft.webdavEnabled,
        webdavUrl: draft.webdavUrl.trim(),
        webdavUsername: draft.webdavUsername.trim(),
        webdavRemoteDir: draft.webdavRemoteDir.trim(),
        webdavAutoBackup: draft.webdavAutoBackup,
        webdavPassword: draft.webdavPassword?.trim() || undefined,
      })
    } catch (error) {
      preserveLocalDraftRef.current = false
      throw error
    }
  }

  return (
    <>
      <AlertDialogHeader>
        <AlertDialogTitle>全局设置</AlertDialogTitle>
        <div className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-700">
          <p className="text-sm font-medium text-slate-900 dark:text-slate-100">显示说明</p>
          <Switch
            checked={showHelpText}
            disabled={
              disabled ||
              saving ||
              importing ||
              scanning ||
              backingUp ||
              loadingBackups ||
              restoringBackup !== null ||
              deletingBackup !== null ||
              testingWebdav ||
              importingBackup
            }
            onCheckedChange={setShowHelpText}
          />
        </div>
        {showHelpText ? (
          <AlertDialogDescription>
            当前支持全局配置、固定目录扫描，以及 WebDAV 备份、本地导入与恢复。
          </AlertDialogDescription>
        ) : null}
      </AlertDialogHeader>

      <div className="grid max-h-[70vh] gap-4 overflow-y-auto py-2 pr-1">
        <div className="grid gap-2 rounded-lg border border-slate-200 p-4 dark:border-slate-700">
          <Label htmlFor="themeMode">界面主题</Label>
          <div className="grid grid-cols-3 gap-2" id="themeMode">
            {([
              ['dark', '夜间', 'bg-slate-950 text-white border-slate-950 hover:bg-black'],
              ['light', '日间', 'border-slate-300 bg-slate-100 text-slate-800 hover:bg-slate-200'],
              ['system', '系统', 'border-emerald-500 bg-emerald-500 text-white hover:bg-emerald-600'],
            ] as const).map(([value, label, baseClassName]) => {
              const active = draft.themeMode === value
              return (
                <button
                  key={value}
                  className={[
                    'relative inline-flex h-10 items-center justify-center rounded-lg border px-2.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                    baseClassName,
                    active ? 'border-[#C3B091] ring-1 ring-[#C3B091]' : 'opacity-85',
                  ].join(' ')}
                  disabled={disabled || saving || importing || testingWebdav || importingBackup}
                  onClick={() => {
                    setDraft((current) => ({
                      ...current,
                      themeMode: value,
                    }))
                    onPreviewThemeChange(value)
                  }}
                  type="button"
                >
                  {active ? <Check className="absolute left-2 h-3.5 w-3.5" /> : null}
                  <span>{label}</span>
                </button>
              )
            })}
          </div>
          {showHelpText ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">
              夜间使用深色界面，日间使用浅色界面，系统会跟随当前系统配色。
            </p>
          ) : null}
        </div>

        <div className="grid gap-2 rounded-lg border border-slate-200 p-4 dark:border-slate-700">
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="storagePath">数据文件路径</Label>
            <Button
              disabled={disabled || saving || importing || testingWebdav || importingBackup || !draft.storagePath.trim()}
              onClick={() => {
                void openInExplorer(draft.storagePath.trim()).catch((error) => {
                  onNotify(
                    '打开失败',
                    error instanceof Error ? error.message : '打开目录失败',
                    'error',
                  )
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
            placeholder="例如：C:\\Users\\用户名\\.go-symlink\\state.json"
            value={draft.storagePath}
          />
          {showHelpText ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">
              保存时会迁移当前状态文件到新路径；如果目标文件已存在则不会覆盖。
            </p>
          ) : null}
        </div>


        <div className="grid gap-3 rounded-lg border border-slate-200 p-4 dark:border-slate-700">
          <div className="space-y-1">
            <p className="text-sm font-medium text-slate-900 dark:text-slate-100">固定目录</p>
            {showHelpText ? (
              <p className="text-sm text-slate-500 dark:text-slate-400">
                用于统一扫描系统里已有的文件符号链接和目录 junction。
              </p>
            ) : null}
          </div>

          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              disabled={disabled || saving || scanning || importing || testingWebdav || importingBackup}
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
                disabled={disabled || saving || scanning || importing || testingWebdav || importingBackup}
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
                      disabled={disabled || saving || scanning || importing || testingWebdav || importingBackup}
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
                      disabled={disabled || saving || scanning || importing || testingWebdav || importingBackup}
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

          {showHelpText ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">
              扫描时会使用当前列表；未保存的目录也会参与本次扫描。
            </p>
          ) : null}
        </div>

        <div className="grid gap-3 rounded-lg border border-slate-200 p-4 dark:border-slate-700">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-1">
              <p className="text-sm font-medium text-slate-900 dark:text-slate-100">扫描已有软链接</p>
              {showHelpText ? (
                <p className="text-sm text-slate-500 dark:text-slate-400">
                  扫描全部固定目录，并从结果中勾选加入管理。
                </p>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={
                  disabled ||
                  saving ||
                  scanning ||
                  importing ||
                  testingWebdav ||
                  importingBackup ||
                  draft.managedRoots.length === 0
                }
                onClick={() => void handleScanExisting()}
                type="button"
                variant="outline"
              >
                <RefreshCcw className={`h-4 w-4 ${scanning ? 'animate-spin' : ''}`} />
                {scanning ? '扫描中' : '扫描'}
              </Button>
              <Button
                disabled={
                  disabled ||
                  saving ||
                  scanning ||
                  importing ||
                  testingWebdav ||
                  importingBackup ||
                  scanResults.length === 0
                }
                onClick={selectAllImportable}
                type="button"
                variant="outline"
              >
                全选可导入
              </Button>
              <Button
                disabled={
                  disabled ||
                  saving ||
                  scanning ||
                  importing ||
                  testingWebdav ||
                  importingBackup ||
                  selectedImportItems.length === 0
                }
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
                            disabled={
                              item.alreadyManaged ||
                              disabled ||
                              saving ||
                              scanning ||
                              importing ||
                              testingWebdav ||
                              importingBackup
                            }
                            onChange={(event) => toggleScanSelection(item.id, event.target.checked)}
                            type="checkbox"
                          />
                        </td>
                        <td className="px-3 py-3 text-center align-middle font-medium text-slate-900 dark:text-slate-50">
                          {item.name}
                        </td>
                        <td className="px-3 py-3 text-center align-middle">
                          <div className="flex flex-col items-center gap-1.5">
                            <span
                              className={[
                                'inline-flex min-w-14 items-center justify-center rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset',
                                kindStyles[item.kind],
                              ].join(' ')}
                            >
                              {item.kind === 'file' ? '文件' : '目录'}
                            </span>
                            <div className="text-xs text-slate-500 dark:text-slate-400">
                              {linkTypeLabels[item.linkType]}
                            </div>
                          </div>
                        </td>
                        <td className="px-3 py-3 text-center align-middle text-xs leading-5 text-slate-600 dark:text-slate-300">
                          <button
                            className="inline-flex w-full max-w-[240px] items-center justify-center gap-1 overflow-hidden text-center text-sky-700 hover:text-sky-900 hover:underline dark:text-sky-300 dark:hover:text-sky-200"
                            onClick={() =>
                              void openInExplorer(item.linkPath).catch((error) =>
                                onNotify('打开失败', toErrorMessage(error), 'error'),
                              )
                            }
                            title={item.linkPath}
                            type="button"
                          >
                            <span className="block truncate">{item.linkPath}</span>
                            <ExternalLink className="h-3.5 w-3.5 shrink-0" />
                          </button>
                        </td>
                        <td className="px-3 py-3 text-center align-middle text-xs leading-5 text-slate-600 dark:text-slate-300">
                          <button
                            className="inline-flex w-full max-w-[240px] items-center justify-center gap-1 overflow-hidden text-center text-sky-700 hover:text-sky-900 hover:underline dark:text-sky-300 dark:hover:text-sky-200"
                            onClick={() =>
                              void openInExplorer(item.targetPath).catch((error) =>
                                onNotify('打开失败', toErrorMessage(error), 'error'),
                              )
                            }
                            title={item.targetPath}
                            type="button"
                          >
                            <span className="block truncate">{item.targetPath}</span>
                            <ExternalLink className="h-3.5 w-3.5 shrink-0" />
                          </button>
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
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div className="grid gap-3 rounded-lg border border-slate-200 p-4 dark:border-slate-700">
          <div className="space-y-1">
            <p className="text-sm font-medium text-slate-900 dark:text-slate-100">WebDAV 备份</p>
            {showHelpText ? (
              <p className="text-sm text-slate-500 dark:text-slate-400">
                备份当前 state.json 到 WebDAV，支持本地导入，以及读取远程前 10 个备份后恢复或删除。
              </p>
            ) : null}
          </div>

          <div className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-700">
            <div>
              <p className="text-sm font-medium text-slate-900 dark:text-slate-100">启用 WebDAV 备份</p>
              <p className="text-xs text-slate-500 dark:text-slate-400">关闭后仅保留配置，不执行远程操作。</p>
            </div>
            <Switch
              checked={draft.webdavEnabled}
              disabled={disabled || saving || backingUp || restoringBackup !== null ||
              deletingBackup !== null || testingWebdav || importingBackup}
              onCheckedChange={(checked) => {
                setDraft((current) => ({
                  ...current,
                  webdavEnabled: checked,
                }))
              }}
            />
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            <div className="grid gap-2 sm:col-span-2">
              <Label htmlFor="webdavUrl">服务地址</Label>
              <Input
                id="webdavUrl"
                disabled={disabled || saving || backingUp || restoringBackup !== null ||
              deletingBackup !== null || testingWebdav || importingBackup}
                onChange={(event) => {
                  setDraft((current) => ({
                    ...current,
                    webdavUrl: event.target.value,
                  }))
                }}
                placeholder="例如：https://example.com/dav"
                value={draft.webdavUrl}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="webdavUsername">用户名</Label>
              <Input
                id="webdavUsername"
                disabled={disabled || saving || backingUp || restoringBackup !== null ||
              deletingBackup !== null || testingWebdav || importingBackup}
                onChange={(event) => {
                  setDraft((current) => ({
                    ...current,
                    webdavUsername: event.target.value,
                  }))
                }}
                value={draft.webdavUsername}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="webdavPassword">密码</Label>
              <Input
                id="webdavPassword"
                disabled={disabled || saving || backingUp || restoringBackup !== null ||
              deletingBackup !== null || testingWebdav || importingBackup}
                onChange={(event) => {
                  setDraft((current) => ({
                    ...current,
                    webdavPassword: event.target.value,
                  }))
                }}
                placeholder={hasWebdavPassword ? '已保存密码，留空则不修改' : '请输入 WebDAV 密码'}
                type="password"
                value={draft.webdavPassword ?? ''}
              />
            </div>
            <div className="grid gap-2 sm:col-span-2">
              <Label htmlFor="webdavRemoteDir">远程目录</Label>
              <Input
                id="webdavRemoteDir"
                disabled={disabled || saving || backingUp || restoringBackup !== null ||
              deletingBackup !== null || testingWebdav || importingBackup}
                onChange={(event) => {
                  setDraft((current) => ({
                    ...current,
                    webdavRemoteDir: event.target.value,
                  }))
                }}
                placeholder="例如：softlink/backups"
                value={draft.webdavRemoteDir}
              />
            </div>
          </div>

          <div className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-700">
            <div>
              <p className="text-sm font-medium text-slate-900 dark:text-slate-100">保存设置后自动备份</p>
              <p className="text-xs text-slate-500 dark:text-slate-400">仅在 WebDAV 已启用且配置完整时生效。</p>
            </div>
            <Switch
              checked={draft.webdavAutoBackup}
              disabled={disabled || saving || backingUp || restoringBackup !== null ||
              deletingBackup !== null || testingWebdav || importingBackup}
              onCheckedChange={(checked) => {
                setDraft((current) => ({
                  ...current,
                  webdavAutoBackup: checked,
                }))
              }}
            />
          </div>

          <div className="flex flex-wrap gap-2">
            <Button
              disabled={disabled || saving || backingUp || restoringBackup !== null ||
              deletingBackup !== null || testingWebdav || importingBackup}
              onClick={() => void handleWebdavSave()}
              type="button"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              保存 WebDAV
            </Button>
            <Button
              disabled={disabled || saving || backingUp || restoringBackup !== null ||
              deletingBackup !== null || testingWebdav || importingBackup}
              onClick={() => void handleImportBackup()}
              type="button"
              variant="outline"
            >
              {importingBackup ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              导入备份
            </Button>
            <Button
              disabled={disabled || saving || backingUp || restoringBackup !== null ||
              deletingBackup !== null || testingWebdav || importingBackup || !webdavReady}
              onClick={() => void handleTestWebdav()}
              type="button"
              variant="outline"
            >
              {testingWebdav ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              测试 WebDAV
            </Button>
            <Button
              disabled={disabled || saving || backingUp || restoringBackup !== null ||
              deletingBackup !== null || testingWebdav || importingBackup || !webdavReady}
              onClick={() => void handleBackupNow()}
              type="button"
              variant="outline"
            >
              {backingUp ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              立即备份
            </Button>
            <Button
              disabled={disabled || saving || loadingBackups || restoringBackup !== null ||
              deletingBackup !== null || testingWebdav || importingBackup || !webdavReady}
              onClick={() => void handleLoadBackups()}
              type="button"
              variant="outline"
            >
              <RefreshCcw className={`h-4 w-4 ${loadingBackups ? 'animate-spin' : ''}`} />
              刷新远程列表
            </Button>
          </div>

          {hasWebdavPassword ? (
            <p className="text-xs text-emerald-600 dark:text-emerald-300">当前已存在本地加密保存的 WebDAV 密码。</p>
          ) : (
            <p className="text-xs text-slate-500 dark:text-slate-400">当前还没有本地保存的 WebDAV 密码。</p>
          )}

          <div className="grid gap-2">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-medium text-slate-900 dark:text-slate-100">远程备份列表</p>
              <span className="text-xs text-slate-500 dark:text-slate-400">只展示前 {backupFiles.length} 个文件</span>
            </div>
            {backupFiles.length === 0 ? (
              <div className="rounded-lg border border-dashed border-slate-200 px-4 py-6 text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
                还没有读取到远程备份。点击“刷新远程列表”后可读取远程前 10 个备份并选择恢复。
              </div>
            ) : (
              <div className="rounded-lg border border-slate-200 dark:border-slate-800">
                <table className="min-w-full divide-y divide-slate-200 text-sm dark:divide-slate-800">
                  <thead className="bg-slate-50 text-slate-500 dark:bg-slate-900 dark:text-slate-400">
                    <tr>
                      <th className="px-3 py-3 text-center font-medium">文件名</th>
                      <th className="px-3 py-3 text-center font-medium">创建时间</th>
                      <th className="px-3 py-3 text-center font-medium">大小</th>
                      <th className="px-3 py-3 text-center font-medium">操作</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 bg-white text-slate-700 dark:divide-slate-800 dark:bg-slate-950 dark:text-slate-200">
                    {backupFiles.map((file) => (
                      <tr key={file.name}>
                        <td className="px-3 py-3 text-center align-middle font-medium text-slate-900 dark:text-slate-50">
                          {file.name}
                        </td>
                        <td className="px-3 py-3 text-center align-middle text-xs text-slate-600 dark:text-slate-300">
                          {getBackupCreatedAt(file)}
                        </td>
                        <td className="px-3 py-3 text-center align-middle text-xs text-slate-600 dark:text-slate-300">
                          {file.size == null ? '-' : `${file.size} B`}
                        </td>
                        <td className="px-3 py-3 text-center align-middle">
                          <div className="flex justify-center gap-2">
                            <Button
                              aria-label={`恢复 ${file.name}`}
                              className="px-2"
                              disabled={
                                disabled ||
                                saving ||
                                backingUp ||
                                loadingBackups ||
                                restoringBackup !== null ||
                                deletingBackup !== null ||
                                testingWebdav ||
                                importingBackup
                              }
                              onClick={() => void handleRestore(file.name)}
                              size="sm"
                              title={`恢复 ${file.name}`}
                              type="button"
                              variant="outline"
                            >
                              {restoringBackup === file.name ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
                            </Button>
                            <Button
                              aria-label={`删除 ${file.name}`}
                              className="px-2"
                              disabled={
                                disabled ||
                                saving ||
                                backingUp ||
                                loadingBackups ||
                                restoringBackup !== null ||
                                deletingBackup !== null ||
                                testingWebdav ||
                                importingBackup
                              }
                              onClick={() => void handleDeleteBackup(file.name)}
                              size="sm"
                              title={`删除 ${file.name}`}
                              type="button"
                              variant="destructive"
                            >
                              {deletingBackup === file.name ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>

      <AlertDialogFooter>
        <AlertDialogCancel
          disabled={
            saving ||
            importing ||
            scanning ||
            backingUp ||
            loadingBackups ||
            restoringBackup !== null ||
              deletingBackup !== null ||
            testingWebdav ||
            importingBackup
          }
          onClick={() => onPreviewThemeChange(null)}
        >
          取消
        </AlertDialogCancel>
        <Button
          disabled={
            disabled ||
            saving ||
            importing ||
            scanning ||
            backingUp ||
            loadingBackups ||
            restoringBackup !== null ||
              deletingBackup !== null ||
            testingWebdav ||
            importingBackup ||
            !draft.storagePath.trim()
          }
          onClick={() =>
            void onSubmit({
              ...settings,
              themeMode: draft.themeMode,
              storagePath: draft.storagePath.trim(),
              managedRoots: draft.managedRoots.map((item) => item.trim()).filter(Boolean),
              webdavPassword: undefined,
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
