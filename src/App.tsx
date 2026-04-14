import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Check, Link2, Settings, Trash2, X } from 'lucide-react'

import { CreateLinkForm } from '@/components/create-link-form'
import { LinkTable } from '@/components/link-table'
import { SettingsPanel } from '@/components/settings-panel'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  createLinkJob,
  deleteLinkJob,
  getAppState,
  getConflictMessage,
  openInExplorer,
  refreshLinkStatus,
  renameLinkJob,
  toErrorMessage,
  updateSettings,
} from '@/lib/api'
import { cn } from '@/lib/utils'
import type {
  AppStateResponse,
  CreateLinkRequest,
  DeleteLinkRequest,
  ManagedLink,
  RenameLinkRequest,
  ThemeMode,
  UpdateSettingsRequest,
} from '@/lib/types'

type ConflictState =
  | { type: 'create'; request: CreateLinkRequest; message: string }
  | { type: 'delete'; request: DeleteLinkRequest; message: string }
  | null

type FeedbackTone = 'success' | 'error' | 'destructive'

type FeedbackState =
  | {
      id: number
      title: string
      message: string
      tone: FeedbackTone
    }
  | null

type CreateFieldErrors = {
  linkPath?: string
  targetPath?: string
}

const detailLinkTypeLabels = {
  'file-symlink': '文件符号链接',
  'directory-symlink': '目录符号链接',
  junction: '目录联接',
} satisfies Record<ManagedLink['linkType'], string>

const detailManagementModeLabels = {
  managed: '应用管理',
  tracked: '仅记录',
} satisfies Record<ManagedLink['managementMode'], string>

function getCreateFieldErrors(error: unknown): CreateFieldErrors | null {
  const message = toErrorMessage(error)

  if (message.startsWith('链接路径缺少父目录：') || message.startsWith('链接父目录不存在：')) {
    return { linkPath: message }
  }

  if (message.startsWith('目标路径不存在：')) {
    return { targetPath: message }
  }

  return null
}

function getFeedbackIconClassName(tone: FeedbackTone) {
  if (tone === 'success') {
    return 'bg-emerald-50 text-emerald-600 ring-1 ring-inset ring-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-300 dark:ring-emerald-500/20'
  }

  if (tone === 'destructive') {
    return 'bg-red-50 text-red-600 ring-1 ring-inset ring-red-200 dark:bg-red-500/15 dark:text-red-300 dark:ring-red-500/20'
  }

  return 'bg-amber-50 text-amber-600 ring-1 ring-inset ring-amber-200 dark:bg-amber-500/15 dark:text-amber-300 dark:ring-amber-500/20'
}

function getLinkKindClassName(kind: ManagedLink['kind']) {
  return kind === 'file'
    ? 'bg-sky-50 text-sky-700 ring-sky-200 dark:bg-sky-500/15 dark:text-sky-300 dark:ring-sky-500/20'
    : 'bg-violet-50 text-violet-700 ring-violet-200 dark:bg-violet-500/15 dark:text-violet-300 dark:ring-violet-500/20'
}

function getLinkStatusClassName(status: ManagedLink['status']) {
  if (status === 'healthy') {
    return 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-300 dark:ring-emerald-500/20'
  }

  if (status === 'missing-link') {
    return 'bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-500/15 dark:text-amber-300 dark:ring-amber-500/20'
  }

  if (status === 'missing-target') {
    return 'bg-orange-50 text-orange-700 ring-orange-200 dark:bg-orange-500/15 dark:text-orange-300 dark:ring-orange-500/20'
  }

  return 'bg-red-50 text-red-700 ring-red-200 dark:bg-red-500/15 dark:text-red-300 dark:ring-red-500/20'
}

function isDarkMode(themeMode: ThemeMode, mediaQuery: MediaQueryList) {
  return themeMode === 'dark' || (themeMode === 'system' && mediaQuery.matches)
}

function App() {
  const [appState, setAppState] = useState<AppStateResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [savingSettings, setSavingSettings] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [deleteCandidate, setDeleteCandidate] = useState<ManagedLink | null>(null)
  const [viewCandidate, setViewCandidate] = useState<ManagedLink | null>(null)
  const [renameCandidate, setRenameCandidate] = useState<ManagedLink | null>(null)
  const [renameInput, setRenameInput] = useState('')
  const [conflictState, setConflictState] = useState<ConflictState>(null)
  const [feedbackState, setFeedbackState] = useState<FeedbackState>(null)
  const [feedbackClosing, setFeedbackClosing] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [createFieldErrors, setCreateFieldErrors] = useState<CreateFieldErrors>({})
  const [previewThemeMode, setPreviewThemeMode] = useState<ThemeMode | null>(null)

  const feedbackIdRef = useRef(0)

  const themeMode: ThemeMode = previewThemeMode ?? appState?.settings.themeMode ?? 'system'

  useEffect(() => {
    void loadState()
  }, [])

  useEffect(() => {
    if (!feedbackState || feedbackState.tone === 'error') {
      return
    }

    const timer = window.setTimeout(() => {
      setFeedbackClosing(true)
    }, 1000)

    return () => {
      window.clearTimeout(timer)
    }
  }, [feedbackState])

  useEffect(() => {
    if (!feedbackClosing || !feedbackState) {
      return
    }

    const closingId = feedbackState.id
    const timer = window.setTimeout(() => {
      setFeedbackState((current) => (current?.id === closingId ? null : current))
      setFeedbackClosing(false)
    }, 160)

    return () => {
      window.clearTimeout(timer)
    }
  }, [feedbackClosing, feedbackState])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    const applyTheme = () => {
      document.documentElement.classList.toggle('dark', isDarkMode(themeMode, mediaQuery))
    }

    applyTheme()

    if (themeMode !== 'system') {
      return
    }

    mediaQuery.addEventListener('change', applyTheme)
    return () => {
      mediaQuery.removeEventListener('change', applyTheme)
    }
  }, [themeMode])

  async function loadState() {
    setLoading(true)
    setLoadError(null)

    try {
      const nextState = await getAppState()
      setAppState(nextState)
    } catch (error) {
      setLoadError(toErrorMessage(error))
    } finally {
      setLoading(false)
    }
  }

  function hideFeedback() {
    setFeedbackClosing(true)
  }

  function showFeedback(title: string, message: string, tone: FeedbackTone) {
    feedbackIdRef.current += 1
    setFeedbackClosing(false)
    setFeedbackState({
      id: feedbackIdRef.current,
      title,
      message,
      tone,
    })
  }

  async function handleSettingsChange(settings: UpdateSettingsRequest) {
    setSavingSettings(true)

    try {
      const nextState = await updateSettings(settings)
      setAppState(nextState)
      setPreviewThemeMode(null)
      setSettingsOpen(false)

      if (nextState.lastAutoBackupError) {
        showFeedback('设置已保存', `自动备份失败：${nextState.lastAutoBackupError}`, 'error')
      } else if (nextState.lastAutoBackupFile) {
        showFeedback('保存成功', `设置已保存，并自动备份为 ${nextState.lastAutoBackupFile}。`, 'success')
      } else {
        showFeedback('保存成功', '设置已保存。', 'success')
      }
    } catch (error) {
      showFeedback('保存失败', toErrorMessage(error), 'error')
    } finally {
      setSavingSettings(false)
    }
  }

  async function handleWebdavSettingsChange(settings: UpdateSettingsRequest) {
    setSavingSettings(true)

    try {
      const nextState = await updateSettings(settings)
      setAppState(nextState)

      if (nextState.lastAutoBackupError) {
        showFeedback('WebDAV 已保存', `自动备份失败：${nextState.lastAutoBackupError}`, 'error')
      } else if (nextState.lastAutoBackupFile) {
        showFeedback('WebDAV 已保存', `已保存 WebDAV 配置，并自动备份为 ${nextState.lastAutoBackupFile}。`, 'success')
      } else {
        showFeedback('WebDAV 已保存', '已保存 WebDAV 配置。', 'success')
      }
    } catch (error) {
      showFeedback('保存失败', toErrorMessage(error), 'error')
    } finally {
      setSavingSettings(false)
    }
  }

  async function runCreate(request: CreateLinkRequest) {
    setSubmitting(true)
    setCreateFieldErrors({})

    try {
      const nextState = await createLinkJob(request)
      setAppState(nextState)
      setCreateOpen(false)
      setConflictState(null)
      setCreateFieldErrors({})
      showFeedback('创建成功', '链接已创建。', 'success')
    } catch (error) {
      const conflictMessage = getConflictMessage(error)
      if (conflictMessage) {
        setConflictState({
          type: 'create',
          request,
          message: conflictMessage,
        })
        return
      }

      const fieldErrors = getCreateFieldErrors(error)
      if (fieldErrors) {
        setCreateFieldErrors(fieldErrors)
        return
      }

      showFeedback('创建失败', toErrorMessage(error), 'error')
    } finally {
      setSubmitting(false)
    }
  }

  async function runDelete(request: DeleteLinkRequest) {
    setDeletingId(request.id)

    try {
      const nextState = await deleteLinkJob(request)
      setAppState(nextState)
      setDeleteCandidate(null)
      setConflictState(null)
      showFeedback('删除成功', '链接已删除。', 'destructive')
    } catch (error) {
      const conflictMessage = getConflictMessage(error)
      if (conflictMessage) {
        setConflictState({
          type: 'delete',
          request,
          message: conflictMessage,
        })
        return
      }

      showFeedback('删除失败', toErrorMessage(error), 'error')
    } finally {
      setDeletingId(null)
    }
  }

  async function runRename(request: RenameLinkRequest) {
    setRenamingId(request.id)

    try {
      const nextState = await renameLinkJob(request)
      setAppState(nextState)
      setRenameCandidate(null)
      setRenameInput('')
      showFeedback('修改成功', '名称已更新。', 'success')
    } catch (error) {
      showFeedback('修改失败', toErrorMessage(error), 'error')
    } finally {
      setRenamingId(null)
    }
  }

  async function handleRefresh() {
    setRefreshing(true)

    try {
      const nextState = await refreshLinkStatus()
      setAppState(nextState)
      showFeedback('刷新成功', '状态已刷新。', 'success')
    } catch (error) {
      showFeedback('刷新失败', toErrorMessage(error), 'error')
    } finally {
      setRefreshing(false)
    }
  }

  const summary = useMemo(() => {
    if (!appState) {
      return { total: 0, healthy: 0, warnings: 0 }
    }

    const healthy = appState.links.filter((item) => item.status === 'healthy').length
    return {
      total: appState.links.length,
      healthy,
      warnings: appState.links.length - healthy,
    }
  }, [appState])

  if (loading) {
    return (
      <main className="mx-auto flex min-h-[50vh] w-full max-w-6xl items-center justify-center px-6 py-12">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>正在加载 go-symlink</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-slate-500 dark:text-slate-400">
            正在读取本地配置和已管理链接状态。
          </CardContent>
        </Card>
      </main>
    )
  }

  return (
    <>
      <main className="mx-auto flex h-full min-h-full w-full max-w-7xl flex-col gap-4 px-4 py-4 sm:px-6 sm:py-5 lg:px-8">
        <section className="shrink-0">
          <Card className="overflow-hidden border-slate-200 bg-gradient-to-r from-emerald-50 via-white to-sky-50 shadow-sm dark:border-slate-800 dark:from-emerald-950/40 dark:via-slate-950 dark:to-sky-950/40">
            <CardContent className="space-y-4 p-4 sm:p-5">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-white text-emerald-600 ring-1 ring-inset ring-emerald-100 dark:bg-slate-900 dark:text-emerald-300 dark:ring-emerald-500/20">
                    <Link2 className="h-4 w-4" />
                  </div>
                  <div className="text-lg font-semibold tracking-tight text-slate-900 dark:text-slate-50">
                    Windows 软链接管理器
                  </div>
                </div>
                <Button
                  className="border-slate-200 bg-white text-slate-700 hover:bg-slate-50 hover:text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800 dark:hover:text-slate-50"
                  onClick={() => setSettingsOpen(true)}
                  type="button"
                  variant="outline"
                >
                  <Settings className="h-4 w-4" />
                  设置
                </Button>
              </div>
              <div className="grid gap-3 text-sm sm:grid-cols-3">
                <div className="rounded-xl border border-sky-100 bg-sky-50 p-4 text-sky-700 dark:border-sky-500/20 dark:bg-sky-500/10 dark:text-sky-300">
                  <div className="text-2xl font-semibold text-slate-900 dark:text-slate-50">{summary.total}</div>
                  <div className="mt-1 text-sky-700/80 dark:text-sky-300/80">已管理链接</div>
                </div>
                <div className="rounded-xl border border-emerald-100 bg-emerald-50 p-4 text-emerald-700 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-300">
                  <div className="text-2xl font-semibold text-slate-900 dark:text-slate-50">{summary.healthy}</div>
                  <div className="mt-1 text-emerald-700/80 dark:text-emerald-300/80">状态正常</div>
                </div>
                <div className="rounded-xl border border-amber-100 bg-amber-50 p-4 text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-300">
                  <div className="text-2xl font-semibold text-slate-900 dark:text-slate-50">{summary.warnings}</div>
                  <div className="mt-1 text-amber-700/80 dark:text-amber-300/80">需要处理</div>
                </div>
              </div>
            </CardContent>
          </Card>
        </section>

        {loadError ? (
          <Alert className="shrink-0 border-red-200 bg-red-50 text-red-700 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-300">
            <AlertTitle>初始化失败</AlertTitle>
            <AlertDescription>{loadError}</AlertDescription>
          </Alert>
        ) : null}

        {appState ? (
          <section className="min-h-0 flex-1">
            <LinkTable
              deletingId={deletingId}
              links={appState.links}
              onCreate={() => setCreateOpen(true)}
              onDelete={setDeleteCandidate}
              onRefresh={handleRefresh}
              onRename={(link) => {
                setRenameCandidate(link)
                setRenameInput(link.name)
              }}
              onView={setViewCandidate}
              refreshing={refreshing}
              renamingId={renamingId}
            />
          </section>
        ) : (
          <div className="flex justify-center">
            <Button onClick={() => void loadState()} type="button">
              重试
            </Button>
          </div>
        )}
      </main>

      <AlertDialog
        open={settingsOpen}
        onOpenChange={(open) => {
          setSettingsOpen(open)
          if (!open) {
            setPreviewThemeMode(null)
          }
        }}
      >
        <AlertDialogContent className="max-w-6xl">
          {appState ? (
            <SettingsPanel
              disabled={submitting || deletingId !== null}
              hasWebdavPassword={appState.hasWebdavPassword}
              onImported={(nextState) => setAppState(nextState)}
              onNotify={showFeedback}
              onPreviewThemeChange={setPreviewThemeMode}
              onSubmit={handleSettingsChange}
              onWebdavSubmit={handleWebdavSettingsChange}
              saving={savingSettings}
              settings={appState.settings}
              storagePath={appState.storagePath}
            />
          ) : null}
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={createOpen}
        onOpenChange={(open) => {
          setCreateOpen(open)
          if (!open) {
            setCreateFieldErrors({})
          }
        }}
      >
        <AlertDialogContent>
          <CreateLinkForm
            disabled={savingSettings || deletingId !== null}
            errors={createFieldErrors}
            onSubmit={runCreate}
            submitting={submitting}
          />
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={viewCandidate !== null}
        onOpenChange={(open) => {
          if (!open) {
            setViewCandidate(null)
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>链接详情</AlertDialogTitle>
            <AlertDialogDescription>查看当前受管链接的完整信息。</AlertDialogDescription>
          </AlertDialogHeader>
          {viewCandidate ? (
            <div className="grid gap-3 text-sm">
              <div className="grid gap-1">
                <div className="text-slate-500 dark:text-slate-400">名称</div>
                <div className="break-all font-medium text-slate-900 dark:text-slate-50">{viewCandidate.name}</div>
              </div>
              <div className="grid gap-1">
                <div className="text-slate-500 dark:text-slate-400">原路径</div>
                <button
                  className="w-full rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-left text-sky-700 transition-colors hover:bg-sky-100 dark:border-sky-500/20 dark:bg-sky-500/10 dark:text-sky-300 dark:hover:bg-sky-500/15"
                  onClick={() => {
                    void openInExplorer(viewCandidate.linkPath).catch((error) => {
                      showFeedback(
                        '打开失败',
                        error instanceof Error ? error.message : '打开目录失败',
                        'error',
                      )
                    })
                  }}
                  type="button"
                >
                  <span className="block break-all">{viewCandidate.linkPath}</span>
                </button>
              </div>
              <div className="grid gap-1">
                <div className="text-slate-500 dark:text-slate-400">真实目标</div>
                <button
                  className="w-full rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-left text-emerald-700 transition-colors hover:bg-emerald-100 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-300 dark:hover:bg-emerald-500/15"
                  onClick={() => {
                    void openInExplorer(viewCandidate.targetPath).catch((error) => {
                      showFeedback(
                        '打开失败',
                        error instanceof Error ? error.message : '打开目录失败',
                        'error',
                      )
                    })
                  }}
                  type="button"
                >
                  <span className="block break-all">{viewCandidate.targetPath}</span>
                </button>
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="grid gap-1">
                  <div className="text-slate-500 dark:text-slate-400">类型</div>
                  <div>
                    <span
                      className={cn(
                        'inline-flex rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset',
                        getLinkKindClassName(viewCandidate.kind),
                      )}
                    >
                      {viewCandidate.kind === 'file' ? '文件' : '目录'}
                    </span>
                  </div>
                </div>
                <div className="grid gap-1">
                  <div className="text-slate-500 dark:text-slate-400">链接方式</div>
                  <div className="text-slate-900 dark:text-slate-50">{detailLinkTypeLabels[viewCandidate.linkType]}</div>
                </div>
                <div className="grid gap-1">
                  <div className="text-slate-500 dark:text-slate-400">管理方式</div>
                  <div className="text-slate-900 dark:text-slate-50">{detailManagementModeLabels[viewCandidate.managementMode]}</div>
                </div>
                <div className="grid gap-1 sm:col-span-3">
                  <div className="text-slate-500 dark:text-slate-400">状态</div>
                  <div>
                    <span
                      className={cn(
                        'inline-flex rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset',
                        getLinkStatusClassName(viewCandidate.status),
                      )}
                    >
                      {viewCandidate.statusText}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel>关闭</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={renameCandidate !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRenameCandidate(null)
            setRenameInput('')
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>修改链接名称</AlertDialogTitle>
            <AlertDialogDescription>
              这里只会修改展示名称，不会改动原路径、真实目标或链接类型。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="grid gap-2">
            <Input
              autoFocus
              disabled={renamingId !== null}
              onChange={(event) => setRenameInput(event.target.value)}
              placeholder="请输入名称"
              value={renameInput}
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={renamingId !== null}>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault()
                if (!renameCandidate) {
                  return
                }
                void runRename({
                  id: renameCandidate.id,
                  name: renameInput,
                })
              }}
            >
              {renamingId !== null ? '保存中' : '保存'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={deleteCandidate !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteCandidate(null)
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除这个受管链接？</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteCandidate
                ? `将删除 ${deleteCandidate.name} 的链接 ${deleteCandidate.linkPath}；若当前链接仍存在，会一并从系统删除，不会修改真实目标 ${deleteCandidate.targetPath}。`
                : '删除前请确认当前设置。'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault()
                if (!deleteCandidate) {
                  return
                }
                void runDelete({ id: deleteCandidate.id })
              }}
            >
              确认删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={conflictState !== null}
        onOpenChange={(open) => {
          if (!open) {
            setConflictState(null)
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>检测到原路径文件存在</AlertDialogTitle>
            <AlertDialogDescription>{conflictState?.message}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault()
                if (!conflictState) {
                  return
                }

                if (conflictState.type === 'create') {
                  void runCreate({
                    ...conflictState.request,
                    overwriteConflict: true,
                  })
                  return
                }

                void runDelete(conflictState.request)
              }}
            >
              覆盖继续
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {feedbackState ? (
        <div className="pointer-events-none fixed inset-0 z-[70] flex items-center justify-center px-4">
          <section
            aria-live="polite"
            className={cn(
              'pointer-events-auto relative grid w-full max-w-[20rem] gap-3 rounded-2xl border border-slate-200/90 bg-white/95 px-4 py-4 text-center shadow-lg backdrop-blur-sm transition-[opacity,transform] duration-150 ease-out dark:border-slate-800/90 dark:bg-slate-950/95',
              feedbackClosing ? 'translate-y-2 scale-[0.98] opacity-0' : 'translate-y-0 scale-100 opacity-100',
            )}
            role="status"
          >
            <button
              aria-label="关闭提示"
              className="absolute right-2.5 top-2.5 inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-50 dark:focus-visible:ring-slate-700"
              onClick={hideFeedback}
              type="button"
            >
              <X className="h-3.5 w-3.5" />
            </button>

            <div className="flex justify-center pt-1">
              <div className={`inline-flex h-10 w-10 items-center justify-center rounded-full ${getFeedbackIconClassName(feedbackState.tone)}`}>
                {feedbackState.tone === 'destructive' ? (
                  <Trash2 className="h-5 w-5" />
                ) : feedbackState.tone === 'success' ? (
                  <Check className="h-5 w-5" />
                ) : (
                  <AlertTriangle className="h-5 w-5" />
                )}
              </div>
            </div>

            <div className="flex flex-col gap-1 text-center">
              <h2 className="text-sm font-semibold text-slate-950 dark:text-slate-50">{feedbackState.title}</h2>
              <p className="text-xs leading-5 text-slate-600 dark:text-slate-400">{feedbackState.message}</p>
            </div>
          </section>
        </div>
      ) : null}
    </>
  )
}

export default App
