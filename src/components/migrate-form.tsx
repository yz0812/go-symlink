import { useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { FolderOpen, Loader2 } from 'lucide-react'

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
import type { MigrateRequest, MoveProgress } from '@/lib/types'

function formatBytes(bytes: number) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
}

export function MoveProgressBar({ progress }: { progress: MoveProgress | null }) {
  const percent =
    progress && progress.totalBytes > 0
      ? Math.min(100, Math.round((progress.copiedBytes / progress.totalBytes) * 100))
      : null

  return (
    <div className="grid gap-2">
      <div className="h-2 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
        <div
          className={
            percent === null
              ? 'h-full w-1/3 animate-pulse rounded-full bg-emerald-500'
              : 'h-full rounded-full bg-emerald-500 transition-[width] duration-150'
          }
          style={percent === null ? undefined : { width: `${percent}%` }}
        />
      </div>
      <div className="flex justify-between gap-3 text-xs text-slate-500 dark:text-slate-400">
        <span className="truncate">{progress?.currentPath || '正在处理…'}</span>
        {progress && progress.totalBytes > 0 ? (
          <span className="shrink-0">
            {formatBytes(progress.copiedBytes)} / {formatBytes(progress.totalBytes)}
          </span>
        ) : null}
      </div>
    </div>
  )
}

interface MigrateFormProps {
  disabled?: boolean
  submitting?: boolean
  progress: MoveProgress | null
  errors?: {
    sourcePath?: string
    destinationDir?: string
  }
  onSubmit: (request: MigrateRequest) => Promise<void>
  onCancelMigration: () => void
}

export function MigrateForm({
  disabled = false,
  submitting = false,
  progress,
  errors,
  onSubmit,
  onCancelMigration,
}: MigrateFormProps) {
  const [name, setName] = useState('')
  const [sourcePath, setSourcePath] = useState('')
  const [destinationDir, setDestinationDir] = useState('')

  async function pickSource(directory: boolean) {
    const selected = await open({ multiple: false, directory })
    if (typeof selected === 'string') {
      setSourcePath(selected)
    }
  }

  async function pickDestination() {
    const selected = await open({ multiple: false, directory: true })
    if (typeof selected === 'string') {
      setDestinationDir(selected)
    }
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()

    if (!sourcePath.trim() || !destinationDir.trim()) {
      return
    }

    await onSubmit({
      name: name.trim() || undefined,
      sourcePath: sourcePath.trim(),
      destinationDir: destinationDir.trim(),
    })
  }

  const inputDisabled = disabled || submitting
  const errorClassName = 'border-red-500 focus-visible:ring-red-300 dark:border-red-500 dark:focus-visible:ring-red-500/40'

  return (
    <>
      <AlertDialogHeader>
        <AlertDialogTitle>迁移并创建链接</AlertDialogTitle>
        <AlertDialogDescription>
          把文件或目录移动到目标目录，并在原位置创建链接，原有程序仍按旧路径访问。适合把 C 盘的大目录挪到其他磁盘。
        </AlertDialogDescription>
      </AlertDialogHeader>

      <form className="grid gap-5" id="migrate-form" onSubmit={handleSubmit}>
        <div className="grid gap-2">
          <Label htmlFor="migrateName">名称（可选）</Label>
          <Input
            id="migrateName"
            disabled={inputDisabled}
            onChange={(event) => setName(event.target.value)}
            placeholder="例如：微信文件"
            value={name}
          />
        </div>

        <div className="grid gap-2">
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="migrateSource">要迁移的内容</Label>
            <div className="flex flex-wrap gap-2">
              <Button disabled={inputDisabled} onClick={() => void pickSource(false)} size="sm" type="button" variant="outline">
                <FolderOpen className="h-4 w-4" />
                选文件
              </Button>
              <Button disabled={inputDisabled} onClick={() => void pickSource(true)} size="sm" type="button" variant="outline">
                <FolderOpen className="h-4 w-4" />
                选目录
              </Button>
            </div>
          </div>
          <Input
            aria-invalid={errors?.sourcePath ? true : undefined}
            className={errors?.sourcePath ? errorClassName : undefined}
            id="migrateSource"
            disabled={inputDisabled}
            onChange={(event) => setSourcePath(event.target.value)}
            placeholder="例如：C:\\Users\\Administrator\\Documents\\WeChat Files"
            value={sourcePath}
          />
          {errors?.sourcePath ? <p className="text-sm text-red-600 dark:text-red-400">{errors.sourcePath}</p> : null}
        </div>

        <div className="grid gap-2">
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="migrateDestination">移动到目录</Label>
            <Button disabled={inputDisabled} onClick={() => void pickDestination()} size="sm" type="button" variant="outline">
              <FolderOpen className="h-4 w-4" />
              选目录
            </Button>
          </div>
          <Input
            aria-invalid={errors?.destinationDir ? true : undefined}
            className={errors?.destinationDir ? errorClassName : undefined}
            id="migrateDestination"
            disabled={inputDisabled}
            onChange={(event) => setDestinationDir(event.target.value)}
            placeholder="例如：D:\\Migrated"
            value={destinationDir}
          />
          {errors?.destinationDir ? (
            <p className="text-sm text-red-600 dark:text-red-400">{errors.destinationDir}</p>
          ) : null}
        </div>

        {submitting ? (
          <MoveProgressBar progress={progress} />
        ) : (
          <p className="text-sm text-slate-500 dark:text-slate-400">
            同一磁盘内直接移动；跨磁盘会先复制再删除原内容，期间可取消，失败会自动还原。迁移前请关闭正在使用这些文件的程序。
          </p>
        )}
      </form>

      <AlertDialogFooter>
        {submitting ? (
          <Button onClick={onCancelMigration} type="button" variant="outline">
            取消迁移
          </Button>
        ) : (
          <AlertDialogCancel>取消</AlertDialogCancel>
        )}
        <Button
          form="migrate-form"
          disabled={inputDisabled || !sourcePath.trim() || !destinationDir.trim()}
          type="submit"
        >
          {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          开始迁移
        </Button>
      </AlertDialogFooter>
    </>
  )
}
