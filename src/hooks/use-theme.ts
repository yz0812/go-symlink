import { useEffect } from 'react'

import type { ThemeMode } from '@/lib/types'

/** 把主题模式同步到 <html> 的 dark class；system 模式下跟随系统配色变化 */
export function useTheme(themeMode: ThemeMode) {
  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    const applyTheme = () => {
      const dark = themeMode === 'dark' || (themeMode === 'system' && mediaQuery.matches)
      document.documentElement.classList.toggle('dark', dark)
    }

    applyTheme()

    if (themeMode !== 'system') {
      return
    }

    mediaQuery.addEventListener('change', applyTheme)
    return () => mediaQuery.removeEventListener('change', applyTheme)
  }, [themeMode])
}
