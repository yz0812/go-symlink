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
import type { CreateLinkRequest } from '@/lib/types'

interface CreateLinkFormProps {
  disabled?: boolean
  submitting?: boolean
  errors?: {
    linkPath?: string
    targetPath?: string
  }
  onSubmit: (request: CreateLinkRequest) => Promise<void>
}

export function CreateLinkForm({
  disabled = false,
  submitting = false,
  errors,
  onSubmit,
}: CreateLinkFormProps) {
  const [name, setName] = useState('')
  const [linkPath, setLinkPath] = useState('')
  const [targetPath, setTargetPath] = useState('')

  async function pickTargetFile() {
    const selected = await open({
      multiple: false,
      directory: false,
    })

    if (typeof selected === 'string') {
      setTargetPath(selected)
    }
  }

  async function pickTargetDirectory() {
    const selected = await open({
      multiple: false,
      directory: true,
    })

    if (typeof selected === 'string') {
      setTargetPath(selected)
    }
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()

    if (!linkPath.trim() || !targetPath.trim()) {
      return
    }

    const trimmedName = name.trim()

    await onSubmit({
      name: trimmedName || undefined,
      linkPath: linkPath.trim(),
      targetPath: targetPath.trim(),
    })
  }

  return (
    <>
      <AlertDialogHeader>
        <AlertDialogTitle>新建链接</AlertDialogTitle>
        <AlertDialogDescription>
          填写原路径和现有真实目标。应用只创建受管链接，不移动或修改真实文件。
        </AlertDialogDescription>
      </AlertDialogHeader>

      <form className="grid gap-5" id="create-link-form" onSubmit={handleSubmit}>
        <div className="grid gap-2">
          <Label htmlFor="linkName">名称（可选）</Label>
          <Input
            id="linkName"
            disabled={disabled || submitting}
            onChange={(event) => setName(event.target.value)}
            placeholder="例如：项目素材库"
            value={name}
          />
        </div>

        <div className="grid gap-2">
          <Label htmlFor="linkPath">原路径</Label>
          <Input
            aria-invalid={errors?.linkPath ? true : undefined}
            className={errors?.linkPath ? 'border-red-500 focus-visible:ring-red-300 dark:border-red-500 dark:focus-visible:ring-red-500/40' : undefined}
            id="linkPath"
            disabled={disabled || submitting}
            onChange={(event) => setLinkPath(event.target.value)}
            placeholder="例如：C:\\Users\\Administrator\\Desktop\\demo.txt"
            value={linkPath}
          />
          {errors?.linkPath ? <p className="text-sm text-red-600 dark:text-red-400">{errors.linkPath}</p> : null}
        </div>

        <div className="grid gap-2">
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="targetPath">真实目标</Label>
            <div className="flex flex-wrap gap-2">
              <Button disabled={disabled || submitting} onClick={pickTargetFile} size="sm" type="button" variant="outline">
                <FolderOpen className="h-4 w-4" />
                选文件
              </Button>
              <Button disabled={disabled || submitting} onClick={pickTargetDirectory} size="sm" type="button" variant="outline">
                <FolderOpen className="h-4 w-4" />
                选目录
              </Button>
            </div>
          </div>
          <Input
            aria-invalid={errors?.targetPath ? true : undefined}
            className={errors?.targetPath ? 'border-red-500 focus-visible:ring-red-300 dark:border-red-500 dark:focus-visible:ring-red-500/40' : undefined}
            id="targetPath"
            disabled={disabled || submitting}
            onChange={(event) => setTargetPath(event.target.value)}
            placeholder="例如：D:\\Archive\\demo.txt"
            value={targetPath}
          />
          {errors?.targetPath ? <p className="text-sm text-red-600 dark:text-red-400">{errors.targetPath}</p> : null}
        </div>

        <p className="text-sm text-slate-500 dark:text-slate-400">创建前会检查原路径和真实目标。若原路径已存在空目录或现有链接，会先提示确认；若已存在真实文件、非空目录或其他内容，则不会直接覆盖。</p>
      </form>

      <AlertDialogFooter>
        <AlertDialogCancel disabled={submitting}>取消</AlertDialogCancel>
        <Button form="create-link-form" disabled={disabled || submitting || !linkPath.trim() || !targetPath.trim()} type="submit">
          {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          创建链接
        </Button>
      </AlertDialogFooter>
    </>
  )
}
