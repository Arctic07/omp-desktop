import { useCallback, useEffect, useState, type KeyboardEvent } from 'react'

import { hasCode, type ApiError } from '@/api/client'
import { Button } from '@/components/motion/button'
import { useCopy, useLanguage, type Localized } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { SettingsBadge, SettingsCard, SettingsTextarea } from '@/settings/parts'
import { formatMemoryUpdatedAt, type MemoryUpdatedCopy } from '@/settings/sections/memory-updated'
import { formatBytes } from '@/settings/sections/rules-format'
import { useResourceState } from '@/state/resource'
import { readRules, rulesResource, writeRules } from '@/state/rules-store'

/**
 * The engine's user-level `RULES.md`, whole: one toolbar over one editor, the two edges inset the
 * same way.
 *
 * The file is the engine's, and the host owns reading and writing it: the editor holds a draft, a
 * save writes the whole file through the host, and the answer is the state on disk afterwards. An
 * empty save is legitimate — the engine reads an empty file as no rules.
 *
 * A draft the reader has already edited is theirs: a read that lands later does not overwrite it
 * (only `还原` takes it back to the last read), and a refused write keeps it so nothing typed is lost.
 * What the file is, and where per-project rules live instead, is said once by the page shell's own
 * description.
 */

/** `rulesCopy.ts`'s wording, the part this page shows, in both languages. */
interface RulesCopy {
  fileName: string
  created: string
  missing: string
  loading: string
  editorLabel: string
  save: string
  saving: string
  revert: string
  retry: string
  loadFailed: string
  /** The page's own wording of the size refusal. */
  tooLarge: string
  /** The shared `updated at` ladder, whose nine fields the memory viewer's rows use verbatim. */
  updated: MemoryUpdatedCopy
}

const COPY: Localized<RulesCopy> = {
  en: {
    fileName: 'RULES.md',
    created: 'Created',
    missing: 'Not created',
    loading: 'Loading rules…',
    editorLabel: 'Contents of the rules file',
    save: 'Save',
    saving: 'Saving…',
    revert: 'Revert',
    retry: 'Retry',
    loadFailed: 'Could not read or write the rules file.',
    tooLarge: 'The file is over the size limit. Trim it in an external editor, then retry.',
    updated: {
      justNow: 'Just now',
      minutesAgo: (count) => `${count} min ago`,
      today: (time) => `Today ${time}`,
      yesterday: (time) => `Yesterday ${time}`,
      weekday: (weekday, time) => `${weekday} ${time}`,
      weekdayZh: (weekday) => `周${weekday}`,
      date: (date, time) => `${date} ${time}`,
      monthDay: (month, day) => `${month}/${day}`,
      yearMonthDay: (year, month, day) => `${year}/${month}/${day}`,
    },
  },
  zh: {
    fileName: 'RULES.md',
    created: '已创建',
    missing: '未创建',
    loading: '正在加载规则…',
    editorLabel: '规则文件内容',
    save: '保存',
    saving: '保存中…',
    revert: '还原',
    retry: '重试',
    loadFailed: '无法读取或写入规则文件。',
    tooLarge: '文件超过大小上限，请在外部编辑器中精简后重试。',
    updated: {
      justNow: '刚刚',
      minutesAgo: (count) => `${count} 分钟前`,
      today: (time) => `今天 ${time}`,
      yesterday: (time) => `昨天 ${time}`,
      weekday: (weekday, time) => `${weekday} ${time}`,
      weekdayZh: (weekday) => `周${weekday}`,
      date: (date, time) => `${date} ${time}`,
      monthDay: (month, day) => `${month} 月 ${day} 日`,
      yearMonthDay: (year, month, day) => `${year} 年 ${month} 月 ${day} 日`,
    },
  },
}

/** The host's code for a rules file past the size it reads and writes. */
const RULES_TOO_LARGE = 'rules_too_large'

export default function RulesSection() {
  const copy = useCopy(COPY)
  const { language } = useLanguage()
  const { status, error, value: view } = useResourceState(rulesResource)

  /**
   * The reader's own text, or null while the file has not been touched.
   *
   * Null is what keeps a read from overwriting a half-written draft: the editor follows the host's
   * answer for as long as it is untouched, and holds the reader's own words from the first keystroke
   * on. `还原` is the one way back to the read.
   */
  const [draft, setDraft] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  /** A write the host refused: kept apart from the read's own failure so neither hides the other. */
  const [writeFailure, setWriteFailure] = useState<ApiError | null>(null)
  /** The clock the figures line is worded against, ticked while the page is open. */
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    void readRules()
  }, [])

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  const content = view?.content ?? ''
  const text = draft ?? content
  const dirty = draft !== null && draft !== content
  const loading = status === 'idle' || status === 'loading'
  const failure = writeFailure ?? error

  const retry = useCallback(() => {
    setWriteFailure(null)
    void readRules(true)
  }, [])

  const revert = useCallback(() => {
    setWriteFailure(null)
    setDraft(null)
  }, [])

  const save = useCallback(async () => {
    if (draft === null || saving) return
    setSaving(true)
    setWriteFailure(null)
    const refused = await writeRules(draft)
    if (refused === null) {
      // The write's own answer is the new file, so the draft stops being one: the editor follows it.
      setDraft(null)
    } else {
      setWriteFailure(refused)
    }
    setSaving(false)
  }, [draft, saving])

  /**
   * `Ctrl+S` / `⌘S`, as the reference page binds it.
   *
   * The draft is read from the closure's own render, which is the one that drew the text in the
   * editor, so a save always writes what the reader can see.
   */
  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key !== 's' || !(event.metaKey || event.ctrlKey)) return
      event.preventDefault()
      void save()
    },
    [save],
  )

  /**
   * The file's figures, worded against a clock the page keeps ticking.
   *
   * `now` is state rather than a `Date.now()` read during render: the line dates a file, and reading
   * the clock while rendering would make the same render produce different text. The interval is
   * what keeps "3 分钟前" from freezing at the value it had when the page opened. A file the host
   * could not stamp reads as a dash, which is the shared ladder's own answer for a time that was
   * never made.
   */
  function figures(): string {
    if (view === null || !view.exists) return ''
    return `${formatBytes(view.bytes)} · ${formatMemoryUpdatedAt(copy.updated, language, now, view.updatedAtMs)}`
  }

  return (
    <>
      <SettingsCard>
        <div className="flex flex-wrap items-center gap-2.5 border-b border-border/60 px-5 py-[15px]">
          <span className="font-mono text-[13px] leading-5 text-foreground" title={view?.path}>
            {copy.fileName}
          </span>
          {view === null ? null : (
            <SettingsBadge>{view.exists ? copy.created : copy.missing}</SettingsBadge>
          )}
          <span className="text-[13px] leading-5 text-muted-foreground">
            {loading ? copy.loading : figures()}
          </span>
          {saving ? (
            <span className="text-[13px] leading-5 text-muted-foreground" role="status">
              {copy.saving}
            </span>
          ) : null}
          <div className="ml-auto flex items-center gap-2">
            <Button variant="outline" size="sm" disabled={!dirty || saving} onClick={revert}>
              {copy.revert}
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={!dirty || saving}
              onClick={() => void save()}
            >
              {copy.save}
            </Button>
          </div>
        </div>

        {view === null ? null : (
          <div className="p-5">
            <SettingsTextarea
              aria-label={copy.editorLabel}
              value={text}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onKeyDown}
              disabled={saving}
              rows={16}
            />
          </div>
        )}

        {failure === null ? null : (
          <div
            role="alert"
            className={cn(
              'flex flex-wrap items-center gap-2.5 px-5 py-3',
              // The toolbar's own rule separates the line from what is above it when there is no
              // editor in between.
              view !== null && 'border-t border-border/60',
            )}
          >
            <span className="text-[13px] leading-[19px] text-destructive">
              {hasCode(failure, RULES_TOO_LARGE) ? copy.tooLarge : copy.loadFailed}
            </span>
            {hasCode(failure, RULES_TOO_LARGE) ? null : (
              <span className="text-[13px] leading-[19px] text-muted-foreground">
                {failure.message}
              </span>
            )}
            {view === null ? (
              <Button size="sm" variant="outline" disabled={loading} onClick={retry}>
                {copy.retry}
              </Button>
            ) : null}
          </div>
        )}
      </SettingsCard>
    </>
  )
}
