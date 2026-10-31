import { useCallback, useState } from 'react'

/** 跟踪一组并发的异步操作：任一操作进行中时 busy 为 true，isBusy(key) 用于显示单个按钮的加载态 */
export function useBusy() {
  const [active, setActive] = useState<readonly string[]>([])

  const run = useCallback(async <T>(key: string, task: () => Promise<T>): Promise<T> => {
    setActive((current) => [...current, key])
    try {
      return await task()
    } finally {
      setActive((current) => {
        const index = current.indexOf(key)
        return index === -1 ? current : [...current.slice(0, index), ...current.slice(index + 1)]
      })
    }
  }, [])

  const isBusy = useCallback((key: string) => active.includes(key), [active])

  return { busy: active.length > 0, isBusy, run }
}

export type BusyTracker = ReturnType<typeof useBusy>
