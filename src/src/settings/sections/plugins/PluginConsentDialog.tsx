import { Button } from '@/components/motion/button'
import {
  Alert,
  AlertContent,
  AlertDescription,
  AlertIcon,
  AlertTitle,
} from '@/components/motion/alert'
import {
  CenterMorphModal,
  CenterMorphModalContent,
} from '@/components/motion/center-morph-modal'
import type { ApiError } from '@/api/client'
import { useCopy } from '@/lib/i18n'
import { COPY } from '@/settings/sections/plugins/copy'
import type { PluginEntry } from '@/settings/sections/plugins/contract'
import { PluginPermissionList } from '@/settings/sections/plugins/PluginPermissionList'
import {
  pluginCapabilityLabels,
  pluginConsentLabel,
} from '@/settings/sections/plugins/rows'
import { useBlockingOverlayWhile } from '@/state/overlay-depth'

/**
 * The confirmation a plugin's first enable asks for, as a centered dialog.
 *
 * The page and the market card both open this one surface, so the facts a reader agrees to are
 * worded once: what the package brings, the capabilities the engine will load, and the permissions
 * the manifest declares. Smaller reading text and one 16px surface keep it a decision, not a page.
 */
export function PluginConsentDialog({
  entry,
  busy,
  failure = null,
  onConfirm,
  onCancel,
}: {
  /** The installation waiting for confirmation; `null` keeps the dialog unmounted. */
  entry: PluginEntry | null
  /** The page's grant/enable write in flight, so both buttons lock with it. */
  busy: boolean
  /** The last refusal for this confirmation, shown inside the surface that hid the page notice. */
  failure?: ApiError | null
  onConfirm: () => void
  onCancel: () => void
}) {
  const copy = useCopy(COPY)
  useBlockingOverlayWhile(entry !== null)
  if (entry === null) return null

  const row = entry.row
  const reasons = pluginConsentLabel(row.consent.reasons, copy)
  const capabilities = pluginCapabilityLabels(row.code, copy)

  return (
    <CenterMorphModal
      open
      onOpenChange={(open) => {
        if (!open) onCancel()
      }}
    >
      <CenterMorphModalContent
        ariaLabel={copy.consentTitle(entry.name)}
        closeButtonLabel={copy.closeAction}
        dismissible={!busy}
        showCloseButton={!busy}
        className="max-w-[34rem]"
      >
        <div className="flex max-h-[80vh] flex-col gap-4 overflow-y-auto p-6 pr-14 text-xs leading-[18px] text-muted-foreground">
          <div className="flex flex-col gap-1">
            <h2 className="text-base leading-6 font-semibold text-foreground">
              {copy.consentTitle(entry.name)}
            </h2>
            <p>{copy.consentBody}</p>
            {row.code.extensions > 0 ? <p>{copy.consentExtensionNote}</p> : null}
          </div>

          <section className="flex flex-col gap-1.5">
            <h3 className="text-xs leading-[18px] font-semibold text-foreground">
              {copy.consentReasonsTitle}
            </h3>
            <ul className="flex list-disc flex-col gap-1 pl-5">
              {reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          </section>

          <section className="flex flex-col gap-1.5">
            <h3 className="text-xs leading-[18px] font-semibold text-foreground">
              {copy.capabilitiesTitle}
            </h3>
            {capabilities.length === 0 ? (
              <p>{copy.capabilitiesNone}</p>
            ) : (
              <ul className="flex list-disc flex-col gap-1 pl-5">
                {capabilities.map((capability) => (
                  <li key={capability}>{capability}</li>
                ))}
              </ul>
            )}
          </section>

          <section className="flex flex-col gap-1.5">
            <h3 className="text-xs leading-[18px] font-semibold text-foreground">
              {copy.permissionsTitle}
            </h3>
            <PluginPermissionList
              permissions={row.desktop?.permissions ?? []}
              netDomains={row.desktop?.netDomains ?? []}
              netAnyHost={row.desktop?.netAnyHost ?? false}
              copy={copy}
              compact
            />
          </section>

          {failure === null ? null : (
            <Alert variant="destructive">
              <AlertIcon />
              <AlertContent>
                <AlertTitle>{copy.consentFailed}</AlertTitle>
                <AlertDescription>{failure.message}</AlertDescription>
              </AlertContent>
            </Alert>
          )}

          <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
            <Button size="sm" variant="secondary" disabled={busy} onClick={onCancel}>
              {copy.cancelAction}
            </Button>
            <Button size="sm" disabled={busy} onClick={onConfirm}>
              {copy.consentConfirm}
            </Button>
          </div>
        </div>
      </CenterMorphModalContent>
    </CenterMorphModal>
  )
}
