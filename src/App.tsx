import { useEffect, useMemo, useState } from 'react'
import { Link2, Settings } from 'lucide-react'

import { CreateLinkForm } from '@/components/create-link-form'
import { FeedbackToast } from '@/components/feedback-toast'
import { LinkDetailsDialog } from '@/components/link-details-dialog'
import { LinkTable } from '@/components/link-table'
import { MigrateForm, MoveProgressBar } from '@/components/migrate-form'
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
import { useAppState } from '@/hooks/use-app-state'
import { useFeedback } from '@/hooks/use-feedback'
import { useTauriEvent, useWindowFocus } from '@/hooks/use-tauri'
import { useTheme } from '@/hooks/use-theme'
import {
  cancelMigration,
  createLinkJob,
  deleteLinkJob,
  getConflictMessage,
  migrateAndLink,
  openInExplorer,
  renameLinkJob,
  repairLinkJobs,
  revertLinkJob,
  toAppError,
  toErrorMessage,
  updateSettings,
} from '@/lib/api'
import type {
  AppStateResponse,
  AutoBackupEvent,
  CreateLinkRequest,
  DeleteLinkRequest,
  ManagedLink,
  MigrateRequest,
  MoveProgress,
  RenameLinkRequest,
  ThemeMode,
  UpdateSettingsRequest,
} from '@/lib/types'

type ConflictState =
  | { type: 'create'; request: CreateLinkRequest; message: string }
  | { type: 'delete'; request: DeleteLinkRequest; message: string }
  | null

type CreateFieldErrors = {
  linkPath?: string
  targetPath?: string
}

type MigrateFieldErrors = {
  sourcePath?: string
  destinationDir?: string
}

// 窗口获得焦点时自动刷新状态的最小间隔
const FOCUS_REFRESH_INTERVAL_MS = 2000

function getCreateFieldErrors(error: unknown): CreateFieldErrors | null {
  const { field, message } = toAppError(error)

  if (field === 'linkPath') {
    return { linkPath: message }
  }

  if (field === 'targetPath') {
    return { targetPath: message }
  }

  return null
}

function App() {
  const { appState, setAppState, loading, loadError, refreshing, load, refresh } = useAppState()
  const { feedback, closing: feedbackClosing, show: showFeedback, hide: hideFeedback } = useFeedback()
  const [savingSettings, setSavingSettings] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [deleteCandidate, setDeleteCandidate] = useState<ManagedLink | null>(null)
  const [viewCandidate, setViewCandidate] = useState<ManagedLink | null>(null)
  const [renameCandidate, setRenameCandidate] = useState<ManagedLink | null>(null)
  const [renameInput, setRenameInput] = useState('')
  const [conflictState, setConflictState] = useState<ConflictState>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [createFieldErrors, setCreateFieldErrors] = useState<CreateFieldErrors>({})
  const [previewThemeMode, setPreviewThemeMode] = useState<ThemeMode | null>(null)
  const [migrateOpen, setMigrateOpen] = useState(false)
  const [migrateFieldErrors, setMigrateFieldErrors] = useState<MigrateFieldErrors>({})
  const [moving, setMoving] = useState(false)
  const [moveProgress, setMoveProgress] = useState<MoveProgress | null>(null)
  const [revertCandidate, setRevertCandidate] = useState<ManagedLink | null>(null)
  const [repairing, setRepairing] = useState(false)
  const [repairPrompt, setRepairPrompt] = useState<ManagedLink[] | null>(null)
  const [batchDeleteCandidates, setBatchDeleteCandidates] = useState<ManagedLink[] | null>(null)
  const [batchDeleting, setBatchDeleting] = useState(false)

  const themeMode: ThemeMode = previewThemeMode ?? appState?.settings.themeMode ?? 'system'
  const operationRunning =
    savingSettings || submitting || moving || repairing || batchDeleting || deletingId !== null || renamingId !== null

  useTheme(themeMode)

  useEffect(() => {
    void load()
  }, [load])

  // 自动备份在后台执行，结果通过 auto-backup 事件推送
  useTauriEvent<AutoBackupEvent>('auto-backup', ({ payload }) => {
    if (payload.error) {
      showFeedback('自动备份失败', payload.error, 'error')
    } else if (payload.fileName) {
      showFeedback('自动备份完成', `已备份为 ${payload.fileName}。`, 'success')
    }
  })

  useTauriEvent<MoveProgress>('migrate-progress', ({ payload }) => setMoveProgress(payload))

  // 用户可能在资源管理器里改动了链接，切回窗口时静默刷新；有操作进行中时跳过，避免覆盖其结果
  useWindowFocus(() => {
    if (appState && !operationRunning && !refreshing) {
      void refresh().catch(() => undefined)
    }
  }, FOCUS_REFRESH_INTERVAL_MS)

  useEffect(() => {
    if (appState?.stateWarning) {
      showFeedback('数据文件已从备份恢复', appState.stateWarning, 'error')
    }
  }, [appState?.stateWarning, showFeedback])

  function openPath(path: string, select = false) {
    void openInExplorer(path, select).catch((error) => {
      showFeedback('打开失败', toErrorMessage(error), 'error')
    })
  }

  async function handleSettingsChange(settings: UpdateSettingsRequest) {
    setSavingSettings(true)

    try {
      const nextState = await updateSettings(settings)
      setAppState(nextState)
      setPreviewThemeMode(null)
      setSettingsOpen(false)

      showFeedback('保存成功', '设置已保存。', 'success')
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

      showFeedback('WebDAV 已保存', '已保存 WebDAV 配置。', 'success')
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

  /** 逐条删除；遇到需要确认覆盖的冲突项直接跳过，避免批量操作误删真实内容 */
  async function runBatchDelete(links: ManagedLink[]) {
    setBatchDeleting(true)
    const failures: string[] = []

    try {
      for (const link of links) {
        try {
          setAppState(await deleteLinkJob({ id: link.id }))
        } catch (error) {
          const reason = getConflictMessage(error) ? '原路径已被其他内容占用，已跳过' : toErrorMessage(error)
          failures.push(`${link.name}：${reason}`)
        }
      }
    } finally {
      setBatchDeleting(false)
      setBatchDeleteCandidates(null)
    }

    if (failures.length === 0) {
      showFeedback('删除成功', `已删除 ${links.length} 个链接。`, 'destructive')
    } else {
      showFeedback(
        failures.length === links.length ? '删除失败' : '部分删除失败',
        failures.length === 1 ? failures[0] : `${failures.length} 个链接未删除，例如 ${failures[0]}`,
        'error',
      )
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

  async function runMigrate(request: MigrateRequest) {
    setMoving(true)
    setMoveProgress(null)
    setMigrateFieldErrors({})

    try {
      const { state, warning } = await migrateAndLink(request)
      setAppState(state)
      setMigrateOpen(false)
      if (warning) {
        showFeedback('迁移完成', warning, 'error')
      } else {
        showFeedback('迁移完成', '内容已移动，并在原位置创建了链接。', 'success')
      }
    } catch (error) {
      const { field, message } = toAppError(error)
      if (field === 'sourcePath' || field === 'destinationDir') {
        setMigrateFieldErrors({ [field]: message })
        return
      }

      showFeedback('迁移失败', message, 'error')
    } finally {
      setMoving(false)
      setMoveProgress(null)
    }
  }

  async function runRevert(link: ManagedLink) {
    setMoving(true)
    setMoveProgress(null)

    try {
      const { state, warning } = await revertLinkJob({ id: link.id })
      setAppState(state)
      setRevertCandidate(null)
      setViewCandidate(null)
      if (warning) {
        showFeedback('撤销完成', warning, 'error')
      } else {
        showFeedback('撤销完成', `已把内容移回 ${link.linkPath}。`, 'success')
      }
    } catch (error) {
      showFeedback('撤销失败', toErrorMessage(error), 'error')
    } finally {
      setMoving(false)
      setMoveProgress(null)
    }
  }

  async function runRepair(links: ManagedLink[]) {
    setRepairing(true)

    try {
      const { state, failures } = await repairLinkJobs({ ids: links.map((link) => link.id) })
      setAppState(state)
      setRepairPrompt(null)

      if (failures.length === 0) {
        showFeedback('修复完成', `已重建 ${links.length} 个链接。`, 'success')
      } else {
        const first = failures[0]
        const detail = `${first.name || first.id}：${first.message}`
        showFeedback(
          '部分修复失败',
          failures.length === 1 ? detail : `${failures.length} 个链接修复失败，例如 ${detail}`,
          'error',
        )
      }
    } catch (error) {
      showFeedback('修复失败', toErrorMessage(error), 'error')
    } finally {
      setRepairing(false)
    }
  }

  /** 导入或恢复备份后，如果有链接缺失，提示用户一键重建（新电脑恢复时常见） */
  function handleImported(nextState: AppStateResponse) {
    setAppState(nextState)
    const missing = nextState.links.filter((link) => link.status === 'missing-link')
    if (missing.length > 0) {
      setRepairPrompt(missing)
    }
  }

  async function handleRefresh() {
    try {
      await refresh()
      showFeedback('刷新成功', '状态已刷新。', 'success')
    } catch (error) {
      showFeedback('刷新失败', toErrorMessage(error), 'error')
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
              batchDeleting={batchDeleting}
              deletingId={deletingId}
              links={appState.links}
              onBatchDelete={setBatchDeleteCandidates}
              onCreate={() => setCreateOpen(true)}
              onDelete={setDeleteCandidate}
              onMigrate={() => setMigrateOpen(true)}
              onRepair={(links) => void runRepair(links)}
              onRefresh={() => void handleRefresh()}
              onRename={(link) => {
                setRenameCandidate(link)
                setRenameInput(link.name)
              }}
              onView={setViewCandidate}
              refreshing={refreshing}
              renamingId={renamingId}
              repairing={repairing}
            />
          </section>
        ) : (
          <div className="flex justify-center">
            <Button onClick={() => void load()} type="button">
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
              onImported={handleImported}
              onNotify={showFeedback}
              onOpenPath={openPath}
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
        open={migrateOpen}
        onOpenChange={(open) => {
          // 迁移进行中不允许关闭对话框，只能通过“取消迁移”中止
          if (moving) {
            return
          }
          setMigrateOpen(open)
          if (!open) {
            setMigrateFieldErrors({})
          }
        }}
      >
        <AlertDialogContent>
          <MigrateForm
            disabled={savingSettings || deletingId !== null}
            errors={migrateFieldErrors}
            onCancelMigration={() => void cancelMigration()}
            onSubmit={runMigrate}
            progress={moveProgress}
            submitting={moving}
          />
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={revertCandidate !== null}
        onOpenChange={(open) => {
          if (!open && !moving) {
            setRevertCandidate(null)
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>撤销这个链接？</AlertDialogTitle>
            <AlertDialogDescription>
              {revertCandidate
                ? `将删除链接 ${revertCandidate.linkPath}，把真实内容从 ${revertCandidate.targetPath} 移回原位置，并移除这条记录。`
                : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {moving ? <MoveProgressBar progress={moveProgress} /> : null}
          <AlertDialogFooter>
            {moving ? (
              <Button onClick={() => void cancelMigration()} type="button" variant="outline">
                取消
              </Button>
            ) : (
              <AlertDialogCancel>取消</AlertDialogCancel>
            )}
            <Button
              disabled={moving}
              onClick={() => {
                if (revertCandidate) {
                  void runRevert(revertCandidate)
                }
              }}
              type="button"
            >
              {moving ? '处理中' : '确认撤销'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={repairPrompt !== null}
        onOpenChange={(open) => {
          if (!open && !repairing) {
            setRepairPrompt(null)
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>发现缺失的链接</AlertDialogTitle>
            <AlertDialogDescription>
              {`有 ${repairPrompt?.length ?? 0} 条记录的真实目标存在但链接缺失，是否按记录全部重建？`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={repairing}>稍后处理</AlertDialogCancel>
            <Button
              disabled={repairing}
              onClick={() => {
                if (repairPrompt) {
                  void runRepair(repairPrompt)
                }
              }}
              type="button"
            >
              {repairing ? '修复中' : '全部修复'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <LinkDetailsDialog
        link={viewCandidate}
        onClose={() => setViewCandidate(null)}
        onOpenPath={openPath}
        onRevert={setRevertCandidate}
      />

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
        open={batchDeleteCandidates !== null}
        onOpenChange={(open) => {
          if (!open && !batchDeleting) {
            setBatchDeleteCandidates(null)
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{`确认删除选中的 ${batchDeleteCandidates?.length ?? 0} 个链接？`}</AlertDialogTitle>
            <AlertDialogDescription>
              会从系统中删除这些链接并移除记录，不会修改真实目标。原路径已被其他内容占用的项会被跳过。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={batchDeleting}>取消</AlertDialogCancel>
            <Button
              disabled={batchDeleting}
              onClick={() => {
                if (batchDeleteCandidates) {
                  void runBatchDelete(batchDeleteCandidates)
                }
              }}
              type="button"
              variant="destructive"
            >
              {batchDeleting ? '删除中' : '确认删除'}
            </Button>
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

      <FeedbackToast closing={feedbackClosing} feedback={feedback} onClose={hideFeedback} />
    </>
  )
}

export default App
