import { useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { Check, Loader2, RefreshCcw, Trash2, Upload } from 'lucide-react'

import { EmptyHint, SectionTitle, SettingsSection } from '@/components/settings/section'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import type { BusyTracker } from '@/hooks/use-busy'
import type { ShowFeedback } from '@/hooks/use-feedback'
import {
  backupStateToWebdav,
  deleteWebdavBackup,
  importBackupFile,
  listWebdavBackups,
  restoreStateFromWebdav,
  testWebdavConnection,
  toErrorMessage,
} from '@/lib/api'
import type { AppStateResponse, UpdateSettingsRequest, WebdavBackupFile } from '@/lib/types'
import { cn } from '@/lib/utils'

export type WebdavDraft = Pick<
  UpdateSettingsRequest,
  'webdavEnabled' | 'webdavUrl' | 'webdavUsername' | 'webdavRemoteDir' | 'webdavAutoBackup' | 'webdavPassword'
>

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

interface WebdavSectionProps {
  draft: WebdavDraft
  hasWebdavPassword: boolean
  locked: boolean
  showHelp: boolean
  tasks: BusyTracker
  onDraftChange: (patch: Partial<WebdavDraft>) => void
  onSave: () => Promise<void>
  onRestored: (nextState: AppStateResponse) => void
  onNotify: ShowFeedback
}

export function WebdavSection({
  draft,
  hasWebdavPassword,
  locked,
  showHelp,
  tasks,
  onDraftChange,
  onSave,
  onRestored,
  onNotify,
}: WebdavSectionProps) {
  const [backupFiles, setBackupFiles] = useState<WebdavBackupFile[]>([])

  const webdavReady =
    draft.webdavEnabled &&
    draft.webdavUrl.trim() !== '' &&
    draft.webdavUsername.trim() !== '' &&
    draft.webdavRemoteDir.trim() !== '' &&
    (hasWebdavPassword || !!draft.webdavPassword?.trim())

  async function loadBackups(silent = false) {
    await tasks.run('list-backups', async () => {
      try {
        const files = await listWebdavBackups()
        setBackupFiles(files)
        if (!silent) {
          onNotify('读取成功', `共读取 ${files.length} 个远程备份。`, 'success')
        }
      } catch (error) {
        onNotify('读取失败', toErrorMessage(error), 'error')
      }
    })
  }

  async function handleBackupNow() {
    await tasks.run('backup', async () => {
      try {
        const fileName = await backupStateToWebdav()
        onNotify('备份成功', `已上传到 WebDAV：${fileName}`, 'success')
      } catch (error) {
        onNotify('备份失败', toErrorMessage(error), 'error')
        return
      }
      await loadBackups(true)
    })
  }

  async function handleRestore(fileName: string) {
    await tasks.run(`restore:${fileName}`, async () => {
      try {
        const nextState = await restoreStateFromWebdav({ fileName })
        onRestored(nextState)
        onNotify('恢复成功', `已从 ${fileName} 恢复配置。`, 'success')
      } catch (error) {
        onNotify('恢复失败', toErrorMessage(error), 'error')
      }
    })
  }

  async function handleDelete(fileName: string) {
    if (!window.confirm(`确认删除远程备份 ${fileName} 吗？此操作不可恢复。`)) {
      return
    }

    await tasks.run(`delete:${fileName}`, async () => {
      try {
        await deleteWebdavBackup({ fileName })
        onNotify('删除成功', `已删除远程备份：${fileName}`, 'success')
      } catch (error) {
        onNotify('删除失败', toErrorMessage(error), 'error')
        return
      }
      await loadBackups(true)
    })
  }

  async function handleTest() {
    await tasks.run('test', async () => {
      try {
        const result = await testWebdavConnection({
          webdavEnabled: draft.webdavEnabled,
          webdavUrl: draft.webdavUrl.trim(),
          webdavUsername: draft.webdavUsername.trim(),
          webdavRemoteDir: draft.webdavRemoteDir.trim(),
          webdavPassword: draft.webdavPassword?.trim() ? draft.webdavPassword : undefined,
        })
        onNotify('测试成功', result.message, 'success')
      } catch (error) {
        onNotify('测试失败', toErrorMessage(error), 'error')
      }
    })
  }

  async function handleImportFile() {
    const selected = await open({
      multiple: false,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })

    if (typeof selected !== 'string') {
      return
    }

    await tasks.run('import-file', async () => {
      try {
        const nextState = await importBackupFile({ filePath: selected })
        onRestored(nextState)
        onNotify('导入成功', `已导入本地备份：${selected.split(/[/\\]/).pop() ?? selected}`, 'success')
      } catch (error) {
        onNotify('导入失败', toErrorMessage(error), 'error')
      }
    })
  }

  return (
    <SettingsSection>
      <SectionTitle
        help="备份当前 state.json 到 WebDAV，支持本地导入，以及读取远程备份后恢复或删除。"
        showHelp={showHelp}
        title="WebDAV 备份"
      />

      <div className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-700">
        <div>
          <p className="text-sm font-medium text-slate-900 dark:text-slate-100">启用 WebDAV 备份</p>
          <p className="text-xs text-slate-500 dark:text-slate-400">关闭后仅保留配置，不执行远程操作。</p>
        </div>
        <Switch
          checked={draft.webdavEnabled}
          disabled={locked}
          onCheckedChange={(checked) => onDraftChange({ webdavEnabled: checked })}
        />
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <div className="grid gap-2 sm:col-span-2">
          <Label htmlFor="webdavUrl">服务地址</Label>
          <Input
            id="webdavUrl"
            disabled={locked}
            onChange={(event) => onDraftChange({ webdavUrl: event.target.value })}
            placeholder="例如：https://example.com/dav"
            value={draft.webdavUrl}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="webdavUsername">用户名</Label>
          <Input
            id="webdavUsername"
            disabled={locked}
            onChange={(event) => onDraftChange({ webdavUsername: event.target.value })}
            value={draft.webdavUsername}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="webdavPassword">密码</Label>
          <Input
            id="webdavPassword"
            disabled={locked}
            onChange={(event) => onDraftChange({ webdavPassword: event.target.value })}
            placeholder={hasWebdavPassword ? '已保存密码，留空则不修改' : '请输入 WebDAV 密码'}
            type="password"
            value={draft.webdavPassword ?? ''}
          />
        </div>
        <div className="grid gap-2 sm:col-span-2">
          <Label htmlFor="webdavRemoteDir">远程目录</Label>
          <Input
            id="webdavRemoteDir"
            disabled={locked}
            onChange={(event) => onDraftChange({ webdavRemoteDir: event.target.value })}
            placeholder="例如：softlink/backups"
            value={draft.webdavRemoteDir}
          />
        </div>
      </div>

      <div className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-700">
        <div>
          <p className="text-sm font-medium text-slate-900 dark:text-slate-100">数据变更后自动备份</p>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            保存设置、创建/删除/迁移链接后在后台上传；仅在 WebDAV 已启用且配置完整时生效。
          </p>
        </div>
        <Switch
          checked={draft.webdavAutoBackup}
          disabled={locked}
          onCheckedChange={(checked) => onDraftChange({ webdavAutoBackup: checked })}
        />
      </div>

      <div className="flex flex-wrap gap-2">
        <Button disabled={locked} onClick={() => void onSave()} type="button">
          保存 WebDAV
        </Button>
        <Button disabled={locked} onClick={() => void handleImportFile()} type="button" variant="outline">
          {tasks.isBusy('import-file') ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
          导入备份
        </Button>
        <Button disabled={locked || !webdavReady} onClick={() => void handleTest()} type="button" variant="outline">
          {tasks.isBusy('test') ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
          测试 WebDAV
        </Button>
        <Button disabled={locked || !webdavReady} onClick={() => void handleBackupNow()} type="button" variant="outline">
          {tasks.isBusy('backup') ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
          立即备份
        </Button>
        <Button disabled={locked || !webdavReady} onClick={() => void loadBackups()} type="button" variant="outline">
          <RefreshCcw className={cn('h-4 w-4', tasks.isBusy('list-backups') && 'animate-spin')} />
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
          <EmptyHint>还没有读取到远程备份。点击“刷新远程列表”后可读取远程备份并选择恢复。</EmptyHint>
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
                    <td className="px-3 py-3 text-center align-middle font-medium text-slate-900 dark:text-slate-50">{file.name}</td>
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
                          disabled={locked}
                          onClick={() => void handleRestore(file.name)}
                          size="sm"
                          title={`恢复 ${file.name}`}
                          type="button"
                          variant="outline"
                        >
                          {tasks.isBusy(`restore:${file.name}`) ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <RefreshCcw className="h-4 w-4" />
                          )}
                        </Button>
                        <Button
                          aria-label={`删除 ${file.name}`}
                          className="px-2"
                          disabled={locked}
                          onClick={() => void handleDelete(file.name)}
                          size="sm"
                          title={`删除 ${file.name}`}
                          type="button"
                          variant="destructive"
                        >
                          {tasks.isBusy(`delete:${file.name}`) ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Trash2 className="h-4 w-4" />
                          )}
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
    </SettingsSection>
  )
}
