import { Check, ExternalLink } from 'lucide-react'

import { HelpText, SettingsSection } from '@/components/settings/section'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { ThemeMode } from '@/lib/types'

const themeOptions = [
  ['dark', '夜间', 'bg-slate-950 text-white border-slate-950 hover:bg-black'],
  ['light', '日间', 'border-slate-300 bg-slate-100 text-slate-800 hover:bg-slate-200'],
  ['system', '系统', 'border-emerald-500 bg-emerald-500 text-white hover:bg-emerald-600'],
] as const

interface GeneralSectionProps {
  themeMode: ThemeMode
  storagePath: string
  locked: boolean
  showHelp: boolean
  onThemeChange: (themeMode: ThemeMode) => void
  onStoragePathChange: (storagePath: string) => void
  onOpenPath: (path: string, select?: boolean) => void
}

export function GeneralSection({
  themeMode,
  storagePath,
  locked,
  showHelp,
  onThemeChange,
  onStoragePathChange,
  onOpenPath,
}: GeneralSectionProps) {
  return (
    <>
      <SettingsSection className="gap-2">
        <Label htmlFor="themeMode">界面主题</Label>
        <div className="grid grid-cols-3 gap-2" id="themeMode">
          {themeOptions.map(([value, label, baseClassName]) => {
            const active = themeMode === value
            return (
              <button
                key={value}
                className={[
                  'relative inline-flex h-10 items-center justify-center rounded-lg border px-2.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                  baseClassName,
                  active ? 'border-[#C3B091] ring-1 ring-[#C3B091]' : 'opacity-85',
                ].join(' ')}
                disabled={locked}
                onClick={() => onThemeChange(value)}
                type="button"
              >
                {active ? <Check className="absolute left-2 h-3.5 w-3.5" /> : null}
                <span>{label}</span>
              </button>
            )
          })}
        </div>
        {showHelp ? <HelpText>夜间使用深色界面，日间使用浅色界面，系统会跟随当前系统配色。</HelpText> : null}
      </SettingsSection>

      <SettingsSection className="gap-2">
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor="storagePath">数据文件路径</Label>
          <Button
            disabled={locked || !storagePath.trim()}
            onClick={() => onOpenPath(storagePath.trim(), true)}
            size="sm"
            type="button"
            variant="outline"
          >
            <ExternalLink className="h-4 w-4" />
            打开目录
          </Button>
        </div>
        <Input
          id="storagePath"
          disabled={locked}
          onChange={(event) => onStoragePathChange(event.target.value)}
          placeholder="例如：C:\\Users\\用户名\\.go-symlink\\state.json"
          value={storagePath}
        />
        {showHelp ? (
          <HelpText>保存时会把当前状态复制到新路径并切换使用，原文件会保留；如果目标文件已存在则不会覆盖。</HelpText>
        ) : null}
      </SettingsSection>
    </>
  )
}
