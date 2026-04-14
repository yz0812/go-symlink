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
}

export interface UpdateSettingsRequest {
  conflictStrategy: 'confirm'
  directoryLinkMode: 'junction-first'
  themeMode: ThemeMode
  storagePath: string
  managedRoots: string[]
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
}

export interface CreateLinkRequest {
  name?: string
  linkPath: string
  targetPath: string
  overwriteConflict?: boolean
}

export interface DeleteLinkRequest {
  id: string
  overwriteConflict?: boolean
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
