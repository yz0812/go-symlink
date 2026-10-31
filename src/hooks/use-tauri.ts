import { useEffect, useRef } from 'react'
import { listen, type EventCallback, type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { getCurrentWindow } from '@tauri-apps/api/window'

import { isTauriAvailable } from '@/lib/api'

/** 保存最新的回调，避免回调变化时反复注销/注册 Tauri 监听 */
function useLatest<T>(value: T) {
  const ref = useRef(value)
  useEffect(() => {
    ref.current = value
  })
  return ref
}

/** 订阅 Tauri 事件，组件卸载时自动注销；浏览器预览模式下不做任何事 */
function useTauriSubscription(subscribe: () => Promise<UnlistenFn>) {
  const subscribeRef = useLatest(subscribe)

  useEffect(() => {
    if (!isTauriAvailable()) {
      return
    }

    let disposed = false
    let unlisten: UnlistenFn | null = null

    void subscribeRef.current().then((dispose) => {
      if (disposed) {
        dispose()
      } else {
        unlisten = dispose
      }
    })

    return () => {
      disposed = true
      unlisten?.()
    }
  }, [subscribeRef])
}

export function useTauriEvent<T>(event: string, handler: EventCallback<T>) {
  const handlerRef = useLatest(handler)
  useTauriSubscription(() => listen<T>(event, (payload) => handlerRef.current(payload)))
}

/** 文件拖放到窗口时回调第一个路径，用于预填表单 */
export function useDroppedPath(onPath: (path: string) => void) {
  const handlerRef = useLatest(onPath)
  useTauriSubscription(() =>
    getCurrentWebview().onDragDropEvent(({ payload }) => {
      if (payload.type === 'drop' && payload.paths.length > 0) {
        handlerRef.current(payload.paths[0])
      }
    }),
  )
}

/** 窗口重新获得焦点时回调，minIntervalMs 内最多触发一次 */
export function useWindowFocus(onFocus: () => void, minIntervalMs: number) {
  const handlerRef = useLatest(onFocus)
  const lastRef = useRef(0)

  useTauriSubscription(() =>
    getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      const now = Date.now()
      if (focused && now - lastRef.current >= minIntervalMs) {
        lastRef.current = now
        handlerRef.current()
      }
    }),
  )
}
