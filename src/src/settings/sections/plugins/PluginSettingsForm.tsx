import { useCallback, useMemo, useState } from 'react'

import type { ApiError } from '@/api/client'
import type { EnginePluginSettings, PluginSettingSchema, PluginRow } from '@/api/plugins-types'
import { Button } from '@/components/motion/button'
import { Input } from '@/components/motion/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/motion/select'
import { Switch } from '@/components/motion/switch'
import { SettingsBadge } from '@/settings/parts'
import type { PluginsCopy } from '@/settings/sections/plugins/copy'
import type { PluginSettingValue } from '@/settings/sections/plugins/contract'
import { pluginSettingLabel } from '@/settings/sections/plugins/rows'

/**
 * The settings one plugin declares, rendered from the schema the engine shipped with it.
 *
 * Nothing here is optimistic: the value a field shows is the last one the engine answered with, and
 * a write that is refused leaves the editor as it was so the text can be corrected. The schema's own
 * keys decide the control (`boolean` / `enum` / `string` / `number`), and its `secret` / `env` /
 * `min` / `max` / `step` decide the masking and the hint lines.
 *
 * A secret is the one value this form never puts in the document: the engine does not echo it back,
 * so the box starts empty whatever is stored, and an empty box means "leave it alone" rather than
 * "the value is empty". The row's own placeholder says whether a value is stored.
 *
 * A plugin the engine has disabled is shown, not edited: the values the engine holds are still
 * rendered, every control is disabled, and the form says why instead of letting a write land on a
 * plugin that is not running.
 */
export function PluginSettingsForm({
  row,
  config,
  loading,
  copy,
  settingLabels,
  onSet,
  onReset,
}: {
  row: PluginRow
  config: EnginePluginSettings | null
  loading: boolean
  copy: PluginsCopy
  settingLabels: Record<string, unknown> | null
  onSet: (key: string, value: PluginSettingValue) => Promise<ApiError | null>
  onReset: (key: string | null) => Promise<ApiError | null>
}) {
  /** Half-typed text, keyed by `<plugin id>\0<setting key>`; a committed draft stops being dirty. */
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({})
  /** The secret fields the reader asked to unmask, keyed the same way. */
  const [revealed, setRevealed] = useState<Readonly<Record<string, boolean>>>({})
  const [invalidKey, setInvalidKey] = useState('')
  const [busyKey, setBusyKey] = useState('')
  const [failure, setFailure] = useState<ApiError | null>(null)
  /** Which write the key in flight is — a draft being saved, or an explicit value being cleared. */
  const [pendingAction, setPendingAction] = useState<'set' | 'reset'>('set')

  const readOnly = !row.enabled
  const locked = busyKey !== '' || readOnly

  const fields = useMemo(() => {
    if (config === null) return []
    return Object.entries(config.schema).map(([key, raw]) => {
      const schema = asSchema(raw)
      if (schema === null) return null
      const explicit = config.explicit.includes(key)
      const value = config.values[key] ?? schema.default
      const valueText = value === undefined ? '' : String(value)
      const isSecret = schema.secret === true
      const key0 = `${config.id}\u0000${key}`
      const draft = drafts[key0] ?? (isSecret ? '' : valueText)
      const dirty = isSecret
        ? (drafts[key0] ?? '') !== ''
        : schema.type === 'number'
          ? draft.trim() !== '' && Number(draft) !== Number(valueText)
          : draft !== valueText
      return {
        key,
        label: pluginSettingLabel(key, schema, settingLabels),
        type: schema.type,
        secret: isSecret,
        env: schema.env ?? '',
        values: schema.values ?? [],
        min: schema.min ?? null,
        max: schema.max ?? null,
        step: schema.step ?? null,
        explicit,
        value,
        draft,
        dirty,
        busy: busyKey === key,
        unmasked: isSecret && revealed[key0] === true,
      }
    })
  }, [busyKey, config, drafts, revealed, settingLabels])

  /**
   * One write, with the lock, the busy label and the refusal all in one place.
   *
   * A write that landed drops its own draft: the engine's answer is the value now, so the box falls
   * back to it instead of showing the typed text and staying dirty — and a secret, which the engine
   * never echoes back, is cleared here for the same reason. A refused write keeps the draft, which is
   * what lets the reader correct it.
   */
  const run = useCallback(
    async (key: string, action: 'set' | 'reset', write: () => Promise<ApiError | null>) => {
      if (busyKey !== '') return
      setPendingAction(action)
      setBusyKey(key)
      setFailure(null)
      setInvalidKey('')
      const error = await write()
      if (error !== null) {
        setFailure(error)
      } else if (config !== null) {
        const key0 = `${config.id}\u0000${key}`
        setDrafts((current) => {
          if (current[key0] === undefined) return current
          const next = { ...current }
          delete next[key0]
          return next
        })
      }
      setBusyKey('')
    },
    [busyKey, config],
  )

  /** Commits one text or number field; a number that is not one is refused before any write. */
  const saveField = useCallback(
    (key: string, draft: string, type: string, secret: boolean) => {
      if (readOnly) return
      // An untouched secret box means "do not change it": writing the empty string would erase the
      // stored secret, which is the opposite of what leaving it alone asks for.
      if (secret && draft.trim() === '') return
      if (type === 'number') {
        const text = draft.trim()
        const parsed = Number(text)
        if (text === '' || Number.isNaN(parsed)) {
          setInvalidKey(key)
          return
        }
        void run(key, 'set', () => onSet(key, parsed))
        return
      }
      void run(key, 'set', () => onSet(key, draft))
    },
    [onSet, readOnly, run],
  )

  /** The draft's own `dirty` is the guard both ways in: a write of the same value is only noise. */
  const commitField = useCallback(
    (key: string, draft: string, type: string, secret: boolean, dirty: boolean) => {
      if (dirty) saveField(key, draft, type, secret)
    },
    [saveField],
  )

  const toggleReveal = useCallback((key0: string) => {
    setRevealed((current) => ({ ...current, [key0]: current[key0] !== true }))
  }, [])

  if (loading && config === null) {
    return (
      <p className="text-[13px] leading-[19px] text-muted-foreground" role="status">
        {copy.loading}
      </p>
    )
  }

  if (config === null) {
    return null
  }

  const rows = fields.filter((field) => field !== null)

  return (
    <div className="flex flex-col gap-3">
      {failure === null ? null : (
        <p
          role="alert"
          className="flex flex-wrap items-center gap-1.5 text-xs leading-[18px] text-destructive"
        >
          {copy.writeFailed}
          <SettingsBadge>{failure.code}</SettingsBadge>
          <span className="min-w-0 text-muted-foreground">{failure.message}</span>
        </p>
      )}

      {readOnly && rows.length > 0 ? (
        <p className="text-[13px] leading-[19px] text-muted-foreground" role="note">
          {copy.settingsReadOnlyHint}
        </p>
      ) : null}

      {rows.length === 0 ? (
        <p className="text-[13px] leading-[19px] text-muted-foreground">{copy.settingsNone}</p>
      ) : (
        <div className="flex flex-col gap-4">
          {rows.map((field) => {
            const key0 = `${config.id}\u0000${field.key}`
            return (
              <div key={field.key} className="flex flex-col gap-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm leading-5 font-medium text-foreground">{field.label}</span>
                  <code className="rounded-md bg-muted px-1.5 py-px font-mono text-[11px] leading-4 text-muted-foreground">
                    {field.key}
                  </code>
                  {field.explicit ? null : (
                    <SettingsBadge>{copy.settingDefaultBadge}</SettingsBadge>
                  )}
                  {field.busy ? (
                    <span className="text-xs leading-[18px] text-muted-foreground" role="status">
                      {pendingAction === 'reset' ? copy.settingResetting : copy.settingSaving}
                    </span>
                  ) : null}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  {field.type === 'boolean' ? (
                    <Switch
                      checked={field.value === true}
                      disabled={locked}
                      onCheckedChange={(next) =>
                        void run(field.key, 'set', () => onSet(field.key, next))
                      }
                      ariaLabel={
                        field.value === true
                          ? copy.settingToggleOff(field.label)
                          : copy.settingToggleOn(field.label)
                      }
                    />
                  ) : field.type === 'enum' ? (
                    <div className="w-56">
                      <Select
                        value={String(field.value ?? '')}
                        disabled={locked}
                        onValueChange={(next) =>
                          void run(field.key, 'set', () => onSet(field.key, next))
                        }
                      >
                        <SelectTrigger aria-label={field.label}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {field.values.map((option) => (
                            <SelectItem key={option} value={option}>
                              {option}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  ) : (
                    <div className="w-72">
                      <Input
                        type={field.secret && !field.unmasked ? 'password' : 'text'}
                        inputMode={field.type === 'number' ? 'decimal' : undefined}
                        value={field.draft}
                        onChange={(next) =>
                          setDrafts((current) => ({ ...current, [key0]: next }))
                        }
                        onKeyDown={(event) => {
                          if (event.key !== 'Enter') return
                          event.preventDefault()
                          commitField(field.key, field.draft, field.type, field.secret, field.dirty)
                        }}
                        onBlur={() =>
                          commitField(field.key, field.draft, field.type, field.secret, field.dirty)
                        }
                        disabled={locked}
                        placeholder={
                          field.secret
                            ? field.explicit
                              ? copy.settingSecretStored
                              : copy.settingSecretUnset
                            : undefined
                        }
                        aria-label={field.label}
                        min={field.min ?? undefined}
                        max={field.max ?? undefined}
                        step={field.step ?? undefined}
                        autoComplete="off"
                        spellCheck={false}
                        classNames={{ field: 'h-9 rounded-lg', input: 'text-sm' }}
                      />
                    </div>
                  )}

                  {field.secret ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={locked}
                      aria-pressed={field.unmasked}
                      onClick={() => toggleReveal(key0)}
                    >
                      {field.unmasked ? copy.settingHideSecret : copy.settingShowSecret}
                    </Button>
                  ) : null}

                  {field.type === 'string' || field.type === 'number' ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={locked || !field.dirty}
                      onClick={() => saveField(field.key, field.draft, field.type, field.secret)}
                    >
                      {copy.settingSave}
                    </Button>
                  ) : null}

                  {field.explicit ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={locked}
                      onClick={() => void run(field.key, 'reset', () => onReset(field.key))}
                    >
                      {copy.settingReset}
                    </Button>
                  ) : null}
                </div>

                {invalidKey === field.key ? (
                  <p role="alert" className="text-xs leading-[18px] text-destructive">
                    {copy.settingNumberInvalid}
                  </p>
                ) : null}
                {field.secret ? (
                  <p className="text-[13px] leading-[19px] text-muted-foreground">
                    {copy.settingSecretHint}
                  </p>
                ) : null}
                {field.env === '' ? null : (
                  <p className="text-[13px] leading-[19px] text-muted-foreground">
                    {copy.settingEnvHint(field.env)}
                  </p>
                )}
              </div>
            )
          })}
        </div>
      )}

      <p className="text-[13px] leading-[19px] text-muted-foreground">{copy.settingsHint}</p>
    </div>
  )
}

/**
 * One schema entry, read as the author declared it.
 *
 * The schema crosses the wire as loose JSON — it is the plugin author's own vocabulary — so a key
 * whose `type` is not even a string is not a setting this form can render a control for, and is left
 * out rather than drawn as an empty field.
 */
function asSchema(value: unknown): PluginSettingSchema | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (typeof record.type !== 'string') return null
  return {
    type: record.type,
    description: typeof record.description === 'string' ? record.description : undefined,
    secret: record.secret === true,
    env: typeof record.env === 'string' ? record.env : undefined,
    default: record.default,
    min: typeof record.min === 'number' ? record.min : undefined,
    max: typeof record.max === 'number' ? record.max : undefined,
    step: typeof record.step === 'number' ? record.step : undefined,
    values: Array.isArray(record.values)
      ? record.values.filter((option): option is string => typeof option === 'string')
      : undefined,
  }
}
