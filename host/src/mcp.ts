/**
 * `mcp_list` / `mcp_set_enabled` / `mcp_upsert` / `mcp_remove`: the engine's MCP configuration, its
 * live connections, and the two writes that define servers.
 *
 * The list comes from the engine's own capability load, which is the only discovery entry that
 * returns *everything* it found - entries whose config file says `enabled:false`, and entries the
 * user's `disabledServers` denylist suppresses, are exactly the rows a settings page has to show
 * in order to offer a switch for them (ruling C6). What is then derived here is only the effective
 * state, from the two lists the engine's own writer maintains, mirroring the dashboard logic in
 * the engine's `state-manager`: the denylist wins outright, the allowlist overrides a config's own
 * `enabled:false`.
 *
 * Definition writes go through the engine's own config writer (`updateMCPServer` / `removeMCPServer`),
 * never through a file this host parses itself: the engine owns the format, the name rule, the
 * per-file lock and the validation, so re-implementing any of them here would be a second source of
 * truth about a file another process also writes.
 *
 * Live state is read, never produced: this module never constructs a manager and never connects a
 * server, so a host that has not activated a session reports `live:false` and `unknown` instead of
 * inventing a connection it would then have to tear down.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { clampText, enumField, requireBoolean, requireText, resolveCwd, takeRows } from './capabilities.ts'
import {
  CAPABILITY_ERRORS_MAX,
  CAPABILITY_NAME_MAX,
  CAPABILITY_ROWS_MAX,
  CAPABILITY_TEXT_MAX,
  CAPABILITY_CWD_MAX,
  MCP_ARGS_MAX,
  MCP_ENV_ENTRIES_MAX,
  MCP_HEADERS_MAX,
  MCP_TIMEOUT_MS_MAX,
  MCP_VALUE_CHARS_MAX,
} from './constants.ts'
import type { HostPaths } from './env.ts'
import { logLine, sanitizeConfigMessage } from './log.ts'
import { invalidInput } from './protocol/errors.ts'
import type { EngineMcpConfig, EngineMcpServer, MCPManager, SdkBundle } from './sdk.ts'
import type { SessionRegistry } from './sessions.ts'

/** Transport vocabulary the payload publishes; the engine's own union. */
const MCP_TRANSPORTS = ['stdio', 'http', 'sse'] as const
type McpTransport = (typeof MCP_TRANSPORTS)[number]

/**
 * Discovery providers whose config files this codebase owns, and therefore the only ones a toggle
 * may rewrite in place. Matches the comment on the engine's `setMcpServerEnabled`: tool-owned
 * configs (opencode.json, claude.json, settings.json …) are never mutated.
 */
const OWNED_MCP_PROVIDERS: Record<string, true> = { native: true, 'mcp-json': true }

/** One row of the server list. */
interface McpRow {
  readonly name: string
  readonly transport: McpTransport
  readonly target: string
  /**
   * The definition's own structural fields, as an editor starts from them.
   *
   * `target` is a rendering - a joined command line, or the endpoint - and splitting it back into a
   * command and its arguments would guess at quoting. These four are what the file actually holds,
   * and none of them can carry a credential, so they travel while `env` and `headers` do not.
   */
  readonly command: string | null
  readonly args: readonly string[]
  readonly url: string | null
  readonly timeoutMs: number | null
  readonly sourcePath: string
  readonly sourceProvider: string
  readonly level: 'user' | 'project' | 'native' | 'unknown'
  readonly configuredEnabled: boolean
  readonly enabled: boolean
  readonly override: 'none' | 'disabledByUser' | 'forceEnabledByUser'
  readonly status: 'connected' | 'connecting' | 'disconnected' | 'unknown'
  /**
   * Whether this application may rewrite this definition in place, and which of its two files
   * holds it. Decided here, once, from the same rule the write path uses (`OWNED_MCP_PROVIDERS`):
   * a page that derived it from the source path itself would be a second copy of that rule.
   */
  readonly writable: boolean
  readonly scope: 'user' | 'project' | null
  readonly toolCount: number
  readonly resourceCount: number
  readonly promptCount: number
  readonly error: string | null
}

/**
 * The two writable MCP config files a toggle addresses.
 *
 * These are the engine's `getMCPConfigPath(scope, cwd)` answers: user scope is `<agentDir>/mcp.json`
 * and project scope is `<cwd>/.omp/mcp.json` (the engine's `CONFIG_DIR_NAME`). The helper itself
 * lives in `@oh-my-pi/pi-utils`, which is not resolvable from `host/` - the host's dependency is the
 * coding-agent package alone - so the two literal paths are spelled here instead (see the wave
 * report's findings).
 */
function mcpConfigPaths(paths: HostPaths, cwd: string): { userPath: string; projectPath: string } {
  return {
    userPath: path.join(paths.agentDir, 'mcp.json'),
    projectPath: path.join(cwd, '.omp', 'mcp.json'),
  }
}

/** The transport a server connects over, in the engine's own normalization. */
function transportOf(server: EngineMcpServer): McpTransport {
  const declared = server.transport
  if (declared === 'stdio' || declared === 'http' || declared === 'sse') return declared
  if (server.command !== undefined && server.command !== '') return 'stdio'
  if (server.url !== undefined && server.url !== '') return 'http'
  return 'stdio'
}

/**
 * Whether two paths name the same file, ignoring separators and case.
 *
 * The engine realpaths what it reads, and Windows paths differ in both, so a comparison that does
 * not normalize would put a project definition in the user file - and the write would then replace
 * a definition that lives somewhere else.
 */
function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string => value.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase()
  return normalize(left) === normalize(right)
}

/** What the server connects to: a joined command line, or the endpoint URL. */
function targetOf(server: EngineMcpServer, transport: McpTransport): string {
  const raw = transport === 'stdio' ? [server.command ?? '', ...(server.args ?? [])].join(' ') : (server.url ?? '')
  return clampText(raw.trim(), CAPABILITY_TEXT_MAX).text ?? ''
}

/** Tool counts per server, from the manager's tool list and its own ownership field. */
function toolCounts(tools: readonly { mcpServerName?: string }[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const tool of tools) {
    const name = tool.mcpServerName
    if (name === undefined) continue
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  return counts
}

/**
 * Every manager this process holds, the process-global one first.
 *
 * A top-level session builds its own manager and installs it as the global instance, so the newest
 * conversation's manager - which may never have connected anything - is the one a naive read would
 * use. Every session's manager is therefore included, and {@link serverStatus} answers with the best
 * state any of them reports: a server connected in one conversation is connected.
 */
function liveManagers(sdk: SdkBundle, sessions: SessionRegistry): MCPManager[] {
  const managers: MCPManager[] = []
  for (const manager of [sdk.mcpManager(), ...sessions.mcpManagers()]) {
    if (manager !== undefined && !managers.includes(manager)) managers.push(manager)
  }
  return managers
}

/**
 * One server's live state, from the manager that actually holds it.
 *
 * `connected` beats `connecting` beats `disconnected`, and a host with no manager at all answers
 * `undefined` so the row reads `unknown` instead of claiming a state nothing observed.
 */
function serverStatus(managers: readonly MCPManager[], name: string): 'connected' | 'connecting' | 'disconnected' | undefined {
  let best: 'connected' | 'connecting' | 'disconnected' | undefined
  for (const manager of managers) {
    const status = manager.getConnectionStatus(name)
    if (status === 'connected') return 'connected'
    if (status === 'connecting') best = 'connecting'
    else if (best === undefined) best = 'disconnected'
  }
  return best
}

/** The manager that owns one server's connection: the first that reports it connected. */
function owningManager(managers: readonly MCPManager[], name: string): MCPManager | undefined {
  return managers.find(manager => manager.getConnectionStatus(name) === 'connected')
}

/**
 * The engine's own last failure for each server, as the managers report it.
 *
 * `waitForStartup` is the one public accessor that carries the reasons the engine recorded while
 * connecting (`MCPStartupStatus.failed`); a near-zero deadline makes it a snapshot rather than a
 * wait, which is what a list read wants.
 */
async function failureReasons(managers: readonly MCPManager[]): Promise<Map<string, string>> {
  const reasons = new Map<string, string>()
  const snapshots = await Promise.all(
    managers.map(manager => manager.waitForStartup(1).catch(() => ({ connected: [], pending: [], failed: [] }))),
  )
  for (const snapshot of snapshots) {
    for (const failure of snapshot.failed) {
      if (!reasons.has(failure.name)) reasons.set(failure.name, failure.error)
    }
  }
  return reasons
}

/**
 * The absolute path an engine discovery warning names, or null.
 *
 * Every shape the engine's providers write ends with the file it is about (`Failed to read
 * <path>`, `Invalid JSON in <path>`, `Invalid config for server "<name>" in <path>`), so the last
 * whitespace-delimited token is the candidate. It counts only when it looks like an absolute path:
 * a sentence this cannot be read out of is reported exactly as the engine wrote it, because
 * guessing a path would be worse than showing none.
 */
function namedPath(message: string): string | null {
  const candidate = (message.trim().split(/\s+/).pop() ?? '').replace(/["')\]}.,;:]+$/, '')
  const isAbsolute = candidate.startsWith('/') || candidate.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(candidate)
  return isAbsolute ? candidate : null
}

/**
 * One discovery warning as a row the page can act on, or null when there is nothing to act on.
 *
 * The path is kept: it is the only part of the sentence a reader can do something about, and this
 * page shows the paths it owns anyway (`sanitizeConfigMessage` still redacts credentials). A
 * warning about a file that is **not there** is dropped instead of shown - the engine's VS Code
 * provider reports a missing *optional* `.vscode/mcp.json` as `Failed to read`, which is not a
 * load failure (the engine's own `mcp-json` provider skips a missing file without a word), and a
 * section headed "configuration problems" must not list "no such file" as one. Nothing is hidden:
 * the drop is written to the host's log.
 */
function problemRow(message: string): Record<string, unknown> | null {
  const named = namedPath(message)
  if (named !== null && !fs.existsSync(named)) {
    logLine(`mcp discovery warning dropped, the file it names does not exist: ${path.basename(named)}`)
    return null
  }
  return {
    serverName: null,
    sourcePath: null,
    message: clampText(sanitizeConfigMessage(message), CAPABILITY_TEXT_MAX).text ?? '',
  }
}

/** The `mcp_list` payload. */
async function mcpView(
  paths: HostPaths,
  sdk: SdkBundle,
  sessions: SessionRegistry,
  cwd: string,
): Promise<Record<string, unknown>> {
  const { userPath, projectPath } = mcpConfigPaths(paths, cwd)
  const [disabledServers, forcedEnabled, discovered] = await Promise.all([
    sdk.readDisabledServers(userPath),
    sdk.readEnabledServers(userPath),
    sdk.mcpServers(cwd),
  ])
  const disabled = new Set(disabledServers)
  const forced = new Set(forcedEnabled)
  const managers = liveManagers(sdk, sessions)
  const reasons = await failureReasons(managers)

  const rows: McpRow[] = discovered.items.map(server => {
    const configuredEnabled = server.enabled !== false
    const level = server._source.level
    const transport = transportOf(server)
    const status = serverStatus(managers, server.name) ?? 'unknown'
    // Tool counts come from the manager that holds this server: two managers can both know it, and
    // summing them would report one server's tools twice.
    const owner = owningManager(managers, server.name)
    const counts = owner === undefined
      ? new Map<string, number>()
      : toolCounts(owner.getTools())
    return {
      name: server.name,
      transport,
      target: targetOf(server, transport),
      command: server.command ?? null,
      args: server.args === undefined ? [] : [...server.args],
      url: server.url ?? null,
      timeoutMs: server.timeout === undefined ? null : server.timeout,
      sourcePath: server._source.path,
      sourceProvider: server._source.provider,
      level: level === 'user' || level === 'project' || level === 'native' ? level : 'unknown',
      configuredEnabled,
      // Denylist wins over everything; the allowlist is what re-enables a config that says
      // `enabled:false` (the same order the engine's own suppression applies).
      enabled: !disabled.has(server.name) && (configuredEnabled || forced.has(server.name)),
      override: disabled.has(server.name)
        ? 'disabledByUser'
        : forced.has(server.name)
          ? 'forceEnabledByUser'
          : 'none',
      status,
      writable: OWNED_MCP_PROVIDERS[server._source.provider] === true,
      scope: OWNED_MCP_PROVIDERS[server._source.provider] === true && server._source.path !== undefined
        ? (samePath(server._source.path, projectPath) ? 'project' : 'user')
        : null,
      toolCount: counts.get(server.name) ?? 0,
      resourceCount: resourceCount(owner, server.name),
      promptCount: owner?.getServerPrompts(server.name)?.length ?? 0,
      // The engine's own reason for a server that did not come up, already its own words: what the
      // row's failure badge shows on hover. A server that is up has no failure to report.
      error: status === 'connected' ? null : (reasons.get(server.name) ?? null),
    }
  })

  const capped = takeRows(rows, CAPABILITY_ROWS_MAX)
  const problems = discovered.warnings
    .map(message => problemRow(message))
    .filter((row): row is Record<string, unknown> => row !== null)
  const errors = takeRows(problems, CAPABILITY_ERRORS_MAX)
  const disabledRows = takeRows(disabledServers, CAPABILITY_ROWS_MAX)
  const forcedRows = takeRows(forcedEnabled, CAPABILITY_ROWS_MAX)

  return {
    live: managers.length > 0,
    cwd,
    servers: capped.rows,
    errors: errors.rows,
    disabledByUser: disabledRows.rows,
    forceEnabledByUser: forcedRows.rows,
    summary: {
      total: rows.length,
      enabled: rows.reduce((total, row) => total + (row.enabled ? 1 : 0), 0),
      connected: rows.reduce((total, row) => total + (row.status === 'connected' ? 1 : 0), 0),
    },
    // Rows, discovery paths and the two user lists are all bounded; one flag says so.
    truncated: capped.truncated || errors.truncated || disabledRows.truncated || forcedRows.truncated,
  }
}

/** Resources a connected server exposes, counting list entries and templates alike. */
function resourceCount(manager: MCPManager | undefined, name: string): number {
  const resources = manager?.getServerResources(name)
  if (resources === undefined) return 0
  return resources.resources.length + resources.templates.length
}

/** `mcp_list`: every discovered MCP server, with live state when a manager exists. */
export async function listMcp(
  paths: HostPaths,
  sdk: SdkBundle,
  sessions: SessionRegistry,
  frame: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const cwd = resolveCwd(paths, frame.cwd)
  // MCP config files are read through the engine's process-wide capability cache, so a server added
  // to `<agentDir>/mcp.json` or `<cwd>/.omp/mcp.json` after this host booted would otherwise stay
  // invisible for the life of the process; the engine resets the cache after a filesystem change
  // (`capability.reset()`, ruling C22).
  sdk.resetCapabilities()
  return await mcpView(paths, sdk, sessions, cwd)
}

/** `mcp_set_enabled`: one server's switch, answered with the state the write produced. */
export async function setMcpEnabled(
  paths: HostPaths,
  sdk: SdkBundle,
  sessions: SessionRegistry,
  frame: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const cwd = resolveCwd(paths, frame.cwd)
  const name = requireText(frame.name, 'name', CAPABILITY_NAME_MAX)
  const enabled = requireBoolean(frame.enabled, 'enabled')
  const { userPath, projectPath } = mcpConfigPaths(paths, cwd)
  // The name has to be addressable in the list this host is about to consult, so the cache is
  // dropped here too (ruling C22), before the discovery that decides whether the name exists.
  sdk.resetCapabilities()
  const discovered = await sdk.mcpServers(cwd)
  const server = discovered.items.find(entry => entry.name === name)
  if (server === undefined) throw invalidInput(`No MCP server is named "${name}".`)

  await sdk.setMcpServerEnabled({
    userPath,
    projectPath,
    // Only a config file this codebase owns may be rewritten in place; for every other source the
    // engine's writer falls back to the user-level denylist/allowlist.
    ...(OWNED_MCP_PROVIDERS[server._source.provider] === true ? { sourcePath: server._source.path } : {}),
    name,
    enabled,
  })
  return await mcpView(paths, sdk, sessions, cwd)
}

// ---- definitions: create, edit, delete, import ----

/** How a definition may be written: the two config files this desktop owns. */
const MCP_SCOPES = ['user', 'project'] as const
type McpScope = (typeof MCP_SCOPES)[number]

/**
 * The keys the editor owns. Everything else a stored definition carries - `enabled`,
 * `requestIdFormat`, `auth`, `oauth`, a plugin's `envPolicy` - is left exactly as it was, because a
 * form that dropped what it does not show would rewrite a server's authentication as a side effect
 * of changing its arguments.
 */
const EDITOR_KEYS = ['type', 'command', 'args', 'env', 'url', 'headers', 'cwd', 'timeout'] as const

/** One definition as an editor submits it. */
interface DefinitionInput {
  readonly name: string
  readonly scope: McpScope
  readonly transport: McpTransport
  readonly command: string | null
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly url: string | null
  readonly headers: Readonly<Record<string, string>>
  readonly cwd: string | null
  readonly timeoutMs: number | null
}

/** A list of non-empty strings; absent means "none", and an oversized one is refused, not cut. */
function stringList(value: unknown, field: string, max: number): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw invalidInput(`${field} must be an array of strings.`)
  if (value.length > max) throw invalidInput(`${field} carries more than ${max} entries.`)
  return value.map(entry => requireText(entry, field, MCP_VALUE_CHARS_MAX))
}

/** A string map with bounded keys and values; absent means "none". */
function stringMap(value: unknown, field: string, maxEntries: number): Record<string, string> {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw invalidInput(`${field} must be an object of strings.`)
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length > maxEntries) throw invalidInput(`${field} carries more than ${maxEntries} entries.`)
  const out: Record<string, string> = {}
  for (const [key, entry] of entries) {
    out[requireText(key, field, CAPABILITY_NAME_MAX)] = requireText(entry, field, MCP_VALUE_CHARS_MAX)
  }
  return out
}

/** An optional positive integer, bounded; absent means "the engine's default". */
function boundedCount(value: unknown, field: string, max: number): number | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max) {
    throw invalidInput(`${field} must be an integer between 0 and ${max}.`)
  }
  return value
}

/**
 * The definition one write carries.
 *
 * Shape is checked here and *validity* is the engine's: `validateServerName` is the engine's own
 * rule (so a name this file may not carry is refused with its wording), and the rest is validated
 * by the writer itself before it touches the file.
 */
function definitionInput(sdk: SdkBundle, frame: Record<string, unknown>): DefinitionInput {
  const name = requireText(frame.name, 'name', CAPABILITY_NAME_MAX)
  const nameError = sdk.validateServerName(name)
  if (nameError !== undefined) throw invalidInput(nameError)
  const scope = enumField(frame.scope, MCP_SCOPES, 'scope')
  const raw = frame.definition
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw invalidInput('A definition object is required.')
  }
  const definition = raw as Record<string, unknown>
  const transport = enumField(definition.transport, MCP_TRANSPORTS, 'transport')
  const command = definition.command === undefined || definition.command === null
    ? null
    : requireText(definition.command, 'command', MCP_VALUE_CHARS_MAX)
  const url = definition.url === undefined || definition.url === null
    ? null
    : requireText(definition.url, 'url', MCP_VALUE_CHARS_MAX)
  if (transport === 'stdio') {
    if (command === null) throw invalidInput('A stdio server is defined by its command.')
    if (url !== null) throw invalidInput('A stdio server cannot also carry a url.')
  } else {
    if (url === null) throw invalidInput(`A ${transport} server is defined by its url.`)
    if (command !== null) throw invalidInput(`A ${transport} server cannot also carry a command.`)
    if (!/^https?:\/\//i.test(url)) throw invalidInput('A server url must be http or https.')
  }
  return {
    name,
    scope,
    transport,
    command,
    url,
    args: stringList(definition.args, 'args', MCP_ARGS_MAX),
    env: stringMap(definition.env, 'env', MCP_ENV_ENTRIES_MAX),
    headers: stringMap(definition.headers, 'headers', MCP_HEADERS_MAX),
    cwd: definition.cwd === undefined || definition.cwd === null
      ? null
      : requireText(definition.cwd, 'definition cwd', CAPABILITY_CWD_MAX),
    timeoutMs: boundedCount(definition.timeoutMs, 'timeoutMs', MCP_TIMEOUT_MS_MAX),
  }
}

/** The config file a scope writes to: the engine's own user or project `mcp.json`. */
function scopePath(paths: HostPaths, cwd: string, scope: McpScope): string {
  const { userPath, projectPath } = mcpConfigPaths(paths, cwd)
  return scope === 'user' ? userPath : projectPath
}

/**
 * Any stored value as a plain record. Anything else - absent, a string, an array - is "no stored
 * definition to merge with", and the copy also keeps the merge from writing back into whatever the
 * engine handed us.
 */
function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) out[key] = entry
  return out
}

/**
 * A merged record as the engine's config type.
 *
 * The record is a stored definition with the editor's keys replaced, built by spreading - which
 * TypeScript cannot narrow from `Record<string, unknown>` to the three shapes of `MCPServerConfig`.
 * The conversion states where the check happens instead: `updateMCPServer` runs the engine's own
 * `validateServerConfig` and name rule before it writes, so a definition that is not valid is
 * refused there, never stored.
 */
function engineConfig(record: Record<string, unknown>): EngineMcpConfig {
  return record as unknown as EngineMcpConfig
}

/**
 * What to store: the keys the editor owns, replaced; every other key of the existing definition
 * kept. An empty list or map is written by omission - the engine's formats treat "absent" and
 * "empty" the same, and leaving them out keeps the file readable.
 */
function mergedDefinition(existing: unknown, input: DefinitionInput): EngineMcpConfig {
  const merged = asRecord(existing)
  for (const key of EDITOR_KEYS) delete merged[key]
  merged.type = input.transport
  if (input.transport === 'stdio') {
    merged.command = input.command
    if (input.args.length > 0) merged.args = [...input.args]
    if (Object.keys(input.env).length > 0) merged.env = { ...input.env }
    if (input.cwd !== null) merged.cwd = input.cwd
  } else {
    merged.url = input.url
    if (Object.keys(input.headers).length > 0) merged.headers = { ...input.headers }
  }
  if (input.timeoutMs !== null) merged.timeout = input.timeoutMs
  return engineConfig(merged)
}

/**
 * Connects definitions a write has just stored, on the live manager.
 *
 * A stored definition is not a connection: the engine builds its manager when a session starts and
 * keeps it for the process, so a server added afterwards stays unknown until a restart - the
 * reader's "it only connects after I restart" report. `MCPManager.connectServers` is the engine's
 * own incremental path (the one `/mcp enable` uses): it takes the discovered definition with its
 * source metadata, merges the new server's tools, and leaves every other connection untouched. The
 * owning session's tool list is rebuilt by the manager's own `setOnToolsChanged` wiring, so nothing
 * here refreshes a session.
 *
 * Only a definition from a file this application owns is passed, and only while it is enabled: a
 * server another tool's config provides is not this application's to bring up, and the answer
 * stays a read.
 */
export async function connectWritten(
  sdk: SdkBundle,
  sessions: SessionRegistry,
  cwd: string,
  names: readonly string[],
): Promise<void> {
  const managers = liveManagers(sdk, sessions)
  if (managers.length === 0 || names.length === 0) return
  // The definitions were written a moment ago, so the capability cache has to be dropped first.
  sdk.resetCapabilities()
  const discovered = await sdk.mcpServers(cwd)
  const configs: Record<string, EngineMcpConfig> = {}
  const sources: Record<string, NonNullable<EngineMcpServer['_source']>> = {}
  for (const name of names) {
    const server = discovered.items.find(entry => entry.name === name)
    if (server === undefined || server.enabled === false) continue
    const source = server._source
    if (source === undefined || OWNED_MCP_PROVIDERS[source.provider] !== true) continue
    const config = await sdk.getMCPServer(source.path, name)
    if (config === undefined) continue
    configs[name] = config
    sources[name] = source
  }
  if (Object.keys(configs).length === 0) return
  try {
    // Every live manager, because each conversation holds its own tool set: a server up in one and
    // not the other is exactly what the reader notices when they switch conversations.
    await Promise.all(managers.map(manager => manager.connectServers(configs, sources)))
    logLine(`mcp: connected ${Object.keys(configs).join(', ')}`)
  } catch (error) {
    // The definition is on disk and correct; a failed handshake is the server's own answer and is
    // reported by the list's status, not by failing the write that stored it.
    const reason = error instanceof Error ? error.message : String(error)
    logLine(`mcp: a written server did not connect: ${reason}`)
  }
}

/** `mcp_upsert`: creates a definition, or replaces the keys an edit owns. Answers the new list. */
export async function upsertMcp(
  paths: HostPaths,
  sdk: SdkBundle,
  sessions: SessionRegistry,
  frame: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const cwd = resolveCwd(paths, frame.cwd)
  const input = definitionInput(sdk, frame)
  const filePath = scopePath(paths, cwd, input.scope)
  // The definition is read from the file this write targets (for the merge) and the list is read
  // after it, so both go through the engine's capability cache: it is dropped first.
  sdk.resetCapabilities()
  const existing = await sdk.getMCPServer(filePath, input.name)
  await sdk.updateMCPServer(filePath, input.name, mergedDefinition(existing, input))
  // A definition written into a running process is not a connection yet: bring it up now rather
  // than at the next start.
  await connectWritten(sdk, sessions, cwd, [input.name])
  return await mcpView(paths, sdk, sessions, cwd)
}

/** `mcp_remove`: deletes one definition from the file its scope names. */
export async function removeMcp(
  paths: HostPaths,
  sdk: SdkBundle,
  sessions: SessionRegistry,
  frame: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const cwd = resolveCwd(paths, frame.cwd)
  const name = requireText(frame.name, 'name', CAPABILITY_NAME_MAX)
  const scope = enumField(frame.scope, MCP_SCOPES, 'scope')
  sdk.resetCapabilities()
  await sdk.removeMCPServer(scopePath(paths, cwd, scope), name)
  return await mcpView(paths, sdk, sessions, cwd)
}
