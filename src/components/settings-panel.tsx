import { useState } from 'react'
import { Loader2 } from 'lucide-react'

import { GeneralSection } from '@/components/settings/general-section'
import { ScanImportSection } from '@/components/settings/scan-import-section'
import { WebdavSection, type WebdavDraft } from '@/components/settings/webdav-section'
import {
  AlertDialogCancel,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { useBusy } from '@/hooks/use-busy'
import type { ShowFeedback } from '@/hooks/use-feedback'
import type { AppSettings, AppStateResponse, ThemeMode, UpdateSettingsRequest } from '@/lib/types'

interface SettingsPanelProps {
  settings: AppSettings
  storagePath: string
  hasWebdavPassword: boolean
  disabled?: boolean
  saving?: boolean
  onSubmit: (settings: UpdateSettingsRequest) => Promise<void>
  onWebdavSubmit: (settings: UpdateSettingsRequest) => Promise<void>
  onImported: (nextState: AppStateResponse) => void
  onNotify: ShowFeedback
  onOpenPath: (path: string, select?: boolean) => void
  onPreviewThemeChange: (themeMode: ThemeMode | null) => void
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
  onOpenPath,
  onPreviewThemeChange,
}: SettingsPanelProps) {
  const [draft, setDraft] = useState<UpdateSettingsRequest>({
    ...settings,
    storagePath,
    webdavPassword: '',
  })
  const [showHelp, setShowHelp] = useState(false)
  const [syncedFrom, setSyncedFrom] = useState({ settings, storagePath })
  const [preserveLocalDraft, setPreserveLocalDraft] = useState(false)
  const tasks = useBusy()

  const locked = disabled || saving || tasks.busy

  // 外部设置变化时同步草稿；单独保存 WebDAV 时只同步 WebDAV 字段，保留其他未保存的修改
  if (syncedFrom.settings !== settings || syncedFrom.storagePath !== storagePath) {
    setSyncedFrom({ settings, storagePath })
    setDraft((current) =>
      preserveLocalDraft
        ? {
            ...current,
            webdavEnabled: settings.webdavEnabled,
            webdavUrl: settings.webdavUrl,
            webdavUsername: settings.webdavUsername,
            webdavRemoteDir: settings.webdavRemoteDir,
            webdavAutoBackup: settings.webdavAutoBackup,
            webdavPassword: '',
          }
        : { ...settings, storagePath, webdavPassword: '' },
    )
  }

  function patchDraft(patch: Partial<UpdateSettingsRequest>) {
    setDraft((current) => ({ ...current, ...patch }))
  }

  async function handleWebdavSave() {
    setPreserveLocalDraft(true)
    try {
      await onWebdavSubmit({
        ...settings,
        storagePath,
        webdavEnabled: draft.webdavEnabled,
        webdavUrl: draft.webdavUrl.trim(),
        webdavUsername: draft.webdavUsername.trim(),
        webdavRemoteDir: draft.webdavRemoteDir.trim(),
        webdavAutoBackup: draft.webdavAutoBackup,
        webdavPassword: draft.webdavPassword?.trim() ? draft.webdavPassword : undefined,
      })
    } finally {
      setPreserveLocalDraft(false)
    }
  }

  const webdavDraft: WebdavDraft = {
    webdavEnabled: draft.webdavEnabled,
    webdavUrl: draft.webdavUrl,
    webdavUsername: draft.webdavUsername,
    webdavRemoteDir: draft.webdavRemoteDir,
    webdavAutoBackup: draft.webdavAutoBackup,
    webdavPassword: draft.webdavPassword,
  }

  return (
    <>
      <AlertDialogHeader>
        <AlertDialogTitle>全局设置</AlertDialogTitle>
        <div className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-700">
          <p className="text-sm font-medium text-slate-900 dark:text-slate-100">显示说明</p>
          <Switch checked={showHelp} disabled={locked} onCheckedChange={setShowHelp} />
        </div>
        {showHelp ? (
          <AlertDialogDescription>当前支持全局配置、固定目录扫描，以及 WebDAV 备份、本地导入与恢复。</AlertDialogDescription>
        ) : null}
      </AlertDialogHeader>

      <div className="grid max-h-[70vh] gap-4 overflow-y-auto py-2 pr-1">
        <GeneralSection
          locked={locked}
          onOpenPath={onOpenPath}
          onStoragePathChange={(value) => patchDraft({ storagePath: value })}
          onThemeChange={(value) => {
            patchDraft({ themeMode: value })
            onPreviewThemeChange(value)
          }}
          showHelp={showHelp}
          storagePath={draft.storagePath}
          themeMode={draft.themeMode}
        />

        <ScanImportSection
          locked={locked}
          managedRoots={draft.managedRoots}
          onImported={(nextState) => {
            onImported(nextState)
            onPreviewThemeChange(draft.themeMode)
          }}
          onManagedRootsChange={(roots) => patchDraft({ managedRoots: roots })}
          onNotify={onNotify}
          onOpenPath={onOpenPath}
          showHelp={showHelp}
          tasks={tasks}
        />

        <WebdavSection
          draft={webdavDraft}
          hasWebdavPassword={hasWebdavPassword}
          locked={locked}
          onDraftChange={patchDraft}
          onNotify={onNotify}
          onRestored={(nextState) => {
            onImported(nextState)
            onPreviewThemeChange(nextState.settings.themeMode)
          }}
          onSave={handleWebdavSave}
          showHelp={showHelp}
          tasks={tasks}
        />
      </div>

      <AlertDialogFooter>
        <AlertDialogCancel disabled={saving || tasks.busy} onClick={() => onPreviewThemeChange(null)}>
          取消
        </AlertDialogCancel>
        <Button
          disabled={locked || !draft.storagePath.trim()}
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
