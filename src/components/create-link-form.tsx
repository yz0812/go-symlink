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
  onSubmit: (request: CreateLinkRequest) => Promise<void>
}

export function CreateLinkForm({
  disabled = false,
  submitting = false,
  onSubmit,
}: CreateLinkFormProps) {
  const [name, setName] = useState('')
  const [linkPath, setLinkPath] = useState('')
  const [targetPath, setTargetPath] = useState('')

  async function pickLinkDirectory() {
    const selected = await open({
      multiple: false,
      directory: true,
    })

    if (typeof selected === 'string') {
      setLinkPath(selected)
    }
  }

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
          选择现有文件或目录，再选择真实内容的新存放目录。应用会移动真实内容，并在原路径留下受管链接。
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
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="sourcePath">源文件 / 目录</Label>
            <div className="flex flex-wrap gap-2">
              <Button disabled={disabled || submitting} onClick={pickSourceFile} size="sm" type="button" variant="outline">
                <FolderOpen className="h-4 w-4" />
                选文件
              </Button>
              <Button disabled={disabled || submitting} onClick={pickSourceDirectory} size="sm" type="button" variant="outline">
                <FolderOpen className="h-4 w-4" />
                选目录
              </Button>
            </div>
          </div>
          <Input
            id="sourcePath"
            disabled={disabled || submitting}
            onChange={(event) => setSourcePath(event.target.value)}
            placeholder="例如：C:\\Users\\Administrator\\Desktop\\demo.txt"
            value={sourcePath}
          />
        </div>

        <div className="grid gap-2">
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="destinationDir">目标存放目录</Label>
            <Button disabled={disabled || submitting} onClick={pickDestinationDirectory} size="sm" type="button" variant="outline">
              <FolderOpen className="h-4 w-4" />
              选目录
            </Button>
          </div>
          <Input
            id="destinationDir"
            disabled={disabled || submitting}
            onChange={(event) => setDestinationDir(event.target.value)}
            placeholder="例如：D:\\Archive"
            value={destinationDir}
          />
        </div>

        <p className="text-sm text-slate-500 dark:text-slate-400">创建前会校验源路径、目标目录以及同名冲突。</p>
      </form>

      <AlertDialogFooter>
        <AlertDialogCancel disabled={submitting}>取消</AlertDialogCancel>
        <Button form="create-link-form" disabled={disabled || submitting || !sourcePath.trim() || !destinationDir.trim()} type="submit">
          {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          创建并移动
        </Button>
      </AlertDialogFooter>
    </>
  )
}
