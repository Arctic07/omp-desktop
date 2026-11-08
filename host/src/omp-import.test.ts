import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { test } from 'node:test'

import type { BootServices } from './boot.ts'
import type { HostPaths } from './env.ts'
import { applyOmpImport, scanOmpImport } from './omp-import.ts'
import type { SdkBundle } from './sdk.ts'
import type { SessionRegistry } from './sessions.ts'

/**
 * The local-configuration import's own rules: what is read out of the source directory, and what an
 * apply copies when this engine already has some of it.
 *
 * The engine's parsers are not under test - `Settings`, the `models.yml` ConfigFile, the `mcp.json`
 * reader and the skill frontmatter loader are upstream - so the bundle below stands in for them and
 * reads the same fixture files. What the tests pin is this host's half: which identity makes two
 * items the same, that an overlap is skipped instead of merged or doubled, that a second import is a
 * no-op, and that no provider key ever leaves in a scan.
 */

interface Fixture {
  readonly root: string
  readonly source: string
  readonly agent: string
  readonly paths: HostPaths
  readonly services: BootServices
  readonly sdk: SdkBundle
  /** No conversation holds an MCP manager, so a write connects nothing. */
  readonly sessions: SessionRegistry
  /** Every write the fake engine received, in order. */
  readonly writes: string[]
  /** The keys that reached the answer, which the desktop stores in its keyring. */
  readonly keyring: Map<string, string>
  /** Every path the engine's credential store was asked to open, in order. */
  readonly opened: readonly string[]
}

interface FixtureOptions {
  /** Roles already configured in this engine. */
  readonly configuredRoles?: readonly string[]
  /** Server and skill names this engine already discovers. */
  readonly servers?: readonly string[]
  readonly skills?: readonly string[]
  /** Credentials the source auth store holds: provider → key (`oauth` when the pair says so). */
  readonly credentials?: ReadonlyArray<readonly [string, string | 'oauth']>
  /** Inline `apiKey` values the source `models.yml` carries: provider → key. */
  readonly inlineKeys?: Readonly<Record<string, string>>
  /** Provider keys this source defines, beyond the inline ones. */
  readonly providers?: readonly string[]
  /** Skill directories the source's loader reports, besides the ones on disk. */
  readonly extraSkills?: ReadonlyArray<{ name: string; baseDir: string }>
  /** A live manager, as a running conversation would supply; the fixture records its connects. */
  readonly liveManager?: { readonly connects: string[][] }
}

/** A source agent directory with the files the import reads, plus the fake engine around it. */
function fixture(options: FixtureOptions = {}): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-import-'))
  const source = path.join(root, 'cli', '.omp', 'agent')
  const agent = path.join(root, 'app', 'agent')
  fs.mkdirSync(path.join(source, 'skills', 'shared-skill'), { recursive: true })
  fs.mkdirSync(path.join(source, 'skills', 'new-skill'), { recursive: true })
  fs.writeFileSync(path.join(source, 'skills', 'shared-skill', 'SKILL.md'), '---\nname: shared-skill\ndescription: ours already\n---\n')
  fs.writeFileSync(path.join(source, 'skills', 'new-skill', 'SKILL.md'), '---\nname: new-skill\ndescription: only there\n---\n')
  fs.mkdirSync(agent, { recursive: true })
  fs.mkdirSync(path.join(agent, 'skills', 'shared-skill'), { recursive: true })
  fs.writeFileSync(path.join(agent, 'skills', 'shared-skill', 'SKILL.md'), '---\nname: shared-skill\ndescription: local\n---\n')
  fs.writeFileSync(
    path.join(source, 'config.yml'),
    'modelRoles:\n  default: other/model:max\n  smol: other/model\n  plan: missing/model\n',
  )
  fs.writeFileSync(path.join(source, 'agent.db'), '')
  const providers = options.providers ?? []
  const inlineKeys = options.inlineKeys ?? {}
  const modelsLines = providers
    .map(id => `  ${id}:\n    baseUrl: https://${id}.example.com/v1\n    api: openai-completions\n${inlineKeys[id] === undefined ? '' : `    apiKey: ${inlineKeys[id]}\n`}    models:\n      - id: m-1\n        name: M 1\n        input: [text, image]\n        contextWindow: 1000\n        maxTokens: 100\n        reasoning: true\n`)
    .join('')
  fs.writeFileSync(path.join(source, 'models.yml'), `providers:\n${modelsLines}`)
  fs.writeFileSync(
    path.join(source, 'mcp.json'),
    JSON.stringify({
      mcpServers: {
        'shared-server': { command: 'npx', args: ['shared'] },
        'new-server': { type: 'http', url: 'https://mcp.example.com', headers: { Authorization: 'Bearer token-abcdef' } },
      },
    }),
  )

  const writes: string[] = []
  const opened: string[] = []
  const keyring = new Map<string, string>()
  const manager = {
    connectServers: async (configs: Record<string, unknown>) => {
      options.liveManager?.connects.push(Object.keys(configs))
    },
  }
  const roleValues = new Map<string, string>()
  for (const role of options.configuredRoles ?? []) roleValues.set(role, 'mine/model')
  const knownRoles = ['default', 'smol', 'plan']

  const settings = {
    getModelRole: (role: string) => roleValues.get(role),
    setModelRole: (role: string, value: string | undefined) => {
      if (value === undefined) roleValues.delete(role)
      else roleValues.set(role, value)
    },
    flush: async () => {},
  }
  const credentials = (options.credentials ?? []).map(([provider, key], index) => ({
    id: index + 1,
    provider,
    disabledCause: null,
    credential: key === 'oauth'
      ? { type: 'oauth', access: 'access-token', refresh: 'refresh-token', expires: 1 }
      : { type: 'api_key', key },
  }))
  const sdk = {
    Settings: {
      // The engine's reader: the fixture's own `config.yml`, so the file is the one source of truth
      // for what the source installation configured.
      loadReadOnly: async () => ({
        getModelRoles: () =>
          // `Bun.YAML` is the runtime's parser the engine itself reads YAML with; the ambient Bun
          // types this repository builds against predate it, so the access is named here once.
          (yaml().parse(fs.readFileSync(path.join(source, 'config.yml'), 'utf8')) as {
            modelRoles?: Record<string, string>
          }).modelRoles ?? {},
      }),
    },
    readModelsConfig: (filePath: string) => {
      const parsed = yaml().parse(fs.readFileSync(filePath, 'utf8')) as {
        providers?: Record<string, { baseUrl?: string; api?: string; apiKey?: string; models?: Array<Record<string, unknown>> }>
      }
      return { config: parsed, error: null }
    },
    AuthStorage: {
      create: async (filePath: string) => {
        opened.push(filePath)
        return { credentials: { list: () => credentials }, close: () => {} }
      },
    },
    readMCPConfigFile: async (filePath: string) => JSON.parse(fs.readFileSync(filePath, 'utf8')),
    loadSkillsFromDir: async () => ({
      skills: [
        { name: 'shared-skill', description: 'ours already', baseDir: path.join(source, 'skills', 'shared-skill') },
        { name: 'new-skill', description: 'only there', baseDir: path.join(source, 'skills', 'new-skill') },
        ...(options.extraSkills ?? []).map(skill => ({ description: '', ...skill })),
      ],
      warnings: [],
    }),
    // Discovery reads what is on disk now, which is what makes a second pass see the first one's
    // writes: `mcp.json` under this agent directory, and the skill directories beside it.
    // A live manager only when the case asks for one: without it a write stores its definition and
    // connects nothing, which is a host whose conversations have not started.
    mcpManager: () => options.liveManager === undefined ? undefined : manager,
    getMCPServer: async (filePath: string, name: string) => {
      try {
        const config = JSON.parse(fs.readFileSync(filePath, 'utf8')) as {
          mcpServers?: Record<string, unknown>
        }
        return config.mcpServers?.[name]
      } catch {
        return undefined
      }
    },
    mcpServers: async () => ({
      // Discovery reports what this application's own file now holds, with the source metadata the
      // engine attaches - which is what a live connect needs to find the definition again.
      items: [
        ...(options.servers ?? []).map(name => ({ name })),
        ...writtenServers(fs, agent).map(name => ({
          name,
          enabled: true,
          _source: {
            provider: 'mcp-json',
            providerName: 'MCP config',
            path: path.join(agent, 'mcp.json'),
            level: 'user',
          },
        })),
      ],
      warnings: [],
    }),
    discoverSkills: async () => ({
      skills: [
        ...(options.skills ?? []),
        ...agentSkills(fs, path.join(agent, 'skills')),
      ].map(name => ({ name })),
      warnings: [],
    }),
    getKnownRoleIds: () => knownRoles,
    roleCandidatePool: () => [],
    resolveModelRoleValue: (selector: string) => ({
      model: selector.startsWith('other/') || selector.startsWith('missing') === false
        ? { provider: 'other', id: 'model', name: 'model' }
        : undefined,
      explicitThinkingLevel: false,
    }),
    // The engine's upsert: an existing file keeps its servers and gains this one.
    updateMCPServer: async (filePath: string, name: string) => {
      writes.push(`mcp:${name}`)
      const existing = fs.existsSync(filePath)
        ? (JSON.parse(fs.readFileSync(filePath, 'utf8')) as { mcpServers?: Record<string, unknown> })
        : { mcpServers: {} }
      fs.writeFileSync(filePath, JSON.stringify({ mcpServers: { ...existing.mcpServers, [name]: {} } }))
    },
    resetCapabilities: () => {},
  } as unknown as SdkBundle

  const services = {
    settings,
    registry: { refresh: async () => {} },
  } as unknown as BootServices

  const paths = {
    dataRoot: path.join(root, 'app'),
    agentDir: agent,
    defaultWorkspace: root,
  } as unknown as HostPaths

  // The import asks the registry for a live MCP manager; a fixture with none is a host whose
  // conversations have not started, which is what an import before any conversation looks like.
  const sessions = { mcpManager: () => undefined, mcpManagers: () => [] } as unknown as SessionRegistry

  return { root, source, agent, paths, services, sdk, sessions, writes, keyring, opened }
}

/** The runtime's YAML reader, as the ambient Bun types spell it. */
function yaml(): { parse(text: string): unknown } {
  return (Bun as unknown as { YAML: { parse(text: string): unknown } }).YAML
}

/** The server names this application's own `mcp.json` carries, as the engine would discover them. */
function writtenServers(fsModule: typeof fs, agent: string): string[] {
  try {
    const config = JSON.parse(fsModule.readFileSync(path.join(agent, 'mcp.json'), 'utf8')) as {
      mcpServers?: Record<string, unknown>
    }
    return Object.keys(config.mcpServers ?? {})
  } catch {
    return []
  }
}

/** The skill directory names under one `skills/` directory. */
function agentSkills(fsModule: typeof fs, directory: string): string[] {
  try {
    return fsModule
      .readdirSync(directory, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
  } catch {
    return []
  }
}

function cleanup(fixture: Fixture): void {
  fs.rmSync(fixture.root, { recursive: true, force: true })
}

test('a scan reports the source items and which of them this engine already holds', async () => {
  const f = fixture({
    configuredRoles: ['default'],
    servers: ['shared-server'],
    credentials: [['cline-pass', 'sk-source']],
    providers: ['nextcodeGm'],
  })
  try {
    const scan = await scanOmpImport(f.paths, f.services, f.sdk, { sourceDir: f.source })
    assert.equal(scan.found, true)

    const models = scan.models as {
      roles: Array<{ role: string; status: string }>
      credentials: Array<{ provider: string; kind: string; status: string }>
      providers: Array<{ id: string; hasKey: boolean }>
    }
    assert.deepEqual(
      models.roles.map(row => [row.role, row.status]),
      // `default` is configured here, `plan` names a model the catalogue does not carry, `smol`
      // could be imported.
      [['default', 'configured'], ['smol', 'importable'], ['plan', 'unresolved']],
    )
    assert.deepEqual(models.credentials.map(row => [row.provider, row.kind, row.status]), [
      ['cline-pass', 'api_key', 'importable'],
    ])
    assert.deepEqual(models.providers.map(row => [row.id, row.hasKey]), [['nextcodeGm', false]])

    const mcp = scan.mcp as { servers: Array<{ name: string; status: string }> }
    assert.deepEqual(mcp.servers.map(row => [row.name, row.status]), [
      ['shared-server', 'configured'],
      ['new-server', 'importable'],
    ])

    const skills = scan.skills as { skills: Array<{ name: string; status: string }> }
    assert.deepEqual(skills.skills.map(row => [row.name, row.status]), [
      ['shared-skill', 'configured'],
      ['new-skill', 'importable'],
    ])

    // The scan is what the page renders, so nothing a page may not show - an API key, an inline
    // `apiKey`, a server's Authorization header - may appear in it.
    const rendered = JSON.stringify(scan)
    assert.equal(rendered.includes('sk-source'), false)
    assert.equal(rendered.includes('token-abcdef'), false)
  } finally {
    cleanup(f)
  }
})

test('an apply copies what is missing, skips every overlap, and keeps the keys out of the answer', async () => {
  const f = fixture({
    configuredRoles: ['default'],
    servers: ['shared-server'],
    skills: ['shared-skill'],
    credentials: [['cline-pass', 'sk-source'], ['oauth-only', 'oauth']],
    providers: ['nextcodeGm'],
    inlineKeys: { nextcodeGm: 'sk-inline' },
  })
  try {
    const answer = await applyOmpImport(f.paths, f.services, f.sdk, f.sessions, {
      sourceDir: f.source,
      models: true,
      mcp: true,
      skills: true,
      catalogueChanged: false,
    })
    const models = answer.models as {
      rolesImported: string[]
      rolesSkipped: Array<{ role: string; reason: string }>
      credentialsImported: string[]
      credentialsSkipped: Array<{ provider: string; reason: string }>
    }
    assert.deepEqual(models.rolesImported, ['smol'])
    assert.deepEqual(models.rolesSkipped, [
      { name: 'default', reason: 'configured' },
      { name: 'plan', reason: 'unresolved' },
    ])
    assert.deepEqual(models.credentialsImported, ['cline-pass'])
    assert.deepEqual(models.credentialsSkipped, [{ name: 'oauth-only', reason: 'oauth-not-migrated' }])

    // The overlap is skipped, so this engine keeps one row per identity.
    assert.deepEqual(answer.mcp, { imported: ['new-server'], skipped: [{ name: 'shared-server', reason: 'configured' }] })
    assert.deepEqual(answer.skills, {
      imported: ['new-skill'],
      skipped: [{ name: 'shared-skill', reason: 'configured' }],
    })
    assert.deepEqual(f.writes, ['mcp:new-server'])
    assert.equal(
      fs.readFileSync(path.join(f.agent, 'skills', 'shared-skill', 'SKILL.md'), 'utf8').includes('local'),
      true,
      'an existing skill directory is never overwritten',
    )
    assert.equal(
      fs.readFileSync(path.join(f.agent, 'skills', 'new-skill', 'SKILL.md'), 'utf8').includes('only there'),
      true,
    )

    // Both the stored credential and the inline key travel under `keys`, and only there.
    const keys = (answer.keys as Array<{ provider: string; key: string }>).map(row => [row.provider, row.key])
    assert.deepEqual(keys, [
      ['cline-pass', 'sk-source'],
      ['nextcodeGm', 'sk-inline'],
    ])
  } finally {
    cleanup(f)
  }
})

test('a second import is a no-op: nothing is copied twice', async () => {
  const f = fixture({ configuredRoles: ['default'], credentials: [['cline-pass', 'sk-source']], providers: ['nextcodeGm'] })
  try {
    const first = await applyOmpImport(f.paths, f.services, f.sdk, f.sessions, {
      sourceDir: f.source,
      models: true,
      mcp: true,
      skills: true,
      catalogueChanged: false,
    })
    assert.deepEqual((first.models as { rolesImported: string[] }).rolesImported, ['smol'])
    // `default` is already configured here, and `plan` names a model this catalogue does not carry.
    assert.deepEqual((first.models as { rolesSkipped: unknown[] }).rolesSkipped, [
      { name: 'default', reason: 'configured' },
      { name: 'plan', reason: 'unresolved' },
    ])
    assert.equal(f.writes.length, 2, 'both servers were new on the first pass')

    const second = await applyOmpImport(f.paths, f.services, f.sdk, f.sessions, {
      sourceDir: f.source,
      models: true,
      mcp: true,
      skills: true,
      catalogueChanged: false,
    })
    assert.deepEqual((second.models as { rolesImported: string[] }).rolesImported, [])
    assert.deepEqual(second.mcp, {
      imported: [],
      skipped: [
        { name: 'shared-server', reason: 'configured' },
        { name: 'new-server', reason: 'configured' },
      ],
    })
    assert.deepEqual(second.skills, {
      imported: [],
      skipped: [
        { name: 'shared-skill', reason: 'configured' },
        { name: 'new-skill', reason: 'configured' },
      ],
    })
    assert.equal(f.writes.length, 2, 'each server was written once, on the first pass')
  } finally {
    cleanup(f)
  }
})

test('a skill whose name is not a plain directory name is refused, never written outside skills/', async () => {
  const f = fixture({
    extraSkills: [{ name: '../escape', baseDir: path.join(os.tmpdir(), 'escape') }],
  })
  try {
    const answer = await applyOmpImport(f.paths, f.services, f.sdk, f.sessions, {
      sourceDir: f.source,
      models: false,
      mcp: false,
      skills: true,
      catalogueChanged: false,
    })
    assert.deepEqual(answer.skills, {
      imported: ['new-skill'],
      skipped: [
        { name: 'shared-skill', reason: 'configured' },
        { name: '../escape', reason: 'invalid-name' },
      ],
    })
    assert.equal(fs.existsSync(path.join(f.agent, 'skills', '..', 'escape')), false)
  } finally {
    cleanup(f)
  }
})

test('this application\'s own data root is refused as a source', async () => {
  const f = fixture()
  try {
    await assert.rejects(
      applyOmpImport(f.paths, f.services, f.sdk, f.sessions, {
        sourceDir: f.agent,
        models: true,
        mcp: true,
        skills: true,
        catalogueChanged: false,
      }),
      /own data root/,
    )
  } finally {
    cleanup(f)
  }
})

test('an imported server is connected on the live manager, and an overlap is left alone', async () => {
  const manager = { connects: [] as string[][] }
  const f = fixture({ servers: ['shared-server'], liveManager: manager })
  try {
    await applyOmpImport(f.paths, f.services, f.sdk, f.sessions, {
      sourceDir: f.source,
      models: false,
      mcp: true,
      skills: false,
      catalogueChanged: false,
    })
    // The stored definition alone would only be reachable after a restart; the connect is what the
    // reader sees as "it is up now". The server this engine already had is not reconnected.
    assert.deepEqual(manager.connects, [['new-server']])
  } finally {
    cleanup(f)
  }
})

test('a source model that declares thinking keeps its reasoning flag and its ladder', async () => {
  const f = fixture({ providers: ['legacyAlias', 'ladder'] })
  try {
    // The two spellings `models.yml` files in the wild use: the pre-schema alias, and a thinking
    // ladder without a `reasoning` flag of its own.
    fs.writeFileSync(
      path.join(f.source, 'models.yml'),
      [
        'providers:',
        '  legacyAlias:',
        '    baseUrl: https://legacy.example.com/v1',
        '    api: openai-completions',
        '    models:',
        '      - id: m-legacy',
        '        name: Legacy',
        '        supportsReasoning: true',
        '  ladder:',
        '    baseUrl: https://ladder.example.com/v1',
        '    api: openai-responses',
        '    models:',
        '      - id: m-ladder',
        '        name: Ladder',
        '        thinking:',
        '          mode: effort',
        '          efforts: [low, high]',
        '',
      ].join('\n'),
    )
    const scan = await scanOmpImport(f.paths, f.services, f.sdk, { sourceDir: f.source })
    const providers = (scan.models as {
      providers: Array<{ id: string; models: Array<{ supportsReasoning: boolean }> }>
    }).providers
    assert.deepEqual(
      providers.map(provider => [provider.id, provider.models[0]?.supportsReasoning]),
      [
        ['legacyAlias', true],
        ['ladder', true],
      ],
    )
  } finally {
    cleanup(f)
  }
})

test('the source credential store is opened as a copy, and the copy is removed', async () => {
  const f = fixture({ credentials: [['cline-pass', 'sk-source']] })
  const source = path.join(f.source, 'agent.db')
  fs.writeFileSync(source, 'the other installation\'s bytes')
  const before = fs.readFileSync(source)
  try {
    await scanOmpImport(f.paths, f.services, f.sdk, { sourceDir: f.source })
    assert.equal(f.opened.length, 1, 'the store is opened once')
    const opened = f.opened[0] as string
    // The engine's store writes on construction - journal mode, tables, the file's mode - so a read
    // through the source path would modify a database this host does not own.
    assert.notEqual(path.resolve(opened), path.resolve(source), 'the source file itself is never opened')
    assert.equal(fs.existsSync(opened), false, 'the copy is gone once the read is done')
    assert.deepEqual(fs.readFileSync(source), before, 'the source bytes are untouched')
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true })
  }
})
