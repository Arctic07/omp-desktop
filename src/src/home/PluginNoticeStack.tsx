import { X } from 'lucide-react'

import { dismissPluginNotice, usePluginNotices } from '@/state/plugin-notice'

/**
 * The corner a plugin's notices appear in.
 *
 * Rendered by the shell rather than by the plugins page, because a plugin raises a notice when it has
 * something to say and not when the reader happens to be looking at its settings. The stack takes no
 * focus and blocks no click outside itself — it is a corner, not a dialog — and its lines dismiss
 * themselves; the button is for a reader who is done reading sooner than that.
 *
 * The notice's own words are the plugin's (`pluginName`, `title`, `body`): this app has no copy for
 * them and must not invent any.
 */
export function PluginNoticeStack() {
  const notices = usePluginNotices()
  if (notices.length === 0) return null

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-[min(22rem,calc(100%-2rem))] flex-col gap-2"
    >
      {notices.map((notice) => (
        <div
          key={notice.key}
          className="pointer-events-auto flex min-w-0 items-start gap-2 rounded-xl border border-border bg-card/95 px-3.5 py-3 shadow-lg backdrop-blur"
        >
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-[13px] leading-5 font-medium text-foreground">
              {notice.title}
            </span>
            {notice.body.length === 0 ? null : (
              <span className="text-xs leading-[18px] text-muted-foreground">{notice.body}</span>
            )}
            <span className="truncate text-[11px] leading-4 text-muted-foreground/80">
              {notice.pluginName}
            </span>
          </span>
          <button
            type="button"
            aria-label={notice.pluginName}
            onClick={() => dismissPluginNotice(notice.key)}
            className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X aria-hidden="true" className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  )
}
