import { ShieldQuestion } from 'lucide-react'

import { Button } from '@/components/motion/button'
import { useCopy, type Localized } from '@/lib/i18n'
import { answerPluginPromptCard, usePluginPrompts, type PluginPromptAnswer } from '@/state/plugin-prompt'

interface PromptCopy {
  /** The card's heading, with the plugin's own name after it. */
  asked: (pluginName: string) => string
  /** One sentence per question token the bridge can raise. */
  kinds: Readonly<Record<string, string>>
  /** What the plugin asked for, shown under the sentence. */
  targetLabel: string
  deny: string
  once: string
  session: string
  /** The reach of each answer, in the reader's words. */
  denyHint: string
  onceHint: string
  sessionHint: string
}

const COPY: Localized<PromptCopy> = {
  en: {
    asked: (pluginName) => `${pluginName} is asking`,
    kinds: {
      'fs.read.outOfScope': 'Read a file outside the scope it declared.',
      'fs.write.outOfScope': 'Write a file outside the scope it declared.',
      'fs.delete.outOfScope': 'Delete a file outside the scope it declared.',
      'clipboard.read': 'Read the clipboard for the first time.',
      'clipboard.write': 'Write to the clipboard for the first time.',
      'agent.complete': 'Use a model you pay for, for the first time — each call is billed to your provider account.',
    },
    targetLabel: 'It asked for',
    deny: 'Deny',
    once: 'Allow once',
    session: 'Allow this session',
    denyHint: 'The call is refused and nothing is remembered.',
    onceHint: 'Only the call that is waiting now.',
    sessionHint: 'Until this application quits; the plugin is disabled, updated or uninstalled sooner.',
  },
  zh: {
    asked: (pluginName) => `${pluginName} 正在请求`,
    kinds: {
      'fs.read.outOfScope': '读取它声明的范围之外的文件。',
      'fs.write.outOfScope': '写入它声明的范围之外的文件。',
      'fs.delete.outOfScope': '删除它声明的范围之外的文件。',
      'clipboard.read': '第一次读取剪贴板。',
      'clipboard.write': '第一次写入剪贴板。',
      'agent.complete': '第一次使用由你付费的模型——每次调用都记在你的服务商账号上。',
    },
    targetLabel: '请求对象',
    deny: '拒绝',
    once: '仅本次允许',
    session: '本会话允许',
    denyHint: '这次调用被拒绝，且不记住任何授权。',
    onceHint: '只放行正在等待的这一次。',
    sessionHint: '直到本应用退出；插件被停用、升级或卸载会更早失效。',
  },
}

/**
 * The card one plugin question is answered on.
 *
 * It is drawn by the shell, not by a plugin page, because the page's call is parked until it is
 * answered and the reader may be looking at the conversation. The card takes one question at a time
 * — the oldest — so a page that asks several in a row gets an answer each, in order, instead of a
 * stack of overlapping dialogs. Its words are this application's: the plugin supplied a token and
 * the object it asked about, never a sentence.
 */
export function PluginPromptCard() {
  const copy = useCopy(COPY)
  const prompts = usePluginPrompts()
  const prompt = prompts[0]
  if (prompt === undefined) return null

  return (
    <div
      role="alertdialog"
      aria-labelledby="omp-plugin-prompt-title"
      aria-describedby="omp-plugin-prompt-body"
      className="fixed top-6 left-1/2 z-50 w-[min(26rem,calc(100%-2rem))] -translate-x-1/2 rounded-xl border border-border bg-card/95 p-4 shadow-2xl backdrop-blur"
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
          <ShieldQuestion aria-hidden="true" className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p id="omp-plugin-prompt-title" className="text-[13px] leading-5 font-medium text-foreground">
            {copy.asked(prompt.pluginName)}
          </p>
          <p id="omp-plugin-prompt-body" className="mt-1 text-xs leading-[18px] text-muted-foreground">
            {copy.kinds[prompt.kind] ?? prompt.kind}
          </p>
          {prompt.target.length === 0 ? null : (
            <p className="mt-1.5 flex min-w-0 items-baseline gap-1.5 text-xs leading-[18px] text-muted-foreground">
              <span className="shrink-0">{copy.targetLabel}</span>
              <code className="min-w-0 truncate font-mono text-[11px] text-foreground">{prompt.target}</code>
            </p>
          )}
        </div>
      </div>
      <PromptActions
        deny={copy.deny}
        once={copy.once}
        session={copy.session}
        denyHint={copy.denyHint}
        onceHint={copy.onceHint}
        sessionHint={copy.sessionHint}
        onAnswer={(answer) => void answerPluginPromptCard(prompt.id, answer)}
      />
    </div>
  )
}

/** The three answers, each with the reach it stands for on its tooltip. */
function PromptActions({
  deny,
  once,
  session,
  denyHint,
  onceHint,
  sessionHint,
  onAnswer,
}: {
  deny: string
  once: string
  session: string
  denyHint: string
  onceHint: string
  sessionHint: string
  onAnswer: (answer: PluginPromptAnswer) => void
}) {
  return (
    <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        title={denyHint}
        onClick={() => onAnswer('deny')}
        className="rounded-lg font-normal"
      >
        {deny}
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        title={onceHint}
        onClick={() => onAnswer('once')}
        className="rounded-lg font-normal"
      >
        {once}
      </Button>
      <Button
        type="button"
        variant="primary"
        size="sm"
        title={sessionHint}
        onClick={() => onAnswer('session')}
        className="rounded-lg font-normal"
      >
        {session}
      </Button>
    </div>
  )
}
