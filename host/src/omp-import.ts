/**
 * `omp_import_scan` / `omp_import_apply`: another omp installation's user configuration, read from
 * its own agent directory and copied into this application's engine.
 *
 * The source is the terminal omp the reader already configured: its agent directory (`~/.omp/agent`
 * by default, `PI_CONFIG_DIR` aware), named by the desktop as `sourceDir`. It is only ever read -
 * every write lands in *this* host's engine (settings, the user `mcp.json`, this agent directory's
 * skills) - because the other installation's files belong to the engine that owns them.
 *
 * **Additive, deduplicated by identity.** Each category has exactly one identity: a model role id,
 * a provider id, an MCP server name, a skill name. An item whose identity this engine already holds
 * is skipped, never merged and never doubled, so a second import - or an import over a partly
 * hand-configured setup - leaves one item per identity.
 *
 * The engine's own readers do the parsing (`Settings.loadReadOnly` for `config.yml`, the engine's
 * `models.yml` ConfigFile for provider definitions, `readMCPConfigFile` for `mcp.json`,
 * `loadSkillsFromDir` for skill frontmatter). This module decides *what to copy*; a file format
 * parsed by hand here would be a second source of truth about files the engine writes.
 *
 * **Secrets.** A provider key (an inline `apiKey`, an `api_key` row in the source `agent.db`) never
 * enters the scan payload and never reaches the frontend: `applyOmpImport` hands it back under
 * `keys` for the desktop's keyring and nowhere else. Nothing here writes a key to a file, logs one,
 * or puts one in an answer a page renders.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import type { BootServices } from './boot.ts'
import { clampText, isWithin, requireBoolean, requireText, takeRows } from './capabilities.ts'
import {
  CAPABILITY_CWD_MAX,
  CAPABILITY_ROWS_MAX,
  CAPABILITY_TEXT_MAX,
  CAPABILITY_WARNINGS_MAX,
} from './constants.ts'
import type { HostPaths } from './env.ts'
import { logLine, sanitizeConfigMessage } from './log.ts'
import { connectWritten } from './mcp.ts'
import { assignableRole, assignableSelector } from './models.ts'
import { invalidInput } from './protocol/errors.ts'
import type { EngineMcpConfig, ModelsConfig, SdkBundle } from './sdk.ts'
import type { SessionRegistry } from './sessions.ts'

/** A provider key the desktop's keyring should store. Never rendered, never logged. */
interface KeyRow {
  readonly provider: string
  readonly key: string
}

/** One provider entry of the engine's `models.yml` schema. */
type ProviderEntry = NonNullable<ModelsConfig['providers']>[string]

/** One model of an imported custom provider, in the desktop provider registry's shape. */
interface ProviderModelRow {
  readonly id: string
  readonly name: string
  readonly contextWindow: number
  readonly maxTokens: number
  readonly supportsImages: boolean
  readonly supportsReasoning: boolean
}

/** One custom provider definition, in the shape the desktop's provider registry stores. */
interface ProviderRow {
  readonly id: string
  readonly name: string
  readonly baseUrl: string
  readonly api: string
  readonly models: readonly ProviderModelRow[]
  /** Whether the source carried a literal key to move; the value itself stays out of a scan. */
  readonly hasKey: boolean
}

/** One model role the source configures. */
interface RoleRow {
  readonly role: string
  readonly selector: string
}

/** One provider credential the source's auth store holds. */
interface CredentialRow {
  readonly provider: string
  /** `api_key` moves into the keyring; `oauth` is a flow this application does not carry over. */
  readonly kind: 'api_key' | 'oauth'
}

/** One MCP server definition, in the engine's own config shape. */
interface ServerRow {
  readonly name: string
  readonly transport: string
  readonly target: string
  readonly config: EngineMcpConfig
}

/** One skill directory the source agent directory carries. */
interface SkillRow {
  readonly name: string
  readonly description: string
  readonly baseDir: string
}

/**
 * One identity an apply skipped, and the closed reason word for it.
 *
 * The identity is always under `name` - a role id, a provider id, a server name, a skill name - so
 * one shape carries every category's skip and the caller never has to know which field to read.
 */
interface SkipRow {
  readonly name: string
  readonly reason: string
}

/** Everything the source directory offers, before this engine's own state is considered. */
interface SourceSnapshot {
  readonly found: boolean
  readonly roles: readonly RoleRow[]
  readonly credentials: readonly CredentialRow[]
  readonly providers: readonly ProviderRow[]
  readonly servers: readonly ServerRow[]
  readonly skills: readonly SkillRow[]
  /** Provider keys the desktop may store, from both the auth store and an inline `apiKey`. */
  readonly keys: ReadonlyMap<string, string>
  readonly warnings: readonly string[]
}

/** This engine's own identities, the ones an import must not duplicate. */
interface Ours {
  readonly roles: ReadonlySet<string>
  readonly servers: ReadonlySet<string>
  readonly skills: ReadonlySet<string>
}

/** The provider keys this application can store and write as plain `models.yml` keys. */
const PROVIDER_ID_MAX = 64

/**
 * Whether a provider key survives the copy unchanged.
 *
 * The engine's schema accepts nearly any string as a provider key, but this application also
 * derives an environment variable name from it and writes it as a plain YAML key, so the copy is
 * limited to characters that are literal in both. A key outside this is reported instead of being
 * rewritten into a provider the source's roles never named.
 */
function portableProviderId(id: string): boolean {
  return id.length > 0 && id.length <= PROVIDER_ID_MAX && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)
}

/** The source directory, validated: absolute, existing, and never this application's own tree. */
function sourceDirectory(paths: HostPaths, frame: Record<string, unknown>): string {
  const raw = requireText(frame.sourceDir, 'sourceDir', CAPABILITY_CWD_MAX)
  if (raw.includes('\n') || raw.includes('\r')) throw invalidInput('sourceDir must be a single path.')
  if (!path.isAbsolute(raw)) throw invalidInput('sourceDir must be an absolute path.')
  const resolved = path.resolve(raw)
  if (isWithin(path.resolve(paths.dataRoot), resolved)) {
    throw invalidInput("sourceDir is this application's own data root; there is nothing to import from it.")
  }
  return resolved
}

/** A file inside the source directory, or `null` when it is not a regular file. */
function sourceFile(sourceDir: string, name: string): string | null {
  const file = path.join(sourceDir, name)
  try {
    return fs.statSync(file).isFile() ? file : null
  } catch {
    return null
  }
}

/** The engine's own settings reader over the source directory, merged the way it reads its own. */
async function readRoles(sdk: SdkBundle, sourceDir: string): Promise<RoleRow[]> {
  // `loadReadOnly` parses `config.yml` without opening storage, migrating a legacy file or writing
  // a marker - the guarantees that make it safe to point at an installation this process does not
  // own. `cwd` is the agent directory itself: it has no `.omp` project layer, so nothing but the
  // other installation's own settings is read.
  const settings = await sdk.Settings.loadReadOnly({ cwd: sourceDir, agentDir: sourceDir })
  const rows: RoleRow[] = []
  for (const [role, selector] of Object.entries(settings.getModelRoles())) {
    if (typeof selector === 'string' && selector.trim() !== '') rows.push({ role, selector: selector.trim() })
  }
  return rows
}

/**
 * Whether a source model declares reasoning support.
 *
 * The engine's schema names it `reasoning`, but `models.yml` files in the wild also carry the
 * older `supportsReasoning` key, which the schema tolerates and ignores - and a model that writes a
 * `thinking` ladder obviously thinks. Missing all three is what made an imported model arrive with
 * `supports_reasoning: false` and lose the thinking control the source installation had.
 */
function declaresReasoning(model: { reasoning?: boolean; thinking?: unknown }): boolean {
  if (model.reasoning === true) return true
  if (model.thinking !== undefined && model.thinking !== null) return true
  return 'supportsReasoning' in model && model.supportsReasoning === true
}

/** One provider entry as this application's registry row, or a warning naming what was skipped. */
function providerRow(id: string, entry: ProviderEntry): ProviderRow | string {
  if (!portableProviderId(id)) {
    return `The custom provider "${id}" has a name this application cannot store; skipped.`
  }
  const baseUrl = entry.baseUrl?.trim() ?? ''
  const api = entry.api ?? ''
  if (baseUrl === '' || api === '') {
    return `The custom provider "${id}" has no endpoint or API dialect; skipped.`
  }
  return {
    id,
    // `models.yml` carries no display name: the provider key is what the engine and the roles use.
    name: id,
    baseUrl,
    api,
    models: (entry.models ?? []).map(model => ({
      id: model.id,
      name: model.name?.trim() || model.id,
      contextWindow: model.contextWindow !== undefined && model.contextWindow > 0 ? model.contextWindow : 0,
      maxTokens: model.maxTokens !== undefined && model.maxTokens > 0 ? model.maxTokens : 0,
      supportsImages: model.input?.includes('image') === true,
      supportsReasoning: declaresReasoning(model),
    })),
    // An inline apiKey is moved into the keyring, never copied into a file: this application keeps
    // its secrets in the OS credential store, not in a plaintext `models.yml`.
    hasKey: typeof entry.apiKey === 'string' && entry.apiKey.trim() !== '',
  }
}

/**
 * The source `models.yml`, through the engine's own ConfigFile and schema.
 *
 * Read, never migrated: the file exists (that is the condition for reading it here), and the
 * engine's JSON→YAML migration short-circuits on an existing YAML file, so pointing the reader at
 * another installation's directory cannot write into it.
 */
function readProviders(
  sourceDir: string,
  sdk: SdkBundle,
): { rows: readonly ProviderRow[]; keys: ReadonlyMap<string, string>; warnings: readonly string[] } {
  const file = sourceFile(sourceDir, 'models.yml')
  if (file === null) return { rows: [], keys: new Map(), warnings: [] }
  const read = sdk.readModelsConfig(file)
  if (read.config === null) {
    return { rows: [], keys: new Map(), warnings: [`models.yml was not accepted by the engine: ${read.error ?? 'unknown error'}`] }
  }
  const rows: ProviderRow[] = []
  const keys = new Map<string, string>()
  const warnings: string[] = []
  for (const [id, entry] of Object.entries(read.config.providers ?? {})) {
    const row = providerRow(id, entry)
    if (typeof row === 'string') {
      warnings.push(row)
      continue
    }
    rows.push(row)
    const key = entry.apiKey?.trim()
    if (key !== undefined && key !== '') keys.set(id, key)
  }
  return { rows, keys, warnings }
}

/**
 * The source credential rows and their API keys.
 *
 * Opened on a **copy**, not on the other installation's file. The engine's store is not a read-only
 * reader: its constructor sets the journal mode, creates its tables and indexes if they are missing,
 * tightens the file's mode, and opens with corruption recovery - all writes to a database this host
 * does not own. Reading through it directly would let a first-launch probe (or one click on the
 * import dialog) modify the terminal omp's credentials. The copy is taken with its WAL and shared
 * memory files so the rows are the committed ones, the store is closed, and the copy is removed
 * before returning.
 */
async function readCredentials(
  sourceDir: string,
  sdk: SdkBundle,
): Promise<{ rows: readonly CredentialRow[]; keys: ReadonlyMap<string, string>; warnings: readonly string[] }> {
  const database = sourceFile(sourceDir, 'agent.db')
  if (database === null) return { rows: [], keys: new Map(), warnings: [] }
  const scratch = copyForReading(database)
  if (scratch === null) return { rows: [], keys: new Map(), warnings: ['agent.db could not be copied for reading'] }
  let auth
  try {
    auth = await sdk.AuthStorage.create(scratch)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    fs.rmSync(path.dirname(scratch), { recursive: true, force: true })
    return { rows: [], keys: new Map(), warnings: [`agent.db could not be read: ${sanitizeConfigMessage(reason)}`] }
  }
  try {
    const rows: CredentialRow[] = []
    const keys = new Map<string, string>()
    for (const stored of auth.credentials.list()) {
      const credential = stored.credential
      const kind = credential.type === 'api_key' ? 'api_key' : 'oauth'
      if (!rows.some(row => row.provider === stored.provider && row.kind === kind)) {
        rows.push({ provider: stored.provider, kind })
      }
      // The desktop keyring holds one key per provider, so the first stored key is the one that
      // can be carried over; the rest stay in the other installation's store.
      if (credential.type === 'api_key' && !keys.has(stored.provider) && credential.key.trim() !== '') {
        keys.set(stored.provider, credential.key)
      }
    }
    return { rows, keys, warnings: [] }
  } finally {
    auth.close()
    fs.rmSync(path.dirname(scratch), { recursive: true, force: true })
  }
}

/**
 * A throwaway copy of one SQLite database, WAL files and all, in this process's own temp directory.
 *
 * `-wal` and `-shm` are copied because a WAL database's committed rows may still live in the sidecar;
 * copying only the main file would read a stale snapshot. The caller removes the directory. Returns
 * `null` when the main file cannot be copied, which the caller reports rather than retrying on the
 * original.
 */
function copyForReading(database: string): string | null {
  let directory: string
  try {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-import-'))
  } catch {
    return null
  }
  const target = path.join(directory, 'agent.db')
  try {
    fs.copyFileSync(database, target)
  } catch {
    fs.rmSync(directory, { recursive: true, force: true })
    return null
  }
  for (const suffix of ['-wal', '-shm']) {
    try {
      fs.copyFileSync(`${database}${suffix}`, `${target}${suffix}`)
    } catch {
      // A database with no live WAL has neither file; the copy is still the committed snapshot.
    }
  }
  return target
}

/** How a definition connects, and what it connects to, in the engine's own normalization. */
function describeServer(config: EngineMcpConfig): { transport: string; target: string } {
  if (config.type === 'http' || config.type === 'sse') {
    return { transport: config.type, target: clampText(config.url, CAPABILITY_TEXT_MAX).text ?? '' }
  }
  const joined = [config.command, ...(config.args ?? [])].join(' ').trim()
  return { transport: 'stdio', target: clampText(joined, CAPABILITY_TEXT_MAX).text ?? '' }
}

/** The source `mcp.json`'s servers, through the engine's own reader. */
async function readServers(
  sourceDir: string,
  sdk: SdkBundle,
): Promise<{ rows: readonly ServerRow[]; warnings: readonly string[] }> {
  const file = sourceFile(sourceDir, 'mcp.json')
  if (file === null) return { rows: [], warnings: [] }
  try {
    const config = await sdk.readMCPConfigFile(file)
    const rows = Object.entries(config.mcpServers ?? {}).map(([name, definition]) => ({
      name,
      ...describeServer(definition),
      config: definition,
    }))
    return { rows, warnings: [] }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { rows: [], warnings: [`mcp.json could not be read: ${sanitizeConfigMessage(reason)}`] }
  }
}

/** The source agent directory's own skills, through the engine's own frontmatter reader. */
async function readSkills(
  sourceDir: string,
  sdk: SdkBundle,
): Promise<{ rows: readonly SkillRow[]; warnings: readonly string[] }> {
  const directory = path.join(sourceDir, 'skills')
  let isDirectory = false
  try {
    isDirectory = fs.statSync(directory).isDirectory()
  } catch {
    isDirectory = false
  }
  if (!isDirectory) return { rows: [], warnings: [] }
  const result = await sdk.loadSkillsFromDir({ dir: directory, source: 'native:user' })
  return {
    rows: result.skills.map(skill => ({
      name: skill.name,
      description: clampText(skill.description, CAPABILITY_TEXT_MAX).text ?? '',
      baseDir: skill.baseDir,
    })),
    warnings: result.warnings.map(warning => clampText(warning.message, CAPABILITY_TEXT_MAX).text ?? ''),
  }
}

/** The categories a read covers: an apply reads only what it was asked to copy. */
interface Categories {
  readonly models: boolean
  readonly mcp: boolean
  readonly skills: boolean
}

/**
 * Everything the selected categories of the source directory offer, read once per command.
 *
 * A category nobody selected is not read: opening the other installation's credential database is
 * the least desirable read this feature performs, so an import of MCP servers and skills alone
 * leaves `agent.db` untouched.
 */
async function readSource(
  sourceDir: string,
  sdk: SdkBundle,
  categories: Categories = { models: true, mcp: true, skills: true },
): Promise<SourceSnapshot> {
  let isDirectory = false
  try {
    isDirectory = fs.statSync(sourceDir).isDirectory()
  } catch {
    isDirectory = false
  }
  if (!isDirectory) {
    return {
      found: false,
      roles: [],
      credentials: [],
      providers: [],
      servers: [],
      skills: [],
      keys: new Map(),
      warnings: [],
    }
  }
  const providers = categories.models ? readProviders(sourceDir, sdk) : { rows: [], keys: new Map(), warnings: [] }
  const credentials = categories.models ? await readCredentials(sourceDir, sdk) : { rows: [], keys: new Map(), warnings: [] }
  const servers = categories.mcp ? await readServers(sourceDir, sdk) : { rows: [], warnings: [] }
  const skills = categories.skills ? await readSkills(sourceDir, sdk) : { rows: [], warnings: [] }
  // A key from the auth store and one written inline describe the same provider: the stored row
  // wins, because it is the credential the other installation actually resolves.
  const keys = new Map(credentials.keys)
  for (const [provider, key] of providers.keys) {
    if (!keys.has(provider)) keys.set(provider, key)
  }
  return {
    found: true,
    roles: categories.models ? await readRoles(sdk, sourceDir) : [],
    credentials: credentials.rows,
    providers: providers.rows,
    servers: servers.rows,
    skills: skills.rows,
    keys,
    warnings: [
      ...providers.warnings,
      ...credentials.warnings,
      ...servers.warnings,
      ...skills.warnings,
    ],
  }
}

/**
 * What this engine already holds, by each category's identity.
 *
 * Servers and skills come from the engine's *discovery*, not from a directory listing: a skill a
 * plugin already provides, and a server a project file already defines, are exactly the duplicates
 * an import must not create.
 */
async function readOurs(paths: HostPaths, services: BootServices, sdk: SdkBundle): Promise<Ours> {
  sdk.resetCapabilities()
  const cwd = paths.defaultWorkspace
  const [servers, skills] = await Promise.all([
    sdk.mcpServers(cwd),
    sdk.discoverSkills(cwd, paths.agentDir, {
      enabled: true,
      includeSkills: [],
      ignoredSkills: [],
      disabledExtensions: [],
      customDirectories: [],
      enableCodexUser: true,
      enableClaudeUser: true,
      enableClaudeProject: true,
      enablePiUser: true,
      enablePiProject: true,
      enableAgentsUser: true,
      enableAgentsProject: true,
    }),
  ])
  const roles = new Set<string>()
  for (const role of sdk.getKnownRoleIds(services.settings)) {
    const value = services.settings.getModelRole(role)
    if (value !== undefined && value !== '') roles.add(role)
  }
  return {
    roles,
    servers: new Set(servers.items.map(server => server.name)),
    skills: new Set(skills.skills.map(skill => skill.name)),
  }
}

/** `omp_import_scan`: what the source offers, and which of it this engine already holds. */
export async function scanOmpImport(
  paths: HostPaths,
  services: BootServices,
  sdk: SdkBundle,
  frame: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const sourceDir = sourceDirectory(paths, frame)
  const source = await readSource(sourceDir, sdk)
  const ours = await readOurs(paths, services, sdk)

  const roles = source.roles.map(row => ({
    role: row.role,
    selector: row.selector,
    status: ours.roles.has(row.role)
      ? 'configured'
      : !assignableRole(services, sdk, row.role)
        ? 'unsupported'
        : assignableSelector(services, sdk, row.role, row.selector)
          ? 'importable'
          : 'unresolved',
  }))

  const credentials = source.credentials.map(row => ({
    provider: row.provider,
    kind: row.kind,
    // OAuth is a flow, not a keyring entry: only an API key can move into this application's store.
    status: row.kind === 'api_key' ? 'importable' : 'unsupported',
  }))

  // The definitions travel whole: the desktop's own provider registry stores them, and this host
  // deliberately does not write that store.
  const providers = source.providers.map(row => ({
    id: row.id,
    name: row.name,
    baseUrl: row.baseUrl,
    api: row.api,
    models: row.models,
    hasKey: row.hasKey,
  }))

  const servers = source.servers.map(row => ({
    name: row.name,
    transport: row.transport,
    target: row.target,
    status: ours.servers.has(row.name) ? 'configured' : 'importable',
  }))

  const skills = source.skills.map(row => ({
    name: row.name,
    description: row.description,
    status: ours.skills.has(row.name) ? 'configured' : 'importable',
  }))

  const cappedRoles = takeRows(roles, CAPABILITY_ROWS_MAX)
  const cappedCredentials = takeRows(credentials, CAPABILITY_ROWS_MAX)
  const cappedProviders = takeRows(providers, CAPABILITY_ROWS_MAX)
  const cappedServers = takeRows(servers, CAPABILITY_ROWS_MAX)
  const cappedSkills = takeRows(skills, CAPABILITY_ROWS_MAX)
  const cappedWarnings = takeRows(source.warnings, CAPABILITY_WARNINGS_MAX)

  return {
    source: sourceDir,
    found: source.found,
    models: {
      roles: cappedRoles.rows,
      credentials: cappedCredentials.rows,
      providers: cappedProviders.rows,
    },
    mcp: { servers: cappedServers.rows },
    skills: { skills: cappedSkills.rows },
    warnings: cappedWarnings.rows,
    truncated:
      cappedRoles.truncated ||
      cappedCredentials.truncated ||
      cappedProviders.truncated ||
      cappedServers.truncated ||
      cappedSkills.truncated ||
      cappedWarnings.truncated,
  }
}

/**
 * `omp_import_apply`: copies the selected categories, skipping every identity this engine already
 * holds, and answers what landed.
 *
 * `catalogueChanged` is the desktop's statement that it has just written `models.yml` (the custom
 * providers whose registry belongs to the desktop, not to this process): the catalogue is reloaded
 * before any role is resolved, so a role naming a just-imported provider is not reported as
 * unresolved.
 */
export async function applyOmpImport(
  paths: HostPaths,
  services: BootServices,
  sdk: SdkBundle,
  sessions: SessionRegistry,
  frame: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const sourceDir = sourceDirectory(paths, frame)
  const cwd = paths.defaultWorkspace
  const models = requireBoolean(frame.models, 'models')
  const mcp = requireBoolean(frame.mcp, 'mcp')
  const skills = requireBoolean(frame.skills, 'skills')
  const catalogueChanged = frame.catalogueChanged === true

  if (catalogueChanged) await services.registry.refresh('offline')

  const source = await readSource(sourceDir, sdk, { models, mcp, skills })
  const ours = await readOurs(paths, services, sdk)
  const warnings: string[] = [...source.warnings]

  const rolesImported: string[] = []
  const rolesSkipped: SkipRow[] = []
  const credentialsImported: string[] = []
  const credentialsSkipped: SkipRow[] = []
  const serversImported: string[] = []
  const serversSkipped: SkipRow[] = []
  const skillsImported: string[] = []
  const skillsSkipped: SkipRow[] = []
  const keys: KeyRow[] = []

  if (models) {
    for (const row of source.credentials) {
      if (row.kind !== 'api_key') {
        credentialsSkipped.push({ name: row.provider, reason: 'oauth-not-migrated' })
        continue
      }
      const key = source.keys.get(row.provider)
      if (key === undefined) {
        credentialsSkipped.push({ name: row.provider, reason: 'no-key' })
        continue
      }
      // The desktop skips a provider whose keyring already holds a key; this side only carries the
      // value it cannot read.
      keys.push({ provider: row.provider, key })
      credentialsImported.push(row.provider)
    }
    for (const provider of source.providers) {
      const key = source.keys.get(provider.id)
      if (key !== undefined) keys.push({ provider: provider.id, key })
    }
    for (const row of source.roles) {
      if (ours.roles.has(row.role)) {
        rolesSkipped.push({ name: row.role, reason: 'configured' })
        continue
      }
      if (!assignableRole(services, sdk, row.role)) {
        rolesSkipped.push({ name: row.role, reason: 'unsupported' })
        continue
      }
      if (!assignableSelector(services, sdk, row.role, row.selector)) {
        rolesSkipped.push({ name: row.role, reason: 'unresolved' })
        continue
      }
      services.settings.setModelRole(row.role, row.selector)
      rolesImported.push(row.role)
    }
    if (rolesImported.length > 0) await services.settings.flush()
  }

  if (mcp) {
    const userPath = path.join(paths.agentDir, 'mcp.json')
    for (const row of source.servers) {
      if (ours.servers.has(row.name)) {
        serversSkipped.push({ name: row.name, reason: 'configured' })
        continue
      }
      try {
        await sdk.updateMCPServer(userPath, row.name, row.config)
        serversImported.push(row.name)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        warnings.push(`The MCP server "${row.name}" was not imported: ${sanitizeConfigMessage(reason)}`)
      }
    }
    // A stored definition does not connect by itself: the engine's manager was built when a
    // conversation started and keeps its own server list, so without this the imported server is
    // only there after a restart. Same path the definition editor's save takes (`mcp.ts`).
    await connectWritten(sdk, sessions, cwd, 'user', serversImported)
  }

  if (skills) {
    const skillsRoot = path.join(sourceDir, 'skills')
    for (const row of source.skills) {
      if (ours.skills.has(row.name)) {
        skillsSkipped.push({ name: row.name, reason: 'configured' })
        continue
      }
      const failure = copySkill(paths.agentDir, skillsRoot, row)
      if (failure === null) skillsImported.push(row.name)
      else skillsSkipped.push({ name: row.name, reason: failure })
    }
  }

  if (models || mcp || skills) {
    // The reads above went through the engine's capability cache; the next surface that lists
    // skills or servers has to see what this command just wrote (ruling C22).
    sdk.resetCapabilities()
    logLine(
      `omp import: ${String(rolesImported.length)} role(s), ${String(serversImported.length)} mcp server(s), ${String(skillsImported.length)} skill(s), ${String(keys.length)} key(s)`,
    )
  }

  const cappedWarnings = takeRows(warnings, CAPABILITY_WARNINGS_MAX)
  return {
    source: sourceDir,
    found: source.found,
    models: {
      rolesImported,
      rolesSkipped,
      credentialsImported,
      credentialsSkipped,
    },
    mcp: { imported: serversImported, skipped: serversSkipped },
    skills: { imported: skillsImported, skipped: skillsSkipped },
    // The desktop stores these and drops them. No surface renders this field.
    keys,
    warnings: cappedWarnings.rows,
    truncated: cappedWarnings.truncated,
  }
}

/**
 * One skill directory into `<agentDir>/skills/<name>`, or the reason it was not copied.
 *
 * The name becomes a directory under this agent directory, so it has to be a plain file name, and
 * the source directory has to be inside the source's own `skills/`: only regular files and
 * directories are copied, because a link in the source could otherwise pull a file from anywhere on
 * the machine. The destination is created exclusively - a directory that appeared since the scan is
 * a skip, never an overwrite.
 */
function copySkill(agentDir: string, skillsRoot: string, row: SkillRow): string | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(row.name)) {
    logLine(`a skill whose name is not a plain directory name was skipped: ${row.name}`)
    return 'invalid-name'
  }
  const destination = path.join(agentDir, 'skills', row.name)
  if (fs.existsSync(destination)) return 'configured'
  if (!isWithin(path.resolve(skillsRoot), path.resolve(row.baseDir))) {
    logLine(`a skill outside the source's own skills directory was skipped: ${row.name}`)
    return 'outside-source'
  }
  try {
    fs.mkdirSync(destination, { recursive: true })
    copyTree(row.baseDir, destination)
    return null
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    fs.rmSync(destination, { recursive: true, force: true })
    logLine(`a skill could not be copied: ${row.name}: ${reason}`)
    return 'copy-failed'
  }
}

/** Copies regular files and directories; anything else (a link, a socket) is left behind. */
function copyTree(from: string, to: string): void {
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name)
    const destination = path.join(to, entry.name)
    if (entry.isDirectory()) {
      fs.mkdirSync(destination)
      copyTree(source, destination)
    } else if (entry.isFile()) {
      fs.copyFileSync(source, destination)
    }
  }
}
