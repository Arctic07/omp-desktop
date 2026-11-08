import { useCallback, useEffect, useState } from 'react'
import { Minus, Plus } from 'lucide-react'
import { useTheme } from 'next-themes'

import { toApiError, type ApiError } from '@/api/client'
import { startupThemeSet, type StartupTheme } from '@/api/preferences'
import { Button } from '@/components/motion/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/motion/select'
import { Switch } from '@/components/motion/switch'
import { useCopy, useLanguage, type Language, type Localized } from '@/lib/i18n'
import {
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  pushTrayLanguage,
  useAppSetting,
} from '@/state/app-settings'
import {
  compactionResource,
  presenceResource,
  readCompaction,
  readPresence,
  writeCompaction,
  writeCompactionOptions,
  writePresence,
} from '@/state/preferences-store'
import { useResourceState } from '@/state/resource'
import {
  SettingsCard,
  SettingsChoice,
  SettingsGroup,
  SettingsNotice,
  SettingsRow,
} from '@/settings/parts'

/**
 * The desktop app's own copy, verbatim (`src/i18nCopyEn.ts`, `settingsPage.general`), named as the
 * Vue section names it so the two pages can be read side by side.
 */
interface GeneralCopy {
  title: string
  description: string
  languageTitle: string
  languageDescription: string
  languageOptions: readonly { value: Language; label: string }[]
  themeTitle: string
  themeDescription: string
  themeOptions: readonly { value: StartupTheme; label: string }[]
  themeSaveFailed: string
  fontSizeTitle: string
  fontSizeDescription: string
  decreaseFontSize: string
  increaseFontSize: string
  conversationTitle: string
  conversationDescription: string
  conversationOptions: readonly { value: 'comfortable' | 'compact'; label: string }[]
  busyTitle: string
  busyDescription: string
  busyOptions: readonly { value: 'queue' | 'interrupt'; label: string }[]
  compactionTitle: string
  compactionDescription: string
  compactionOnLabel: string
  /** The two switches under the idle half of the same card. */
  compactionIdleTitle: string
  compactionIdleDescription: string
  recapTitle: string
  recapDescription: string
  compactionSaveFailed: string
  presenceTitle: string
  presenceDescription: string
  presenceCloseTitle: string
  presenceCloseDescription: string
  presenceSaveFailed: string
  retry: string
}

const COPY: Localized<GeneralCopy> = {
  en: {
    title: 'General',
    description: 'Set the interface language, type size, and how conversations behave.',
    languageTitle: 'Language',
    languageDescription: 'Choose the language used across the interface.',
    languageOptions: [
      { value: 'en', label: 'English' },
      { value: 'zh', label: '简体中文' },
    ],
    themeTitle: 'Theme',
    themeDescription: 'Use a light, dark, or system-aware appearance.',
    themeSaveFailed: 'The theme was not recorded, so it would not have survived a restart.',
    themeOptions: [
      { value: 'light', label: 'Light' },
      { value: 'dark', label: 'Dark' },
      { value: 'system', label: 'System' },
    ],
    fontSizeTitle: 'Font size',
    fontSizeDescription: 'Adjust the reading size for messages and controls.',
    decreaseFontSize: 'Decrease font size',
    increaseFontSize: 'Increase font size',
    conversationTitle: 'Conversation display',
    conversationDescription: 'Choose the amount of space between messages.',
    conversationOptions: [
      { value: 'comfortable', label: 'Comfortable' },
      { value: 'compact', label: 'Compact' },
    ],
    busyTitle: 'While the assistant is busy',
    busyDescription: 'Choose what happens when you send another message.',
    busyOptions: [
      { value: 'queue', label: 'Queue message' },
      { value: 'interrupt', label: 'Ask before sending' },
    ],
    compactionTitle: 'Context compaction',
    compactionDescription:
      'When the context nears the window, the engine compacts on its own: it summarizes the earlier span, keeps the recent conversation and continues from there. Turned off, nothing is compacted as the context fills — run /compact when you want it. The idle switch below is separate: the engine makes the same decision there on its own.',
    compactionOnLabel: 'Automatic',
    compactionIdleTitle: 'While idle',
    compactionIdleDescription:
      'Compact the context once the conversation has been quiet for a while and the context has grown large, so the next message starts on a smaller, cheaper prompt. It works on its own, not through the switch above — the engine decides, and neither suppresses the other. Off by default: it spends a summarization call while you are away.',
    recapTitle: 'Recap when idle',
    recapDescription:
      'After a few minutes with nothing happening, the engine summarizes where the conversation stands and shows it here. One extra call per idle stretch; off means the conversation stays exactly as you left it.',
    compactionSaveFailed: 'The context compaction setting was not saved.',
    presenceTitle: 'Background residency',
    presenceDescription:
      'The app keeps running in the system tray after the window is closed, so running sessions and terminals are not interrupted.',
    presenceCloseTitle: 'Hide to tray when closing the window',
    presenceCloseDescription:
      'With this on, closing the window only hides it and the tray menu’s Quit ends the app; with it off, closing the window quits.',
    presenceSaveFailed: 'The residency setting was not saved.',
    retry: 'Retry',
  },
  zh: {
    title: '常规',
    description: '设置界面语言、字号与对话的工作方式。',
    languageTitle: '语言',
    languageDescription: '选择界面使用的语言。',
    languageOptions: [
      { value: 'en', label: 'English' },
      { value: 'zh', label: '简体中文' },
    ],
    themeTitle: '外观主题',
    themeDescription: '使用浅色、深色或跟随系统。',
    themeSaveFailed: '主题没有记录成功，重启后不会保留。',
    themeOptions: [
      { value: 'light', label: '浅色' },
      { value: 'dark', label: '深色' },
      { value: 'system', label: '跟随系统' },
    ],
    fontSizeTitle: '字号',
    fontSizeDescription: '调整消息和控件的阅读字号。',
    decreaseFontSize: '减小字号',
    increaseFontSize: '增大字号',
    conversationTitle: '对话显示',
    conversationDescription: '选择消息之间的留白大小。',
    conversationOptions: [
      { value: 'comfortable', label: '舒适' },
      { value: 'compact', label: '紧凑' },
    ],
    busyTitle: '智能体忙碌时',
    busyDescription: '发送下一条消息时选择对应行为。',
    busyOptions: [
      { value: 'queue', label: '排队发送' },
      { value: 'interrupt', label: '发送前询问' },
    ],
    compactionTitle: '上下文压缩',
    compactionDescription:
      '上下文接近窗口上限时，引擎自行压缩：总结较早的内容、保留最近的对话，然后接着做。关闭后，上下文填满时不会自动压缩，需要时用 /compact 手动执行；空闲压缩由下面的开关单独控制。',
    compactionOnLabel: '自动',
    compactionIdleTitle: '空闲时压缩',
    compactionIdleDescription:
      '对话静置一段时间且上下文已经很大时，先在后台压缩一次，下一条消息从更小、更便宜的提示词开始。它由引擎自行决定，不受上面的「自动」开关影响；默认关闭：会在你离开时消耗一次总结调用。',
    recapTitle: '空闲时回顾',
    recapDescription:
      '静置几分钟后，引擎总结一次对话进行到哪里，并显示在这里。每段空闲一次额外调用；关闭后对话保持你离开时的样子。',
    compactionSaveFailed: '上下文压缩设置没有保存成功。',
    presenceTitle: '后台驻留',
    presenceDescription: '关闭窗口后应用继续在系统托盘里运行，运行中的会话与终端不会中断。',
    presenceCloseTitle: '关闭窗口时隐藏到托盘',
    presenceCloseDescription:
      '开启后点关闭只隐藏窗口，要退出请用托盘菜单的「退出」；关闭后点关闭键直接退出应用。',
    presenceSaveFailed: '驻留设置没有保存成功。',
    retry: '重试',
  },
}

/** One write's outcome, as the row that asked for it reports it. */
interface Failure {
  text: string
  error: ApiError
}

/**
 * General: the desktop app's own preferences, plus the two the engine and the shell own.
 *
 * The first three are this document's (`state/app-settings`) and take effect as they are chosen; the
 * theme is `next-themes`' own, which is why it is written through that and only *reported* to the
 * shell (`startup_theme_set`). The last two are the host's, so they are read, written and — when a
 * write is refused — reported rather than assumed.
 */
export default function GeneralSection() {
  const copy = useCopy(COPY)
  const { language, setLanguage } = useLanguage()
  const { theme, setTheme } = useTheme()
  const activeTheme: StartupTheme =
    theme === 'light' || theme === 'dark' || theme === 'system' ? theme : 'system'

  const [fontSize, setFontSize] = useAppSetting('fontSize')
  const [conversationDensity, setConversationDensity] = useAppSetting('conversationDensity')
  const [busyBehavior, setBusyBehavior] = useAppSetting('busyBehavior')

  const compaction = useResourceState(compactionResource)
  const presence = useResourceState(presenceResource)

  const [themeFailure, setThemeFailure] = useState<Failure | null>(null)
  const [compactionFailure, setCompactionFailure] = useState<Failure | null>(null)
  const [presenceFailure, setPresenceFailure] = useState<Failure | null>(null)
  const [busy, setBusy] = useState<'compaction' | 'presence' | null>(null)

  useEffect(() => {
    void readCompaction()
    void readPresence()
  }, [])

  const chooseLanguage = useCallback(
    (next: Language) => {
      setLanguage(next)
      // The tray's own menu is drawn by the shell, so it is told the language separately.
      pushTrayLanguage(next)
    },
    [setLanguage],
  )

  const chooseTheme = useCallback(
    (next: StartupTheme) => {
      const previous = activeTheme
      setThemeFailure(null)
      setTheme(next)
      // The record is the copy the next start reads first (`state/startup-theme`), so a theme it did
      // not take would be undone by the next start. That is why a refusal puts the old palette back
      // and says so, instead of looking applied until the next launch.
      void startupThemeSet(next).catch((error: unknown) => {
        setTheme(previous)
        setThemeFailure({ text: copy.themeSaveFailed, error: toApiError(error) })
      })
    },
    [activeTheme, copy.themeSaveFailed, setTheme],
  )

  const toggleCompaction = useCallback(async (next: boolean) => {
    setBusy('compaction')
    setCompactionFailure(null)
    const error = await writeCompaction(next)
    if (error !== null) setCompactionFailure({ text: copy.compactionSaveFailed, error })
    setBusy(null)
  }, [copy.compactionSaveFailed])

  /**
   * One of the two idle switches. Only the flipped field travels, so the other value the engine
   * holds is never written back over a change that landed elsewhere.
   */
  const toggleCompactionOption = useCallback(
    async (option: 'idleEnabled' | 'recapEnabled', next: boolean) => {
      setBusy('compaction')
      setCompactionFailure(null)
      const error = await writeCompactionOptions({ [option]: next })
      if (error !== null) setCompactionFailure({ text: copy.compactionSaveFailed, error })
      setBusy(null)
    },
    [copy.compactionSaveFailed],
  )

  const togglePresence = useCallback(async (next: boolean) => {
    setBusy('presence')
    setPresenceFailure(null)
    const error = await writePresence(next)
    if (error !== null) setPresenceFailure({ text: copy.presenceSaveFailed, error })
    setBusy(null)
  }, [copy.presenceSaveFailed])

  return (
    <>
      <SettingsGroup title={copy.title} description={copy.description}>
        <SettingsCard>
          <SettingsRow
            title={copy.languageTitle}
            description={copy.languageDescription}
            control={
              <Select
                value={language}
                onValueChange={(value) => chooseLanguage(value as Language)}
                className="w-44"
              >
                <SelectTrigger className="h-9 rounded-lg text-[13px]">
                  <span className="sr-only">{copy.languageTitle}</span>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {copy.languageOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value} className="text-[13px]">
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            }
          />

          <SettingsRow
            title={copy.themeTitle}
            description={copy.themeDescription}
            stack
            control={
              <SettingsChoice
                label={copy.themeTitle}
                options={copy.themeOptions}
                value={activeTheme}
                onChange={chooseTheme}
              />
            }
          />
          {themeFailure === null ? null : (
            <div className="px-5 pt-3">
              <SettingsNotice variant="destructive" title={themeFailure.text}>
                {themeFailure.error.message}
              </SettingsNotice>
            </div>
          )}

          <SettingsRow
            title={copy.fontSizeTitle}
            description={copy.fontSizeDescription}
            control={
              <div className="flex items-center gap-0.5 rounded-lg border border-border p-0.5">
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={copy.decreaseFontSize}
                  disabled={fontSize <= FONT_SIZE_MIN}
                  onClick={() => setFontSize(Math.max(FONT_SIZE_MIN, fontSize - 1))}
                  className="size-7 rounded-md"
                >
                  <Minus className="size-3.5" aria-hidden="true" />
                </Button>
                <output
                  aria-label={copy.fontSizeTitle}
                  className="min-w-9 text-center text-[13px] leading-5 tabular-nums text-foreground"
                >
                  {fontSize}px
                </output>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={copy.increaseFontSize}
                  disabled={fontSize >= FONT_SIZE_MAX}
                  onClick={() => setFontSize(Math.min(FONT_SIZE_MAX, fontSize + 1))}
                  className="size-7 rounded-md"
                >
                  <Plus className="size-3.5" aria-hidden="true" />
                </Button>
              </div>
            }
          />

          <SettingsRow
            title={copy.conversationTitle}
            description={copy.conversationDescription}
            stack
            control={
              <SettingsChoice
                label={copy.conversationTitle}
                options={copy.conversationOptions}
                value={conversationDensity}
                onChange={setConversationDensity}
              />
            }
          />

          <SettingsRow
            title={copy.busyTitle}
            description={copy.busyDescription}
            stack
            control={
              <SettingsChoice
                label={copy.busyTitle}
                options={copy.busyOptions}
                value={busyBehavior}
                onChange={setBusyBehavior}
              />
            }
          />
        </SettingsCard>
      </SettingsGroup>

      <SettingsGroup title={copy.compactionTitle} description={copy.compactionDescription}>
        <SettingsCard>
          {/* The engine's boolean, offered as the switch it is: the label is the 'on' answer. */}
          <SettingsRow
            title={copy.compactionOnLabel}
            control={
              <Switch
                checked={compaction.value?.enabled ?? false}
                disabled={compaction.value === null || busy === 'compaction'}
                onCheckedChange={(next) => void toggleCompaction(next)}
                ariaLabel={copy.compactionTitle}
              />
            }
          />
          {/* The idle half of the same subject, each its own engine switch: the compaction that
              runs while nobody is looking, and the summary of where the conversation stands. Both
              are reported from the engine rather than kept here, and both apply to conversations
              that are already open. */}
          <SettingsRow
            title={copy.compactionIdleTitle}
            description={copy.compactionIdleDescription}
            control={
              <Switch
                checked={compaction.value?.idleEnabled ?? false}
                disabled={compaction.value === null || busy === 'compaction'}
                onCheckedChange={(next) => void toggleCompactionOption('idleEnabled', next)}
                ariaLabel={copy.compactionIdleTitle}
              />
            }
          />
          <SettingsRow
            title={copy.recapTitle}
            description={copy.recapDescription}
            control={
              <Switch
                checked={compaction.value?.recapEnabled ?? false}
                disabled={compaction.value === null || busy === 'compaction'}
                onCheckedChange={(next) => void toggleCompactionOption('recapEnabled', next)}
                ariaLabel={copy.recapTitle}
              />
            }
          />
          {compactionFailure === null ? null : (
            <div className="px-5 pt-3">
              <SettingsNotice variant="destructive" title={compactionFailure.text}>
                {compactionFailure.error.message}
              </SettingsNotice>
            </div>
          )}
        </SettingsCard>
      </SettingsGroup>

      <SettingsGroup title={copy.presenceTitle} description={copy.presenceDescription}>
        <SettingsCard>
          <SettingsRow
            title={copy.presenceCloseTitle}
            description={copy.presenceCloseDescription}
            control={
              <Switch
                checked={presence.value?.closeToTray ?? false}
                disabled={presence.value === null || busy === 'presence'}
                onCheckedChange={(next) => void togglePresence(next)}
                ariaLabel={copy.presenceCloseTitle}
              />
            }
          />
          {presenceFailure === null ? null : (
            <div className="px-5 pt-3">
              <SettingsNotice variant="destructive" title={presenceFailure.text}>
                {presenceFailure.error.message}
              </SettingsNotice>
            </div>
          )}
        </SettingsCard>
      </SettingsGroup>
    </>
  )
}
