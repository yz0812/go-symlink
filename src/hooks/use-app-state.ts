import { useCallback, useState } from 'react'

import { getAppState, refreshLinkStatus, toErrorMessage } from '@/lib/api'
import type { AppStateResponse } from '@/lib/types'

/** 应用状态的加载与刷新；各类变更操作直接用 setAppState 写入后端返回的新状态 */
export function useAppState() {
  const [appState, setAppState] = useState<AppStateResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)

    try {
      setAppState(await getAppState())
    } catch (error) {
      setLoadError(toErrorMessage(error))
    } finally {
      setLoading(false)
    }
  }, [])

  /** 重新检查所有链接状态，失败时抛出错误由调用方决定是否提示 */
  const refresh = useCallback(async () => {
    setRefreshing(true)

    try {
      setAppState(await refreshLinkStatus())
    } finally {
      setRefreshing(false)
    }
  }, [])

  return { appState, setAppState, loading, loadError, refreshing, load, refresh }
}
