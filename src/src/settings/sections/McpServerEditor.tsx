import { useState } from 'react'
import { ChevronDown, ChevronLeft, Trash2 } from 'lucide-react'

import type {
  EngineMcpDefinitionInput,
  EngineMcpScope,
  EngineMcpServerRow,
} from '@/api/capabilities-types'
import type { ApiError } from '@/api/client'
import { Button } from '@/components/motion/button'
import { Input } from '@/components/motion/input'
import { RadioGroup, RadioGroupItem } from '@/components/motion/radio'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/motion/select'
import { useCopy } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import {
  SettingsBadge,
  SettingsCard,
  SettingsField,
  SettingsGroup,
  SettingsTextarea,
} from '@/settings/parts'
import { MCP_COPY, transportOf, type McpTransport } from '@/settings/sections/mcp-copy'
import { definitionFromJson, objectField } from '@/settings/sections/mcp-json'

/**
 * The definition editor: one card, two ways of writing the same thing.
 *
 * The card is the page's last block and the page owns its open/closed state, so this component only
 * holds what is being typed. It offers the two editors the reference offers — a form for the shape
 * this application writes, and a JSON view for pasting a definition from somewhere else — and the
 * name and scope stay part of both, because a definition is addressed by the pair.
 *
 * Three rules the page's write path depends on:
 *
 * - **A refusal keeps the input.** The host's answer arrives as `failure` and this component is not
 *   remounted for it, so nothing typed is lost; only a write that landed closes the card.
 * - **The keys the form owns are the ones the host replaces** (`type`, `command`, `args`, `env`,
 *   `url`, `headers`, `cwd`, `timeout`). A pasted object's other keys are named rather than dropped
 *   in silence, because this form cannot carry them back out.
 * - **`env` / `headers` start empty even when editing.** The engine expands `${VAR}` while reading,
 *   so a discovered value is a *resolved* one; prefilling it would write a token into the
 *   configuration file as plain text.
 */

export interface McpDefinitionPayload {
  name: string
  scope: EngineMcpScope
  definition: EngineMcpDefinitionInput
}

export interface McpRemovePayload {
  name: string
  scope: EngineMcpScope
}

export interface McpServerEditorProps {
  /** The definition being edited or copied; null while creating one. */
  subject: EngineMcpServerRow | null
  /** True when the card was filled in from a definition another tool owns. */
  copied: boolean
  /** What the write in flight is, so the buttons say saving or deleting. */
  busy: 'save' | 'remove' | null
  /** The host's refusal, which stays on screen while this card is open. */
  failure: ApiError | null
  onSave: (payload: McpDefinitionPayload) => void
  onRemove: (payload: McpRemovePayload) => void
  onCancel: () => void
}

/** The transports a definition may name, in the order the picker shows them. */
const TRANSPORTS: readonly McpTransport[] = ['stdio', 'http', 'sse']

/** The file a write targets; a row this app owns names one, and anything else starts at the user level. */
function scopeOf(value: string | null): EngineMcpScope {
  return value === 'project' ? 'project' : 'user'
}

/**
 * One optional object, folded away until it is wanted.
 *
 * Both optional fields are the same control — a label that opens a monospace textarea holding a JSON
 * object — so they are written once. The label keeps `SettingsField`'s own type, with the chevron
 * that says it opens something.
 */
function OptionalObjectField({
  label,
  placeholder,
  value,
  open,
  onChange,
  onToggle,
}: {
  label: string
  placeholder: string
  value: string
  open: boolean
  onChange: (value: string) => void
  onToggle: () => void
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex w-fit items-center gap-1.5 rounded-lg px-1 text-sm font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronDown
          className={cn('size-3.5 transition-transform', open && 'rotate-180')}
          aria-hidden="true"
        />
        {label}
      </button>
      {open ? (
        <SettingsTextarea
          rows={4}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          aria-label={label}
        />
      ) : null}
    </div>
  )
}

/**
 * The file a definition is written to: the same picker in both editor modes.
 *
 * A definition this app already owns cannot move between the two files — its scope is what the write
 * addresses — so the picker is disabled exactly when the name is locked.
 */
function ScopeSelect({
  value,
  disabled,
  onChange,
}: {
  value: EngineMcpScope
  disabled: boolean
  onChange: (value: EngineMcpScope) => void
}) {
  const copy = useCopy(MCP_COPY)
  return (
    <Select value={value} onValueChange={(next) => onChange(scopeOf(next))} disabled={disabled}>
      <SelectTrigger className="h-11">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="user">{copy.scopeUser}</SelectItem>
        <SelectItem value="project">{copy.scopeProject}</SelectItem>
      </SelectContent>
    </Select>
  )
}

export default function McpServerEditor({
  subject,
  copied,
  busy,
  failure,
  onSave,
  onRemove,
  onCancel,
}: McpServerEditorProps) {
  const copy = useCopy(MCP_COPY)

  /** A definition this app already owns: its name and its file are what address it, so neither moves. */
  const locked = subject !== null && !copied

  const [mode, setMode] = useState<'form' | 'json'>('form')
  const [name, setName] = useState(subject === null ? '' : subject.name)
  const [scope, setScope] = useState<EngineMcpScope>(scopeOf(subject === null ? null : subject.scope))
  const [transport, setTransport] = useState<McpTransport>(
    transportOf(subject === null ? 'stdio' : subject.transport),
  )
  const [command, setCommand] = useState(
    subject !== null && subject.transport === 'stdio' ? (subject.command ?? '') : '',
  )
  const [argsText, setArgsText] = useState(subject === null ? '' : subject.args.join(' '))
  const [url, setUrl] = useState(
    subject !== null && subject.transport !== 'stdio' ? (subject.url ?? '') : '',
  )
  const [timeoutText, setTimeoutText] = useState(
    subject === null || subject.timeoutMs === null ? '' : String(subject.timeoutMs),
  )
  // Never prefilled, on purpose — see the file's own note on `${VAR}` expansion.
  const [envText, setEnvText] = useState('')
  const [headersText, setHeadersText] = useState('')
  const [optionalOpen, setOptionalOpen] = useState(false)
  const [jsonDraft, setJsonDraft] = useState('')
  const [error, setError] = useState('')
  const [warning, setWarning] = useState('')
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  const deletable = subject !== null && !copied
  const title = copied
    ? copy.formCreateTitle
    : subject === null
      ? copy.formCreateTitle
      : copy.formEditTitle
  const description = copied
    ? copy.importNote
    : subject === null
      ? copy.formCreateDescription
      : copy.formEditDescription

  /** The definition the form submits, or a sentence saying what is missing. */
  function definitionFromForm(): EngineMcpDefinitionInput | string {
    const object = objectField(transport === 'stdio' ? envText : headersText)
    if (object === null) {
      return copy.jsonParseError
    }
    const timeout = timeoutText.trim()
    const timeoutMs = timeout.length === 0 ? null : Number(timeout)
    if (timeoutMs !== null && (!Number.isInteger(timeoutMs) || timeoutMs < 0)) {
      return copy.badTimeout
    }
    if (transport === 'stdio') {
      if (command.trim().length === 0) {
        return copy.missingCommand
      }
      return {
        transport,
        command: command.trim(),
        // The field is space separated, the wire is a list: a quoted argument this simple split
        // cannot honour is the one case a definition should be pasted in JSON instead.
        args: argsText
          .split(/\s+/)
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0),
        env: object,
        url: null,
        headers: {},
        cwd: null,
        timeoutMs,
      }
    }
    if (url.trim().length === 0) {
      return copy.missingUrl
    }
    return {
      transport,
      command: null,
      args: [],
      env: {},
      url: url.trim(),
      headers: object,
      cwd: null,
      timeoutMs,
    }
  }

  function submit(): void {
    if (busy !== null) return
    setWarning('')
    let targetName = name.trim()
    let definition: EngineMcpDefinitionInput | string
    if (mode === 'json') {
      const parsed = definitionFromJson(jsonDraft)
      if (parsed === null) {
        setError(copy.jsonParseError)
        return
      }
      // A locked name is what addresses the definition being edited, so a renamed draft key does not
      // move it; everywhere else the key in the draft is the name the reader is asking for.
      if (!locked && parsed.name !== null) {
        targetName = parsed.name
      }
      setWarning(
        parsed.unknown.length === 0 ? '' : copy.jsonUnknownKeys(parsed.unknown.join(', ')),
      )
      definition = parsed.definition
    } else {
      definition = definitionFromForm()
    }
    if (typeof definition === 'string') {
      setError(definition)
      return
    }
    if (targetName.length === 0) {
      setError(copy.missingName)
      return
    }
    setError('')
    onSave({ name: targetName, scope, definition })
  }

  function removeSubject(): void {
    if (busy !== null || subject === null) return
    if (!confirmingDelete) {
      setConfirmingDelete(true)
      return
    }
    onRemove({ name: subject.name, scope })
  }

  /** Switching to JSON seeds the draft from what the form currently holds, so nothing is retyped. */
  function showJson(): void {
    setMode('json')
    setWarning('')
    if (jsonDraft.trim().length > 0) {
      return
    }
    const definition = definitionFromForm()
    if (typeof definition === 'string') {
      return
    }
    const body: Record<string, unknown> = { type: definition.transport }
    if (definition.transport === 'stdio') {
      body.command = definition.command ?? ''
      if (definition.args !== undefined && definition.args !== null && definition.args.length > 0) {
        body.args = definition.args
      }
    } else {
      body.url = definition.url ?? ''
    }
    if (definition.timeoutMs !== undefined && definition.timeoutMs !== null) {
      body.timeout = definition.timeoutMs
    }
    const key = name.trim() === '' ? 'my-mcp-server' : name.trim()
    setJsonDraft(JSON.stringify({ [key]: body }, null, 2))
  }

  const optionalLabel = transport === 'stdio' ? copy.envOptional : copy.headersOptional

  return (
    <SettingsGroup title={title} description={description}>
      <SettingsCard>
        <div className="flex items-center justify-between gap-3 border-b border-border/60 px-5 py-3">
          <Button variant="outline" size="sm" disabled={busy !== null} onClick={onCancel}>
            <ChevronLeft className="size-3.5" aria-hidden="true" />
            {copy.formBack}
          </Button>
          <RadioGroup
            orientation="horizontal"
            value={mode}
            onValueChange={(value) => (value === 'json' ? showJson() : setMode('form'))}
          >
            <RadioGroupItem value="form" label={copy.modeForm} />
            <RadioGroupItem value="json" label={copy.modeJson} />
          </RadioGroup>
        </div>

        {mode === 'json' ? (
          <div className="flex flex-col gap-4 p-5">
            <div className="w-[180px]">
              <SettingsField label={copy.scopeLabel}>
                <ScopeSelect value={scope} disabled={locked} onChange={setScope} />
              </SettingsField>
            </div>
            <SettingsField label={copy.fullConfig}>
              <SettingsTextarea
                rows={12}
                value={jsonDraft}
                onChange={(event) => setJsonDraft(event.target.value)}
                placeholder={copy.jsonPlaceholder}
                aria-label={copy.fullConfig}
              />
            </SettingsField>
            <p className="text-[13px] leading-[19px] text-muted-foreground">
              {copy.pasteHintPrefix}{' '}
              <code className="rounded bg-muted px-1 py-px font-mono text-xs">
                {'{"server-name": {...}}'}
              </code>{' '}
              {copy.pasteHintMiddle}{' '}
              <code className="rounded bg-muted px-1 py-px font-mono text-xs">
                {'{"mcpServers": {"server-name": {...}}}'}
              </code>
              {copy.pasteHintSuffix}
            </p>
            {warning === '' ? null : (
              <p className="text-[13px] leading-[19px] text-muted-foreground" role="status">
                {warning}
              </p>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-4 p-5">
            <div className="flex flex-wrap items-start gap-4">
              <div className="min-w-[240px] flex-1">
                <Input
                  label={copy.nameLabel}
                  value={name}
                  onChange={setName}
                  placeholder={copy.namePlaceholder}
                  readOnly={locked}
                  title={locked ? copy.nameLocked : undefined}
                />
              </div>
              <div className="w-[180px]">
                <SettingsField label={copy.scopeLabel}>
                  <ScopeSelect value={scope} disabled={locked} onChange={setScope} />
                </SettingsField>
              </div>
            </div>

            <div className="flex flex-wrap items-start gap-4">
              <div className="w-[220px]">
                <SettingsField label={copy.typeLabel}>
                  <Select
                    value={transport}
                    onValueChange={(value) => setTransport(transportOf(value))}
                  >
                    <SelectTrigger className="h-11">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TRANSPORTS.map((option) => (
                        <SelectItem key={option} value={option}>
                          {copy.typeOptions[option]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </SettingsField>
              </div>
              <div className="w-[160px]">
                <Input
                  label={copy.timeoutLabel}
                  value={timeoutText}
                  onChange={setTimeoutText}
                  type="number"
                  inputMode="numeric"
                  placeholder={copy.timeoutPlaceholder}
                />
              </div>
            </div>

            {transport === 'stdio' ? (
              <>
                <Input
                  label={copy.commandLabel}
                  value={command}
                  onChange={setCommand}
                  placeholder={copy.commandPlaceholder}
                />
                <Input
                  label={copy.argsLabel}
                  value={argsText}
                  onChange={setArgsText}
                  placeholder={copy.argsPlaceholder}
                />
              </>
            ) : (
              <Input
                label={copy.urlLabel}
                value={url}
                onChange={setUrl}
                placeholder={copy.urlPlaceholder}
              />
            )}

            <OptionalObjectField
              label={optionalLabel}
              placeholder={transport === 'stdio' ? copy.envPlaceholder : copy.headersPlaceholder}
              value={transport === 'stdio' ? envText : headersText}
              open={optionalOpen}
              onChange={transport === 'stdio' ? setEnvText : setHeadersText}
              onToggle={() => setOptionalOpen((open) => !open)}
            />
          </div>
        )}

        {error === '' && failure === null ? null : (
          <div className="flex flex-col gap-1.5 border-t border-border/60 px-5 py-3">
            {error === '' ? null : (
              <p role="alert" className="text-[13px] leading-[19px] text-destructive">
                {error}
              </p>
            )}
            {failure === null ? null : (
              <p
                role="alert"
                className="flex flex-wrap items-center gap-1.5 text-[13px] leading-[19px] text-destructive"
              >
                {copy.saveFailed}
                <SettingsBadge>{failure.code}</SettingsBadge>
                <span className="min-w-0 text-muted-foreground">{failure.message}</span>
              </p>
            )}
          </div>
        )}

        {confirmingDelete && subject !== null ? (
          <div
            role="alertdialog"
            aria-label={copy.deleteConfirmTitle(subject.name)}
            className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 px-5 py-3.5"
          >
            <span className="flex min-w-0 flex-col gap-[3px]">
              <span className="text-sm leading-5 font-medium text-foreground">
                {copy.deleteConfirmTitle(subject.name)}
              </span>
              <span className="text-[13px] leading-[19px] text-muted-foreground">
                {copy.deleteConfirmDescription}
              </span>
            </span>
            <span className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={busy !== null}
                onClick={() => setConfirmingDelete(false)}
              >
                {copy.cancel}
              </Button>
              <Button variant="primary" size="sm" disabled={busy !== null} onClick={removeSubject}>
                {copy.deleteConfirmAction}
              </Button>
            </span>
          </div>
        ) : (
          <div className="flex items-center justify-end gap-2 border-t border-border/60 px-5 py-3.5">
            {deletable ? (
              <Button
                variant="outline"
                size="sm"
                className="mr-auto"
                disabled={busy !== null}
                onClick={removeSubject}
              >
                <Trash2 className="size-3.5" aria-hidden="true" />
                {copy.deleteServer}
              </Button>
            ) : null}
            <Button variant="outline" size="sm" disabled={busy !== null} onClick={onCancel}>
              {copy.cancel}
            </Button>
            <Button variant="primary" size="sm" disabled={busy !== null} onClick={submit}>
              {busy === null ? copy.save : busy === 'remove' ? copy.deleting : copy.saving}
            </Button>
          </div>
        )}
      </SettingsCard>
    </SettingsGroup>
  )
}
