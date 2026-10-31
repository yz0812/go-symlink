import type { LinkKind, LinkManagementMode, LinkStatus, LinkType } from '@/lib/types'

export const kindLabels = {
  file: '文件',
  directory: '目录',
} satisfies Record<LinkKind, string>

export const kindStyles = {
  file: 'bg-sky-50 text-sky-700 ring-sky-200 dark:bg-sky-500/15 dark:text-sky-300 dark:ring-sky-500/20',
  directory: 'bg-violet-50 text-violet-700 ring-violet-200 dark:bg-violet-500/15 dark:text-violet-300 dark:ring-violet-500/20',
} satisfies Record<LinkKind, string>

export const statusLabels = {
  healthy: '正常',
  'missing-link': '链接缺失',
  'missing-target': '目标缺失',
  broken: '异常',
} satisfies Record<LinkStatus, string>

export const statusStyles = {
  healthy: 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-300 dark:ring-emerald-500/20',
  'missing-link': 'bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-500/15 dark:text-amber-300 dark:ring-amber-500/20',
  'missing-target': 'bg-orange-50 text-orange-700 ring-orange-200 dark:bg-orange-500/15 dark:text-orange-300 dark:ring-orange-500/20',
  broken: 'bg-red-50 text-red-700 ring-red-200 dark:bg-red-500/15 dark:text-red-300 dark:ring-red-500/20',
} satisfies Record<LinkStatus, string>

export const linkTypeLabels = {
  'file-symlink': '文件符号链接',
  'directory-symlink': '目录符号链接',
  junction: '目录联接',
} satisfies Record<LinkType, string>

export const linkTypeShortLabels = {
  'file-symlink': '文件链',
  'directory-symlink': '目录链',
  junction: 'J',
} satisfies Record<LinkType, string>

export const managementModeLabels = {
  managed: '应用管理',
  tracked: '仅记录',
} satisfies Record<LinkManagementMode, string>
