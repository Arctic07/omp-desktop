import { useEffect, useRef, useState, type ComponentType } from 'react'
import { X } from 'lucide-react'

import { useCopy, type Localized } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import AboutSection from '@/settings/sections/AboutSection'
import AppearanceSection from '@/settings/sections/AppearanceSection'
import GeneralSection from '@/settings/sections/GeneralSection'
import ExtensionsSection from '@/settings/sections/ExtensionsSection'
import LogsSection from '@/settings/sections/LogsSection'
import McpSection from '@/settings/sections/McpSection'
import MemorySection from '@/settings/sections/MemorySection'
import ModelsSection from '@/settings/sections/ModelsSection'
import PluginsSection from '@/settings/sections/PluginsSection'
import RulesSection from '@/settings/sections/RulesSection'
import SkillsSection from '@/settings/sections/SkillsSection'
import type { WorkspaceScopeTarget } from '@/settings/use-workspace-scope'
import UsageSection from '@/settings/sections/UsageSection'

/** One page of the settings overlay, as its section column lists them. */
export type SettingsSectionId =
  | 'usage'
  | 'general'
  | 'models'
  | 'skills'
  | 'extensions'
  | 'rules'
  | 'mcp'
  | 'plugins'
  | 'memory'
  | 'appearance'
  | 'logs'
  | 'about'

interface SettingsCopy {
  title: string
  close: string
  /** The section column's own name, for the list that switches the sections. */
  sectionsLabel: string
  /** One entry per section: the column's label and the sentence over the reading column. */
  sections: Readonly<Record<SettingsSectionId, { label: string; description: string }>>
}

/** The desktop app's own wording (`src/i18nCopyEn.ts` / `i18nCopyZh.ts`: `settingsNavigation`
 *  and `settingsPage.sectionDescriptions`), in both languages. */
const COPY: Localized<SettingsCopy> = {
  en: {
    title: 'Settings',
    close: 'Close settings',
    sectionsLabel: 'Settings sections',
    sections: {
      usage: {
        label: 'Usage',
        description: 'Tally this machine’s tokens, cache, and cost by model, by day, and by session.',
      },
      general: {
        label: 'General',
        description: 'Set the language, type size, and how conversations behave.',
      },
      models: {
        label: 'Models',
        description: 'Connect local and remote providers for your conversations.',
      },
      skills: {
        label: 'Skills',
        description:
          'Manage project- and user-level skills. Once enabled, use them in chat with `/skill:<name>`.',
      },
      extensions: {
        label: 'Extensions',
        description:
          'Every item the engine discovered for this scope — skills, rules, tools, hooks, commands and modules — each with the provider it came from and its own enable switch.',
      },
      rules: {
        label: 'Rules',
        description:
          'The engine’s user-level rules, applied to every workspace and session; per-project rules live in a workspace’s AGENTS.md.',
      },
      mcp: {
        label: 'MCP',
        description:
          'See where each MCP server comes from, whether it is connected, how many tools it offers, and enable or disable it.',
      },
      plugins: {
        label: 'Plugins',
        description:
          'Install and manage engine plugins: what each one brings, what it may do, and the settings it declares. Enabling a plugin records the permission grant it runs under; there is no confirmation dialog.',
      },
      memory: {
        label: 'Memory',
        description:
          'Save and reuse long-term context in workspaces. Applies to new sessions and may increase model requests and token costs.',
      },
      appearance: {
        label: 'Appearance',
        description: 'Tune the visual language of the desktop client.',
      },
      logs: {
        label: 'Logs',
        description:
          'Where this app and its engine keep their logs, and the one place that clears them.',
      },
      about: {
        label: 'About',
        description: 'Build information, resources, and local runtime status.',
      },
    },
  },
  zh: {
    title: '设置',
    close: '关闭设置',
    sectionsLabel: '设置分区',
    sections: {
      usage: {
        label: '使用统计',
        description: '统计本机会话的 token、缓存与费用，并按模型、日期、会话分组查看。',
      },
      general: { label: '常规', description: '设置权限、语言以及对话的工作方式。' },
      models: { label: '模型', description: '连接本地或远程模型供应商。' },
      skills: {
        label: '技能',
        description: '管理项目级与用户级技能。启用后可在聊天里通过 `/skill:<name>` 使用。',
      },
      extensions: {
        label: '扩展项',
        description:
          '引擎在这个范围内发现的全部条目——技能、规则、工具、钩子、命令与模块——每条都标明来源，并可单独启停。',
      },
      rules: {
        label: '规则',
        description:
          '引擎的用户级规则，对所有工作区与会话生效；项目级规则写在工作区的 AGENTS.md。',
      },
      mcp: {
        label: 'MCP',
        description: '查看 MCP 服务器的定义来源、连接状态与工具数量，并按需启停它们。',
      },
      plugins: {
        label: '插件',
        description:
          '安装与管理引擎插件：每个插件带来了什么、能做什么、声明了哪些设置。启用时会记录它运行所依据的授权，不再弹出确认对话框。',
      },
      memory: {
        label: '记忆',
        description:
          '在工作区中保存并复用长期上下文，新会话生效。开启后可能增加模型调用和 Token 成本。',
      },
      appearance: { label: '外观', description: '微调桌面客户端的视觉风格。' },
      logs: { label: '日志', description: '查看应用与引擎的日志位置，清除日志与缓存。' },
      about: { label: '关于', description: '版本信息、资源链接和本地运行状态。' },
    },
  },
}

interface SettingsSectionEntry {
  id: SettingsSectionId
  Section: ComponentType<SettingsSectionProps>
}

/** What every section is handed. A section that needs none simply declares none. */
export interface SettingsSectionProps {
  /** Leave settings for the conversation column, after a section has started work there. */
  onOpenWorkspace: () => void
  /** Leave settings for the plugin marketplace, carrying the plugin page's current scope. */
  onBrowseMarket?: (scope: WorkspaceScopeTarget) => void
  /** Whether the section is on screen; a visited section stays mounted while hidden. */
  active?: boolean
}

/** The desktop app's own order: usage first, about last. */
const SECTIONS: readonly SettingsSectionEntry[] = [
  { id: 'usage', Section: UsageSection },
  { id: 'general', Section: GeneralSection },
  { id: 'models', Section: ModelsSection },
  { id: 'skills', Section: SkillsSection },
  { id: 'extensions', Section: ExtensionsSection },
  { id: 'rules', Section: RulesSection },
  { id: 'mcp', Section: McpSection },
  { id: 'plugins', Section: PluginsSection },
  { id: 'memory', Section: MemorySection },
  { id: 'appearance', Section: AppearanceSection },
  { id: 'logs', Section: LogsSection },
  { id: 'about', Section: AboutSection },
]

/**
 * The settings page: a fixed 276px section column beside the reading column, the
 * same split the desktop app uses.
 *
 * It is an overlay on the window's own frame rather than a screen of its own: the frame above it —
 * the drag region and the three window controls — stays exactly where it was, and the conversation
 * underneath stays mounted, so leaving settings returns to the reading position it was left at. It
 * covers the whole body of the frame, the sidebar included, which is why the frame's sidebar toggle
 * is not drawn while it is open.
 *
 * A section is mounted the first time it is visited and stays mounted while the page is open, hidden
 * rather than unmounted when the reader moves on. That is what keeps a half-written rules file, a
 * search term and a list's scroll position where the reader left them — and it is also why a
 * section's own read happens on its first visit rather than on every switch back to it.
 */
export function SettingsPage({
  onClose,
  onOpenWorkspace,
  onBrowseMarket,
  initialSection,
}: {
  onClose: () => void
  /**
   * Leave the settings page for the conversation column.
   *
   * The skills page's two "ask the agent to do this" actions open a session with a prompt; the
   * session is created here and the reader has to be taken to it, which is a decision about the
   * shell's own view and therefore the shell's to make.
   */
  onOpenWorkspace: () => void
  /** Leave settings for the plugin marketplace, carrying the plugin page's current scope. */
  onBrowseMarket: (scope: WorkspaceScopeTarget) => void
  /**
   * The section to open on.
   *
   * The window's 帮助 → 关于 asks for `about`; the settings entry in the rail asks for nothing and
   * gets the first section, which is where a reader who opened Settings for its own sake starts.
   */
  initialSection?: SettingsSectionId
}) {
  const copy = useCopy(COPY)
  const [activeId, setActiveId] = useState<SettingsSectionId>(initialSection ?? SECTIONS[0].id)
  const [visited, setVisited] = useState<readonly SettingsSectionId[]>([
    initialSection ?? SECTIONS[0].id,
  ])
  const active = SECTIONS.find((section) => section.id === activeId) ?? SECTIONS[0]
  const activeCopy = copy.sections[active.id]

  const select = (id: SettingsSectionId) => {
    setActiveId(id)
    setVisited((current) => (current.includes(id) ? current : [...current, id]))
  }

  /**
   * A section asked for from outside the page, while it is already open.
   *
   * 帮助 → 关于 has to land on About whether or not settings was up. The page stays mounted while it
   * covers the window (a half-written rules file is not thrown away by a menu press), so a *new*
   * `initialSection` is a request to switch rather than a fresh start; the last one applied is kept
   * so the reader wandering off to another section and pressing 关于 again is moved back.
   */
  const appliedSection = useRef(initialSection)
  useEffect(() => {
    if (initialSection === undefined || initialSection === appliedSection.current) return
    appliedSection.current = initialSection
    select(initialSection)
  }, [initialSection])

  return (
    <div className="absolute inset-0 z-30 grid grid-cols-[276px_minmax(0,1fr)] overflow-hidden bg-background">
      <div className="flex min-w-0 flex-col gap-6 border-r border-border px-5 py-7">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-lg leading-6 font-semibold text-foreground">{copy.title}</h1>
          <button
            type="button"
            onClick={onClose}
            aria-label={copy.close}
            className="grid size-8 flex-none place-items-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>

        <nav aria-label={copy.sectionsLabel} className="flex min-w-0 flex-col gap-1">
          {SECTIONS.map((section) => {
            const activeItem = section.id === activeId
            return (
              <button
                key={section.id}
                type="button"
                aria-current={activeItem ? 'page' : undefined}
                onClick={() => select(section.id)}
                className={cn(
                  'min-h-[38px] w-full rounded-[9px] px-3 py-2 text-left text-sm leading-5 transition-colors outline-none',
                  'focus-visible:ring-2 focus-visible:ring-ring',
                  activeItem
                    ? 'bg-muted font-semibold text-foreground'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                {copy.sections[section.id].label}
              </button>
            )
          })}
        </nav>
      </div>

      <div className="min-w-0 overflow-y-auto">
        <div className="mx-auto w-[min(760px,calc(100%-64px))] pt-16 pb-24">
          <p className="mb-2 text-[13px] leading-[18px] text-muted-foreground">{copy.title}</p>
          <h2 className="text-[30px] leading-[38px] font-medium text-foreground">
            {activeCopy.label}
          </h2>
          <p className="mt-2.5 mb-8 max-w-[600px] text-sm leading-[22px] text-muted-foreground">
            {activeCopy.description}
          </p>
          <div className="flex flex-col gap-7">
            {SECTIONS.filter((section) => visited.includes(section.id)).map((section) => {
              const Section = section.Section
              const shown = section.id === activeId
              return (
                <div key={section.id} hidden={!shown} className="flex flex-col gap-7">
                  <Section
                    onOpenWorkspace={onOpenWorkspace}
                    onBrowseMarket={onBrowseMarket}
                    active={shown}
                  />
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
