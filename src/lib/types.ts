export type LinkKind = 'file' | 'directory'
export type LinkType = 'file-symlink' | 'directory-symlink' | 'junction'
export type LinkStatus = 'healthy' | 'missing-link' | 'missing-target' | 'broken'
export type ThemeMode = 'dark' | 'light' | 'system'
export type LinkManagementMode = 'managed' | 'tracked'

export interface AppSettings {
  conflictStrategy: 'confirm'
  directoryLinkMode: 'junction-first'
  themeMode: ThemeMode
  managedRoots: string[]
  webdavEnabled: boolean
  webdavUrl: string
  webdavUsername: string
  webdavRemoteDir: string
  webdavAutoBackup: boolean
}

export interface UpdateSettingsRequest {
  conflictStrategy: 'confirm'
  directoryLinkMode: 'junction-first'
  themeMode: ThemeMode
  storagePath: string
  managedRoots: string[]
  webdavEnabled: boolean
  webdavUrl: string
  webdavUsername: string
  webdavRemoteDir: string
  webdavAutoBackup: boolean
  webdavPassword?: string
}

export interface ManagedLink {
  id: string
  name: string
  kind: LinkKind
  linkPath: string
  targetPath: string
  linkType: LinkType
  managementMode: LinkManagementMode
  createdAt: number
  status: LinkStatus
  statusText: string
}

export interface AppStateResponse {
  settings: AppSettings
  links: ManagedLink[]
  storagePath: string
  hasWebdavPassword: boolean
  lastAutoBackupFile: string | null
  lastAutoBackupError: string | null
}

export interface CreateLinkRequest {
  name?: string
  linkPath: string
  targetPath: string
  overwriteConflict?: boolean
}

export interface DeleteLinkRequest {
  id: string
}

export interface RenameLinkRequest {
  id: string
  name: string
}

export interface ScanExistingLinksRequest {
  roots: string[]
}

export interface ScannedLink {
  id: string
  name: string
  kind: LinkKind
  linkPath: string
  targetPath: string
  linkType: LinkType
  scanRoot: string
  targetExists: boolean
  alreadyManaged: boolean
}

export interface ImportExistingLinkItem {
  name: string
  kind: LinkKind
  linkPath: string
  targetPath: string
  linkType: LinkType
}

export interface ImportExistingLinksRequest {
  items: ImportExistingLinkItem[]
}

export interface WebdavBackupFile {
  name: string
  modifiedAt: string | null
  size: number | null
}

export interface RestoreWebdavBackupRequest {
  fileName: string
}

export interface DeleteWebdavBackupRequest {
  fileName: string
}

export interface ImportBackupFileRequest {
  filePath: string
}

export interface TestWebdavRequest {
  webdavEnabled: boolean
  webdavUrl: string
  webdavUsername: string
  webdavRemoteDir: string
  webdavPassword?: string
}

export interface WebdavTestResult {
  message: string
}
