import { useEffect, useMemo, useState } from 'react'
import { Link2, Settings } from 'lucide-react'
import { Toaster, toast } from 'sonner'

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
import {
  createLinkJob,
  deleteLinkJob,
  getAppState,
  getConflictMessage,
  refreshLinkStatus,
  toErrorMessage,
  updateSettings,
} from '@/lib/api'
import type {
  AppStateResponse,
  CreateLinkRequest,
  DeleteLinkRequest,
  ManagedLink,
  ThemeMode,
  UpdateSettingsRequest,
} from '@/lib/types'

type ConflictState =
  | { type: 'create'; request: CreateLinkRequest; message: string }
  | { type: 'delete'; request: DeleteLinkRequest; message: string }
  | null

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
  const [deleteCandidate, setDeleteCandidate] = useState<ManagedLink | null>(null)
  const [conflictState, setConflictState] = useState<ConflictState>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [previewThemeMode, setPreviewThemeMode] = useState<ThemeMode | null>(null)

  const themeMode: ThemeMode = previewThemeMode ?? appState?.settings.themeMode ?? 'system'

  useEffect(() => {
    void loadState()
  }, [])

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

  async function handleSettingsChange(settings: UpdateSettingsRequest) {
    setSavingSettings(true)

    try {
      const nextState = await updateSettings(settings)
      setAppState(nextState)
      setPreviewThemeMode(null)
      setSettingsOpen(false)
      toast.success('设置已保存')
    } catch (error) {
      toast.error(toErrorMessage(error))
    } finally {
      setSavingSettings(false)
    }
  }

  async function runCreate(request: CreateLinkRequest) {
    setSubmitting(true)

    try {
      const nextState = await createLinkJob(request)
      setAppState(nextState)
      setCreateOpen(false)
      setConflictState(null)
      toast.success('链接已创建，真实内容已移动到目标位置')
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

      toast.error(toErrorMessage(error))
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
      toast.success('链接已删除')
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

      toast.error(toErrorMessage(error))
    } finally {
      setDeletingId(null)
    }
  }

  async function handleRefresh() {
    setRefreshing(true)

    try {
      const nextState = await refreshLinkStatus()
      setAppState(nextState)
      toast.success('状态已刷新')
    } catch (error) {
      toast.error(toErrorMessage(error))
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
            <CardTitle>正在加载 SoftLink Manager</CardTitle>
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
                  <div className="text-lg font-semibold tracking-tight text-slate-900 dark:text-slate-50">Windows 软链接管理器</div>
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
              refreshing={refreshing}
            />
          </section>
        ) : (
          <div className="flex justify-center">
            <Button onClick={() => void loadState()} type="button">重试</Button>
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
              onImported={(nextState) => setAppState(nextState)}
              onPreviewThemeChange={setPreviewThemeMode}
              onSubmit={handleSettingsChange}
              saving={savingSettings}
              settings={appState.settings}
              storagePath={appState.storagePath}
            />
          ) : null}
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={createOpen} onOpenChange={setCreateOpen}>
        <AlertDialogContent>
          <CreateLinkForm
            disabled={savingSettings || deletingId !== null}
            onSubmit={runCreate}
            submitting={submitting}
          />
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
                ? deleteCandidate.managementMode === 'tracked'
                  ? `将仅从管理列表移除 ${deleteCandidate.name}，不会改动当前系统里的现有链接。`
                  : appState?.settings.restoreOnDelete
                    ? `将删除 ${deleteCandidate.name} 的原路径链接，并尝试把真实内容还原到 ${deleteCandidate.linkPath}。`
                    : `将删除 ${deleteCandidate.name} 的原路径链接，真实内容会保留在 ${deleteCandidate.targetPath}。`
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
            <AlertDialogTitle>检测到同名冲突</AlertDialogTitle>
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

                void runDelete({
                  ...conflictState.request,
                  overwriteConflict: true,
                })
              }}
            >
              覆盖继续
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Toaster position="top-right" richColors theme={themeMode} />
    </>
  )
}

export default App
