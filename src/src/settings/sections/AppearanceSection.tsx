import { useEffect } from 'react'
import { Check, SlidersHorizontal } from 'lucide-react'
import { useTheme } from 'next-themes'

import { Button } from '@/components/motion/button'
import { Switch } from '@/components/motion/switch'
import { useCopy, useLanguage, type Localized } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { useAppSetting } from '@/state/app-settings'
import { pluginThemes, pluginThemeStore, reconcilePluginTheme, selectPluginTheme, themeStylesheetState } from '@/state/plugin-theme'
import type { ContrastIssue } from '@/state/theme-contrast'
import type { ThemeStylesheetState } from '@/state/plugin-theme'
import { pluginsResource, readPlugins } from '@/state/plugins-store'
import { useResourceState } from '@/state/resource'
import { useStore, useStoreSelector } from '@/state/store'
import { workspaceStore } from '@/state/workspace-store'
import { SettingsBadge, SettingsCard, SettingsEmpty, SettingsGroup, SettingsRow } from '@/settings/parts'

/** `settingsPage.appearance`'s wording, the part this page shows, in both languages. */
interface AppearanceCopy {
  motionTitle: string
  motionDescription: string
  enabledLabel: string
  disabledLabel: string
  pluginThemeTitle: string
  pluginThemeDescription: string
  pluginThemeDefault: string
  pluginThemeEmpty: string
  pluginThemeDarkBadge: string
  pluginThemeLightBadge: string
  pluginThemeStylesheetBadge: string
  /** The badge on a theme whose declared stylesheet was refused, so it paints tokens only. */
  pluginThemeStylesheetUnavailableBadge: string
  pluginThemeInactive: string
  /** The badge on a theme whose own tokens leave text under the contrast threshold. */
  pluginThemeContrastBadge: string
  /** The badge's tooltip: the pairs and their measured ratios. */
  pluginThemeContrastHint: (pairs: string) => string
}

const COPY: Localized<AppearanceCopy> = {
  en: {
    motionTitle: 'Reduce motion',
    motionDescription: 'Use shorter transitions and fewer animated effects.',
    enabledLabel: 'On',
    disabledLabel: 'Off',
    pluginThemeTitle: 'Plugin themes',
    pluginThemeDescription:
      'Colours contributed by installed plugins. Token values, plus a sanitised stylesheet for themes that ship one: no plugin code runs.',
    pluginThemeDefault: 'Default',
    pluginThemeEmpty:
      'No plugin contributes a theme yet. A plugin declares one with tokens (and optionally a stylesheet) under `omp.desktop.themes`.',
    pluginThemeDarkBadge: 'Dark',
    pluginThemeLightBadge: 'Light',
    pluginThemeStylesheetBadge: 'Stylesheet',
    pluginThemeStylesheetUnavailableBadge: 'Stylesheet unavailable',
    pluginThemeInactive: 'Does not match the current light or dark mode, so it is not applied.',
    pluginThemeContrastBadge: 'Low contrast',
    pluginThemeContrastHint: (pairs) =>
      `Text on these surfaces is under 4.5:1 in this theme: ${pairs}. The theme still applies.`,
  },
  zh: {
    motionTitle: '减少动效',
    motionDescription: '缩短过渡并减少动画效果。',
    enabledLabel: '开启',
    disabledLabel: '关闭',
    pluginThemeTitle: '插件主题',
    pluginThemeDescription:
      '已安装插件贡献的配色。覆盖设计令牌，带样式表的主题还会注入清洗后的样式表；不加载插件代码。',
    pluginThemeDefault: '默认',
    pluginThemeEmpty: '还没有插件贡献主题。插件在 omp.desktop.themes 里声明令牌（可选样式表）即可。',
    pluginThemeDarkBadge: '深色',
    pluginThemeLightBadge: '浅色',
    pluginThemeStylesheetBadge: '样式表',
    pluginThemeStylesheetUnavailableBadge: '样式表不可用',
    pluginThemeInactive: '与当前明暗模式不匹配，暂不生效。',
    pluginThemeContrastBadge: '对比度低',
    pluginThemeContrastHint: (pairs) => `这个主题里这些区域的文字对比度低于 4.5:1：${pairs}。主题仍会应用。`,
  },
}

/** One theme row: the swatch previews the theme, and the whole line is the target. */
function ThemeRow({
  label,
  source,
  dark,
  stylesheet,
  contrast,
  active,
  onSelect,
}: {
  label: string
  /** The contributing plugin. The client's own Default entry has none. */
  source?: string
  dark: boolean | null
  /**
   * The pairs this theme leaves under the contrast threshold, from its own tokens
   * (`state/theme-contrast.ts`). A report, not a refusal: the theme still applies.
   */
  contrast: readonly ContrastIssue[]
  /**
   * What the row states about the theme's stylesheet: nothing, one applied, or a declared one the
   * boundary refused (which paints tokens only).
   */
  stylesheet: ThemeStylesheetState
  active: boolean
  onSelect: () => void
}) {
  const copy = useCopy(COPY)

  return (
    <Button
      variant="ghost"
      size="md"
      aria-pressed={active}
      onClick={onSelect}
      className={cn(
        'h-auto min-h-12 w-full justify-start gap-2.5 rounded-none border-b border-border/60 px-5 py-2.5 text-left last:border-b-0',
        active && 'bg-muted',
      )}
    >
      {source === undefined ? null : (
        <span
          aria-hidden="true"
          className="flex size-7 shrink-0 overflow-hidden rounded-lg border border-border"
        >
          {/* The two tokens a theme is read by: its surface and its ink. */}
          <span className="flex-1 bg-muted" />
          <span className="flex-1 bg-foreground" />
        </span>
      )}
      <span className="flex-none text-sm leading-5 text-foreground">{label}</span>
      {source === undefined ? (
        <span className="flex-1" />
      ) : (
        <span className="min-w-0 flex-1 truncate text-xs leading-[18px] text-muted-foreground">
          {source}
        </span>
      )}
      {stylesheet.kind === 'none' ? null : stylesheet.kind === 'stylesheet' ? (
        <SettingsBadge>{copy.pluginThemeStylesheetBadge}</SettingsBadge>
      ) : (
        <SettingsBadge tone="warning" ariaLabel={stylesheet.reason}>
          {copy.pluginThemeStylesheetUnavailableBadge}
        </SettingsBadge>
      )}
      {dark === null ? null : (
        <SettingsBadge>{dark ? copy.pluginThemeDarkBadge : copy.pluginThemeLightBadge}</SettingsBadge>
      )}
      {contrast.length === 0 ? null : (
        <span title={copy.pluginThemeContrastHint(contrast.map((issue) => `${issue.pair} ${issue.ratio}:1`).join(', '))}>
          <SettingsBadge tone="warning">{copy.pluginThemeContrastBadge}</SettingsBadge>
        </span>
      )}
      {active ? <Check className="size-4 shrink-0 text-foreground" aria-hidden="true" /> : null}
    </Button>
  )
}

/**
 * Appearance: the same two groups as the Vue page.
 *
 * The motion switch is this document's own preference and takes effect at once — the stylesheet
 * reads it off `<body>`. The theme list is what the *installed plugins* contribute, read from the
 * engine's own plugin list rather than from any copy here: a plugin's `omp.desktop.themes` block
 * becomes a row, and choosing one writes its tokens on the document. The client's own Default entry
 * stays first and is what clearing the choice returns to.
 */
export default function AppearanceSection() {
  const copy = useCopy(COPY)
  const { language } = useLanguage()
  const { resolvedTheme } = useTheme()
  const [reduceMotion, setReduceMotion] = useAppSetting('reduceMotion')

  const workspaceId = useStoreSelector(workspaceStore, (state) => state.activeId)
  const plugins = useResourceState(pluginsResource)
  const selected = useStore(pluginThemeStore).selected

  useEffect(() => {
    void readPlugins(workspaceId)
  }, [workspaceId])

  const themes = pluginThemes(plugins.value?.plugins ?? [], language)
  const darkMode = resolvedTheme === 'dark'

  // A theme whose plugin is no longer installed is not a theme any more; dropping the choice is what
  // keeps the document from wearing tokens nothing declares.
  useEffect(() => {
    if (plugins.status !== 'ready') return
    reconcilePluginTheme(themes)
  }, [plugins.status, themes])

  const chosen = themes.find((theme) => theme.key === selected?.key) ?? null
  const inactive = chosen !== null && chosen.dark !== null && chosen.dark !== darkMode

  return (
    <>
      <SettingsGroup title={copy.motionTitle} description={copy.motionDescription}>
        <SettingsCard>
          <SettingsRow
            icon={<SlidersHorizontal className="size-4" aria-hidden="true" />}
            title={copy.motionTitle}
            description={copy.motionDescription}
            control={
              <Switch
                checked={reduceMotion}
                onCheckedChange={setReduceMotion}
                ariaLabel={`${copy.motionTitle}: ${reduceMotion ? copy.enabledLabel : copy.disabledLabel}`}
              />
            }
          />
        </SettingsCard>
      </SettingsGroup>

      <SettingsGroup title={copy.pluginThemeTitle} description={copy.pluginThemeDescription}>
        <SettingsCard className="overflow-hidden">
          <ThemeRow
            label={copy.pluginThemeDefault}
            dark={null}
            stylesheet={{ kind: 'none' }}
            contrast={[]}
            active={selected === null}
            onSelect={() => selectPluginTheme(null)}
          />
          {themes.map((theme) => (
            <ThemeRow
              key={theme.key}
              label={theme.label}
              source={theme.pluginName}
              dark={theme.dark}
              stylesheet={themeStylesheetState(theme)}
              contrast={theme.contrast}
              active={selected?.key === theme.key}
              onSelect={() => selectPluginTheme(theme)}
            />
          ))}
          {themes.length === 0 ? (
            <div className="p-3.5">
              <SettingsEmpty>{copy.pluginThemeEmpty}</SettingsEmpty>
            </div>
          ) : null}
          {inactive ? (
            <p className="px-5 py-3 text-[13px] leading-[19px] text-muted-foreground">
              {copy.pluginThemeInactive}
            </p>
          ) : null}
        </SettingsCard>
      </SettingsGroup>
    </>
  )
}
