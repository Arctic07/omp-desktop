/**
 * `mcp_import_scan` / `mcp_import_apply`: MCP servers defined by the other coding agents on this
 * machine - Claude Code, Codex, omp and the legacy pi layout - copied into this application.
 *
 * The engine's own discovery cannot answer this. Its providers resolve every user-level path from
 * `os.homedir()`, and this host runs with `HOME` pinned to the application's data root
 * (`env.ts`, `rules.md#engine-integration-and-data-ownership`), so under the pinned home there is
 * no other agent's configuration to find - which is why the MCP page's import offered nothing. The
 * desktop therefore names the real profile (`homeDir`) and this module reads the four agents'
 * files itself:
 *
 * - Claude Code: `~/.claude.json` and `~/.claude/mcp.json`, `mcpServers` maps;
 * - Codex: `~/.codex/config.toml`, `[mcp_servers.<name>]` tables (snake_case keys);
 * - omp: `<ompAgentDir>/mcp.json` - the path the desktop discovered, `PI_CONFIG_DIR` aware;
 * - pi: `~/.pi/agent/mcp.json`, the layout this engine carried before it was renamed.
 *
 * A *foreign* tool's file is being read, not this engine's, so parsing it here is not a second copy
 * of an engine format - and the write still goes through the engine's own writer
 * (`updateMCPServer`) and its own live connect (`connectWritten`), so nothing downstream is
 * reimplemented.
 *
 * Additive and deduplicated by server name, like the local-configuration import: a name this
 * application already defines is skipped, and a second run copies nothing.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { clampText, requireText, takeRows } from './capabilities.ts'
import { CAPABILITY_CWD_MAX, CAPABILITY_ROWS_MAX, CAPABILITY_TEXT_MAX, CAPABILITY_WARNINGS_MAX } from './constants.ts'
import { logLine, sanitizeConfigMessage } from './log.ts'
import { connectWritten } from './mcp.ts'
import { invalidInput } from './protocol/errors.ts'
import type { EngineMcpConfig, SdkBundle } from './sdk.ts'
import type { SessionRegistry } from './sessions.ts'

/** The agents whose MCP definitions this application can copy in. */
const SOURCES = ['claude', 'codex', 'omp', 'pi'] as const
type SourceId = (typeof SOURCES)[number]

/** One server a source defines. */
interface SourceServer {
  readonly name: string
  readonly transport: string
  readonly target: string
  readonly config: EngineMcpConfig
  /** A credential the source resolves through its own environment, which this app cannot carry. */
  readonly needsEnvironment: boolean
  /** This application's own words for what the reader would have to fill in, or `null`. */
  readonly note: string | null
}

/** One source's read result. */
interface SourceRead {
  readonly id: SourceId
  readonly present: boolean
  /** The file the definitions came from, or would have. */
  readonly path: string
  readonly servers: readonly SourceServer[]
  readonly warnings: readonly string[]
}

/** Where each agent keeps its user-level configuration, under the real profile. */
function sourcePaths(homeDir: string, ompAgentDir: string): Record<SourceId, string[]> {
  return {
    claude: [path.join(homeDir, '.claude.json'), path.join(homeDir, '.claude', 'mcp.json')],
    codex: [path.join(homeDir, '.codex', 'config.toml')],
    omp: [path.join(ompAgentDir, 'mcp.json')],
    pi: [path.join(homeDir, '.pi', 'agent', 'mcp.json')],
  }
}

/**
 * A definition as this module assembles it, before the engine's writer sees it.
 *
 * The engine's own type is a discriminated union, which is the right shape at the boundary but not
 * while the keys are being copied one by one from a foreign file; `updateMCPServer` validates the
 * result (`validateServerConfig`), so this is a staging shape, not a second contract.
 */
interface DraftConfig {
  type?: 'stdio' | 'http' | 'sse'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  cwd?: string
  timeout?: number
  enabled?: boolean
}

/** The transport a definition connects over, in the engine's own normalization. */
function transportOf(config: DraftConfig): string {
  if (config.type === 'http' || config.type === 'sse') return config.type
  return config.type === 'stdio' || config.command !== undefined ? 'stdio' : 'http'
}

/** What the server connects to: a joined command line, or the url. */
function targetOf(config: DraftConfig): string {
  const raw = transportOf(config) === 'stdio'
    ? [config.command ?? '', ...(config.args ?? [])].join(' ').trim()
    : (config.url ?? '')
  return clampText(raw, CAPABILITY_TEXT_MAX).text ?? ''
}

/**
 * A JSON `mcpServers` map entry as the engine's own definition.
 *
 * The keys are the shape both Claude Code and omp write; anything the engine does not accept is
 * refused by `updateMCPServer` on the way in, so this mapping only has to carry the fields over
 * without inventing values.
 */
function jsonServer(name: string, raw: unknown): SourceServer | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const entry = raw as Record<string, unknown>
  const command = typeof entry.command === 'string' ? entry.command : undefined
  const url = typeof entry.url === 'string' ? entry.url : undefined
  if (command === undefined && url === undefined) return null
  const type = entry.type === 'http' || entry.type === 'sse' || entry.type === 'stdio' ? entry.type : undefined
  const config: DraftConfig = {
    ...(type !== undefined ? { type } : {}),
    ...(command !== undefined ? { command } : {}),
    ...(Array.isArray(entry.args) ? { args: entry.args.filter((a): a is string => typeof a === 'string') } : {}),
    ...(isStringMap(entry.env) ? { env: entry.env } : {}),
    ...(url !== undefined ? { url } : {}),
    ...(isStringMap(entry.headers) ? { headers: entry.headers } : {}),
    ...(typeof entry.cwd === 'string' ? { cwd: entry.cwd } : {}),
    ...(typeof entry.timeout === 'number' ? { timeout: entry.timeout } : {}),
    ...(typeof entry.enabled === 'boolean' ? { enabled: entry.enabled } : {}),
  }
  // `${VAR}` inside env/headers is expanded by the engine at connect time from its own (pinned)
  // environment, so a definition that references one needs the reader's input here.
  const needsEnvironment = Object.values({ ...(entry.env ?? {}), ...(entry.headers ?? {}) }).some(
    value => typeof value === 'string' && value.includes('${'),
  )
  return {
    name,
    transport: transportOf(config),
    target: targetOf(config),
    config: config as unknown as EngineMcpConfig,
    needsEnvironment,
    note: needsEnvironment ? 'environment-reference' : null,
  }
}

/** A string map, or `undefined` when the value is not one. */
function isStringMap(value: unknown): value is Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  return Object.values(value).every(entry => typeof entry === 'string')
}

/**
 * One Codex `[mcp_servers.<name>]` table as the engine's own definition.
 *
 * Codex names the same facts in snake_case and resolves three of them through the environment it
 * was started with (`env_vars`, `env_http_headers`, `bearer_token_env_var`). This application's
 * host runs with a pinned, sanitized environment, so those references cannot be resolved here: the
 * definition is still copied, and the row says what is missing instead of sending a wrong value.
 */
function codexServer(name: string, raw: unknown): SourceServer | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const entry = raw as Record<string, unknown>
  const command = typeof entry.command === 'string' ? entry.command : undefined
  const url = typeof entry.url === 'string' ? entry.url : undefined
  if (command === undefined && url === undefined) return null
  const env: Record<string, string> = isStringMap(entry.env) ? { ...entry.env } : {}
  const headers: Record<string, string> = isStringMap(entry.http_headers) ? { ...entry.http_headers } : {}
  const forwardsEnvironment =
    (Array.isArray(entry.env_vars) && entry.env_vars.length > 0) ||
    (typeof entry.env_http_headers === 'object' && entry.env_http_headers !== null) ||
    typeof entry.bearer_token_env_var === 'string'
  const timeoutSeconds = typeof entry.startup_timeout_sec === 'number' ? entry.startup_timeout_sec : undefined
  const config: DraftConfig = {
    ...(command !== undefined ? { command } : {}),
    ...(Array.isArray(entry.args) ? { args: entry.args.filter((a): a is string => typeof a === 'string') } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
    ...(url !== undefined ? { url } : {}),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(typeof entry.cwd === 'string' ? { cwd: entry.cwd } : {}),
    ...(timeoutSeconds !== undefined ? { timeout: Math.round(timeoutSeconds * 1000) } : {}),
    ...(entry.enabled === false ? { enabled: false } : {}),
  }
  return {
    name,
    transport: transportOf(config),
    target: targetOf(config),
    config: config as unknown as EngineMcpConfig,
    needsEnvironment: forwardsEnvironment,
    note: forwardsEnvironment ? 'environment-forwarded' : null,
  }
}

/** The servers one `mcpServers` map defines. */
function fromJsonServers(map: unknown, read: (name: string, raw: unknown) => SourceServer | null): SourceServer[] {
  if (typeof map !== 'object' || map === null || Array.isArray(map)) return []
  const servers: SourceServer[] = []
  for (const [name, raw] of Object.entries(map as Record<string, unknown>)) {
    const server = read(name, raw)
    if (server !== null) servers.push(server)
  }
  return servers
}

/** Each `projects.<path>.mcpServers` map a Claude Code file carries, in file order. */
function projectMaps(projects: unknown): unknown[] {
  if (typeof projects !== 'object' || projects === null || Array.isArray(projects)) return []
  return Object.values(projects as Record<string, unknown>).map(entry =>
    typeof entry === 'object' && entry !== null && !Array.isArray(entry)
      ? (entry as { mcpServers?: unknown }).mcpServers
      : undefined,
  )
}

/** The JSON files one source keeps, merged in the order the engine would read them. */
function readJsonSource(id: SourceId, files: readonly string[]): SourceRead {
  const servers: SourceServer[] = []
  const warnings: string[] = []
  let present = false
  for (const file of files) {
    let text: string
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    present = true
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      warnings.push(`${path.basename(file)} could not be read: ${sanitizeConfigMessage(reason)}`)
      continue
    }
    const root = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as { mcpServers?: unknown; projects?: unknown })
      : {}
    // Claude Code keeps user-scope servers at the top and the default (`local`) scope inside the
    // project entry it belongs to; a file without `projects` is simply the first case. Reading only
    // the top level would report "present, 0 servers" for most Claude Code installs.
    for (const map of [root.mcpServers, ...projectMaps(root.projects)]) {
      for (const server of fromJsonServers(map, jsonServer)) {
        if (!servers.some(existing => existing.name === server.name)) servers.push(server)
      }
    }
  }
  return { id, present, path: files[0] ?? '', servers, warnings }
}

/** Codex's `config.toml`, read with the runtime's own TOML parser. */
function readCodexSource(file: string): SourceRead {
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return { id: 'codex', present: false, path: file, servers: [], warnings: [] }
  }
  let parsed: unknown
  try {
    // `Bun.TOML` is the runtime's parser (the engine's own Codex provider uses it); the ambient Bun
    // types this repository builds against do not declare it yet, so the access is named once here.
    parsed = (Bun as unknown as { TOML: { parse(text: string): unknown } }).TOML.parse(text)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return {
      id: 'codex',
      present: true,
      path: file,
      servers: [],
      warnings: [`config.toml could not be read: ${sanitizeConfigMessage(reason)}`],
    }
  }
  const table = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? (parsed as { mcp_servers?: unknown }).mcp_servers
    : undefined
  return {
    id: 'codex',
    present: true,
    path: file,
    servers: fromJsonServers(table, codexServer),
    warnings: [],
  }
}

/** Every source, read once per command. */
function readSources(homeDir: string, ompAgentDir: string): SourceRead[] {
  const paths = sourcePaths(homeDir, ompAgentDir)
  return SOURCES.map(id =>
    id === 'codex' ? readCodexSource(paths[id][0] ?? '') : readJsonSource(id, paths[id]),
  )
}

/** The real profile and the omp agent directory, validated: absolute, and either may be absent. */
function locations(frame: Record<string, unknown>): { homeDir: string; ompAgentDir: string } {
  const homeDir = requireText(frame.homeDir, 'homeDir', CAPABILITY_CWD_MAX)
  const ompAgentDir = requireText(frame.ompAgentDir, 'ompAgentDir', CAPABILITY_CWD_MAX)
  for (const [field, value] of [['homeDir', homeDir], ['ompAgentDir', ompAgentDir]] as const) {
    if (!path.isAbsolute(value)) throw invalidInput(`${field} must be an absolute path.`)
  }
  return { homeDir: path.resolve(homeDir), ompAgentDir: path.resolve(ompAgentDir) }
}

/**
 * The names this application already defines, by the engine's own discovery plus its user file.
 *
 * Discovery covers a server a project file or a plugin supplies; the user file covers one this
 * application wrote and the engine has not re-read yet.
 */
async function existingNames(paths: HostPathsLike, sdk: SdkBundle): Promise<Set<string>> {
  sdk.resetCapabilities()
  const discovered = await sdk.mcpServers(paths.defaultWorkspace)
  const names = new Set(discovered.items.map(server => server.name))
  try {
    const userConfig = JSON.parse(fs.readFileSync(path.join(paths.agentDir, 'mcp.json'), 'utf8')) as {
      mcpServers?: Record<string, unknown>
    }
    for (const name of Object.keys(userConfig.mcpServers ?? {})) names.add(name)
  } catch {
    // No user file yet is the normal first run.
  }
  return names
}

/** The host paths this module needs; named so the caller passes the whole object it already has. */
interface HostPathsLike {
  readonly agentDir: string
  readonly defaultWorkspace: string
}

/** `mcp_import_scan`: the four agents on this machine, and what each of them defines. */
export async function scanMcpSources(
  paths: HostPathsLike,
  sdk: SdkBundle,
  frame: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { homeDir, ompAgentDir } = locations(frame)
  const existing = await existingNames(paths, sdk)
  const reads = readSources(homeDir, ompAgentDir)
  const warnings: string[] = []
  const sources = reads.map(read => {
    warnings.push(...read.warnings)
    return {
      id: read.id,
      path: read.path,
      present: read.present,
      servers: takeRows(
        read.servers.map(server => ({
          name: server.name,
          transport: server.transport,
          target: server.target,
          status: existing.has(server.name) ? 'configured' : 'importable',
          note: server.note,
        })),
        CAPABILITY_ROWS_MAX,
      ).rows,
    }
  })
  const cappedWarnings = takeRows(warnings, CAPABILITY_WARNINGS_MAX)
  return {
    home: homeDir,
    sources,
    warnings: cappedWarnings.rows,
    truncated: cappedWarnings.truncated,
  }
}

/** `mcp_import_apply`: copies the selected sources' servers this application does not have. */
export async function applyMcpSources(
  paths: HostPathsLike,
  sdk: SdkBundle,
  sessions: SessionRegistry,
  frame: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { homeDir, ompAgentDir } = locations(frame)
  const requested = frame.sources
  if (!Array.isArray(requested) || requested.length === 0) {
    throw invalidInput('sources must name at least one agent.')
  }
  const selected = new Set<SourceId>()
  for (const value of requested) {
    const id = SOURCES.find(entry => entry === value)
    if (id === undefined) throw invalidInput(`Unknown source: ${String(value)}.`)
    selected.add(id)
  }

  const existing = await existingNames(paths, sdk)
  const userPath = path.join(paths.agentDir, 'mcp.json')
  const reads = readSources(homeDir, ompAgentDir).filter(read => selected.has(read.id))
  const warnings: string[] = []
  const imported: string[] = []
  const skipped: Array<{ name: string; reason: string }> = []

  for (const read of reads) {
    warnings.push(...read.warnings)
    if (!read.present) {
      skipped.push({ name: read.id, reason: 'not-found' })
      continue
    }
    for (const server of read.servers) {
      if (existing.has(server.name)) {
        skipped.push({ name: server.name, reason: 'configured' })
        continue
      }
      try {
        await sdk.updateMCPServer(userPath, server.name, server.config)
        existing.add(server.name)
        imported.push(server.name)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        warnings.push(`The MCP server "${server.name}" was not imported: ${sanitizeConfigMessage(reason)}`)
      }
    }
  }

  // A stored definition does not connect by itself: bring the imported ones up in every live
  // conversation, exactly as the definition editor's save does.
  await connectWritten(sdk, sessions, paths.defaultWorkspace, 'user', imported)
  sdk.resetCapabilities()
  if (imported.length > 0) logLine(`mcp import: ${imported.join(', ')}`)

  const cappedWarnings = takeRows(warnings, CAPABILITY_WARNINGS_MAX)
  return {
    home: homeDir,
    imported,
    skipped,
    warnings: cappedWarnings.rows,
    truncated: cappedWarnings.truncated,
  }
}
