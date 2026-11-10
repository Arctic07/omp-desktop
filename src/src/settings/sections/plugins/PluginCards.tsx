import { useState } from 'react'

import { Button } from '@/components/motion/button'
import { SettingsNotice } from '@/settings/parts'
import type { PluginsCopy } from '@/settings/sections/plugins/copy'
import type { PluginEntry } from '@/settings/sections/plugins/contract'

/**
 * The two cards the page opens before a write it will not run on its own: the source switch (which
 * uninstalls before installing), and the uninstall, which removes files and data for good.
 *
 * Each draws the installation the page asked about, so a card is only on screen while the page
 * holds a pending request for its kind; each answers the page with a confirm or a cancel rather
 * than writing anything itself. That is what keeps the chains — the grant first and the switch
 * after it, the two presses of a source switch — in one place. Every line is a fact the host
 * reported about the plugin's own directory.
 */

/**
 * The card the page opens before a source switch.
 *
 * The engine cannot upgrade across marketplaces, and one runtime name cannot be installed twice, so
 * the host uninstalls first and installs from the new marketplace after that. That is the only
 * update this page runs destructively, so it is the only one with two presses: the first states what
 * will happen, the second is the actual decision. A failed install is rolled back by the host; the
 * page reports which of the two outcomes happened, because it is the host's answer that says so.
 */
export function PluginSwitchCard({
  entry,
  copy,
  busy,
  onConfirm,
  onCancel,
}: {
  entry: PluginEntry
  copy: PluginsCopy
  busy: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const [step, setStep] = useState<'explain' | 'confirm'>('explain')
  const update = entry.update
  if (update === null) return null
  const target = update.marketplace ?? ''
  // A linked or npm installation has no marketplace to name; the sentence would read "roll back to ."
  // without this fallback (2026-10-27).
  const current = entry.row.source.marketplace ?? copy.switchSourcePreviousSource

  return (
    <SettingsNotice variant="warning" title={copy.switchSourceTitle(entry.name)}>
      <div className="flex flex-col gap-3">
        <p>
          {step === 'explain'
            ? copy.switchSourceBody(target, update.to, current)
            : copy.switchSourceConfirmBody(target, update.to, current)}
        </p>
        <p>{copy.switchSourceGrantNote}</p>
        {step === 'explain' ? null : (
          <p className="text-xs leading-[18px] text-muted-foreground">
            {copy.switchSourceConfirmHint}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button size="sm" variant="secondary" disabled={busy} onClick={onCancel}>
            {copy.cancelAction}
          </Button>
          {step === 'explain' ? (
            <Button size="sm" disabled={busy} onClick={() => setStep('confirm')}>
              {copy.switchSourceContinue}
            </Button>
          ) : (
            <Button size="sm" disabled={busy} onClick={onConfirm}>
              {copy.switchSourceConfirmAction}
            </Button>
          )}
        </div>
      </div>
    </SettingsNotice>
  )
}

/**
 * The card the page opens before an uninstall.
 *
 * The uninstall is the write that cannot be undone — it takes the plugin's files and its stored
 * settings with it — so the card says exactly that and lists the two things that go, read from the
 * row's own reported facts rather than from a guess.
 */
export function PluginUninstallCard({
  entry,
  copy,
  busy,
  onConfirm,
  onCancel,
}: {
  entry: PluginEntry
  copy: PluginsCopy
  busy: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <SettingsNotice variant="destructive" title={copy.uninstallConfirmTitle(entry.name)}>
      <div className="flex flex-col gap-3">
        <p>{copy.uninstallConfirmBody}</p>

        <div className="flex flex-col gap-1.5">
          <h4 className="text-[13px] leading-5 font-semibold text-foreground">
            {copy.uninstallConfirmDataTitle}
          </h4>
          <ul className="flex list-disc flex-col gap-1 pl-5">
            <li>{copy.uninstallConfirmSettings(entry.row.settings.keys.length)}</li>
            <li>{copy.uninstallConfirmCache}</li>
          </ul>
        </div>

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button size="sm" variant="secondary" disabled={busy} onClick={onCancel}>
            {copy.cancelAction}
          </Button>
          <Button size="sm" disabled={busy} onClick={onConfirm}>
            {copy.uninstallConfirmAction}
          </Button>
        </div>
      </div>
    </SettingsNotice>
  )
}
