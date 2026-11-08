import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { test } from 'node:test'

import { applyMcpSources, scanMcpSources } from './mcp-sources.ts'
import type { SdkBundle } from './sdk.ts'
import type { SessionRegistry } from './sessions.ts'

/**
 * The four mainstream agents' MCP definitions, read from a real profile.
 *
 * The engine's own discovery cannot see them here (this host pins `HOME` into the application's
 * data root), so this module reads Claude Code's JSON, Codex's TOML, omp's `mcp.json` and the
 * legacy pi layout itself. What the tests pin is that reading, the identity-based dedupe, and that
 * an apply writes only what is missing.
 */

interface Fixture {
  readonly root: string
  readonly home: string
  readonly agent: string
  readonly sdk: SdkBundle
  readonly sessions: SessionRegistry
  readonly writes: string[]
  readonly connects: string[][]
}

function write(file: string, contents: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, contents)
}

function fixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-mcp-sources-'))
  const home = path.join(root, 'home')
  const agent = path.join(root, 'app', 'agent')
  fs.mkdirSync(agent, { recursive: true })

  // Claude Code: both files its provider reads, with one overlap against this app's own file.
  write(
    path.join(home, '.claude.json'),
    JSON.stringify({
      mcpServers: {
        'shared-server': { command: 'npx', args: ['shared'] },
        playwright: { command: 'npx', args: ['-y', '@playwright/mcp'] },
      },
      // Claude Code's default (`local`) scope: a server added with `claude mcp add` lands inside the
      // project entry, not at the top. `playwright` repeats here and must not be listed twice.
      projects: {
        [path.join(path.dirname('/'), 'work', 'app')]: {
          mcpServers: {
            'project-server': { command: 'npx', args: ['-y', 'project-mcp'] },
            playwright: { command: 'npx', args: ['-y', '@playwright/mcp'] },
          },
        },
      },
    }),
  )
  write(
    path.join(home, '.claude', 'mcp.json'),
    JSON.stringify({ mcpServers: { context7: { type: 'http', url: 'https://mcp.context7.com/mcp' } } }),
  )
  // Codex: snake_case TOML tables, one of which resolves a token through its own environment.
  write(
    path.join(home, '.codex', 'config.toml'),
    [
      '[mcp_servers.sequential-thinking]',
      'command = "npx"',
      'args = ["-y", "@modelcontextprotocol/server-sequential-thinking"]',
      'startup_timeout_sec = 20',
      '',
      '[mcp_servers.codex-remote]',
      'url = "https://example.com/mcp"',
      'bearer_token_env_var = "CODEX_TOKEN"',
      '',
    ].join('\n'),
  )
  // omp: the same shape this application writes, under the desktop-discovered agent directory.
  write(
    path.join(agent, 'mcp.json'),
    JSON.stringify({ mcpServers: { rea: { command: 'cmd.exe', args: ['/d', '/c', 'rea', 'mcp'] } } }),
  )
  // pi: the layout before the rename.
  write(
    path.join(home, '.pi', 'agent', 'mcp.json'),
    JSON.stringify({ mcpServers: { filesystem: { command: 'npx', args: ['-y', '@mcp/fs'] } } }),
  )

  const writes: string[] = []
  const connects: string[][] = []
  const sdk = {
    resetCapabilities: () => {},
    mcpServers: async () => ({ items: [{ name: 'rea' }], warnings: [] }),
    // The engine's upsert: the file keeps its servers and gains this one, which is what makes a
    // second pass see the first one's writes.
    updateMCPServer: async (file: string, name: string) => {
      writes.push(name)
      const existing = fs.existsSync(file)
        ? (JSON.parse(fs.readFileSync(file, 'utf8')) as { mcpServers?: Record<string, unknown> })
        : { mcpServers: {} }
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify({ mcpServers: { ...existing.mcpServers, [name]: { command: 'npx' } } }))
    },
    getMCPServer: async () => ({ command: 'npx' }),
    mcpManager: () => undefined,
    readMCPConfigFile: async () => ({ mcpServers: {} }),
  } as unknown as SdkBundle
  const sessions = { mcpManagers: () => [], mcpManager: () => undefined } as unknown as SessionRegistry
  // No live manager: the connect path is covered by `mcp.test.ts`; this fixture records writes.
  void connects
  return { root, home, agent, sdk, sessions, writes, connects }
}

function paths(f: Fixture): { agentDir: string; defaultWorkspace: string } {
  return { agentDir: f.agent, defaultWorkspace: f.root }
}

test('a scan finds all four agents and marks what this application already has', async () => {
  const f = fixture()
  try {
    const scan = await scanMcpSources(paths(f), f.sdk, { homeDir: f.home, ompAgentDir: f.agent })
    const sources = scan.sources as Array<{
      id: string
      present: boolean
      servers: Array<{ name: string; transport: string; status: string; note: string | null }>
    }>
    assert.deepEqual(sources.map(source => source.id), ['claude', 'codex', 'omp', 'pi'])
    assert.deepEqual(sources.map(source => source.present), [true, true, true, true])

    const claude = sources[0]!.servers
    // User scope first, then the project entry, both within the first file and before the second.
    assert.deepEqual(claude.map(server => server.name), [
      'shared-server',
      'playwright',
      'project-server',
      'context7',
    ])
    // `rea` is already defined here (this app's own file), so the same name from omp is not copied.
    assert.deepEqual(claude.map(server => server.status), ['importable', 'importable', 'importable', 'importable'])
    // `context7` is the http one; `project-server` took index 2 (stdio).
    assert.deepEqual(claude.map(server => server.transport), ['stdio', 'stdio', 'stdio', 'http'])

    const codex = sources[1]!.servers
    assert.deepEqual(codex.map(server => server.name), ['sequential-thinking', 'codex-remote'])
    // A token forwarded from Codex's own environment cannot be carried: the row says so.
    assert.deepEqual(codex.map(server => server.note), [null, 'environment-forwarded'])

    const omp = sources[2]!.servers
    assert.deepEqual(omp.map(server => [server.name, server.status]), [['rea', 'configured']])

    assert.deepEqual(sources[3]!.servers.map(server => server.name), ['filesystem'])
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true })
  }
})

test('an apply copies only what is missing, from the sources that were asked for', async () => {
  const f = fixture()
  try {
    const answer = await applyMcpSources(paths(f), f.sdk, f.sessions, {
      homeDir: f.home,
      ompAgentDir: f.agent,
      sources: ['claude', 'omp'],
    })
    // `rea` already exists here, so omp contributes nothing and claude contributes its four.
    assert.deepEqual(answer.imported, ['shared-server', 'playwright', 'project-server', 'context7'])
    assert.deepEqual(f.writes, ['shared-server', 'playwright', 'project-server', 'context7'])
    assert.deepEqual(answer.skipped, [
      { name: 'rea', reason: 'configured' },
    ])
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true })
  }
})

test('a second apply of the same sources copies nothing', async () => {
  const f = fixture()
  try {
    const before = await applyMcpSources(paths(f), f.sdk, f.sessions, {
      homeDir: f.home,
      ompAgentDir: f.agent,
      sources: ['codex'],
    })
    assert.deepEqual(before.imported, ['sequential-thinking', 'codex-remote'])
    const after = await applyMcpSources(paths(f), f.sdk, f.sessions, {
      homeDir: f.home,
      ompAgentDir: f.agent,
      sources: ['codex'],
    })
    assert.deepEqual(after.imported, [])
    assert.deepEqual(after.skipped, [
      { name: 'sequential-thinking', reason: 'configured' },
      { name: 'codex-remote', reason: 'configured' },
    ])
    assert.equal(f.writes.length, 2, 'each server was written once')
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true })
  }
})

test('an agent that is not installed reads as absent, and asking for it says so', async () => {
  const f = fixture()
  try {
    fs.rmSync(path.join(f.home, '.codex'), { recursive: true, force: true })
    const scan = await scanMcpSources(paths(f), f.sdk, { homeDir: f.home, ompAgentDir: f.agent })
    const codex = (scan.sources as Array<{ id: string; present: boolean; servers: unknown[] }>).find(
      source => source.id === 'codex',
    )
    assert.equal(codex?.present, false)
    assert.deepEqual(codex?.servers, [])

    const answer = await applyMcpSources(paths(f), f.sdk, f.sessions, {
      homeDir: f.home,
      ompAgentDir: f.agent,
      sources: ['codex'],
    })
    assert.deepEqual(answer.imported, [])
    assert.deepEqual(answer.skipped, [{ name: 'codex', reason: 'not-found' }])
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true })
  }
})

test('a relative path or an unknown source is refused', async () => {
  const f = fixture()
  try {
    await assert.rejects(
      scanMcpSources(paths(f), f.sdk, { homeDir: 'relative/home', ompAgentDir: f.agent }),
      /homeDir must be an absolute path/,
    )
    await assert.rejects(
      applyMcpSources(paths(f), f.sdk, f.sessions, {
        homeDir: f.home,
        ompAgentDir: f.agent,
        sources: ['gemini'],
      }),
      /Unknown source/,
    )
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true })
  }
})
