import { invoke } from '@tauri-apps/api/core'

import type {
  AppStateResponse,
  CreateLinkRequest,
  DeleteLinkRequest,
  ImportExistingLinksRequest,
  ScanExistingLinksRequest,
  ScannedLink,
  UpdateSettingsRequest,
} from './types'

type TauriInternals = {
  invoke?: unknown
}

declare global {
  interface Window {
    __TAURI_INTERNALS__?: TauriInternals
  }
}

function ensureTauriAvailable() {
  if (typeof window === 'undefined') {
    throw new Error('当前运行环境不可用')
  }

  if (typeof window.__TAURI_INTERNALS__?.invoke !== 'function') {
    throw new Error('当前运行在浏览器模式，请使用 `npm run tauri dev` 启动桌面应用。')
  }
}

async function invokeCommand<T>(command: string, payload?: Record<string, unknown>) {
  ensureTauriAvailable()
  return payload ? invoke<T>(command, payload) : invoke<T>(command)
}

export async function getAppState() {
  return invokeCommand<AppStateResponse>('get_app_state')
}

export async function refreshLinkStatus() {
  return invokeCommand<AppStateResponse>('refresh_link_status')
}

export async function updateSettings(settings: UpdateSettingsRequest) {
  return invokeCommand<AppStateResponse>('update_settings', { settings })
}

export async function createLinkJob(request: CreateLinkRequest) {
  return invokeCommand<AppStateResponse>('create_link_job', { request })
}

export async function deleteLinkJob(request: DeleteLinkRequest) {
  return invokeCommand<AppStateResponse>('delete_link_job', { request })
}

export async function scanExistingLinks(request: ScanExistingLinksRequest) {
  return invokeCommand<ScannedLink[]>('scan_existing_links', { request })
}

export async function importExistingLinks(request: ImportExistingLinksRequest) {
  return invokeCommand<AppStateResponse>('import_existing_links', { request })
}

export async function openInExplorer(path: string) {
  return invokeCommand<void>('open_in_explorer', { path })
}

export function toErrorMessage(error: unknown) {
  if (typeof error === 'string') {
    return error
  }

  if (error instanceof Error) {
    return error.message
  }

  if (error && typeof error === 'object' && 'message' in error) {
    const { message } = error as { message?: unknown }
    if (typeof message === 'string') {
      return message
    }
  }

  return '发生未知错误'
}

export function getConflictMessage(error: unknown) {
  const message = toErrorMessage(error)
  if (!message.startsWith('CONFLICT:')) {
    return null
  }

  return message.slice('CONFLICT:'.length).trim() || '检测到路径冲突'
}
