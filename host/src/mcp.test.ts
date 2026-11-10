import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { test } from 'node:test'

import type { HostPaths } from './env.ts'
import { listMcp, setMcpEnabled } from './mcp.ts'
import type { SdkBundle } from './sdk.ts'
import type { SessionRegistry } from './sessions.ts'

/**
 * The MCP list's live state, read from the manager that actually holds the connection.
 *
 * A top-level session builds its own manager, and the newest one becomes the process-global
 * instance - so a conversation opened after another one supplies a manager that has connected
 * nothing. Reading status from that one alone reported a connected server as `disconnected` on the
 * next refresh, which is the failure these tests pin: the state is the best any live manager
 * reports, the counts come from the manager that owns the server, and a genuine failure carries the
 * engine's own reason.
 */

interface FakeManager {
  readonly status: 'connected' | 'connecting' | 'disconnected'
  readonly tools?: readonly string[]
  readonly failure?: string
}

/** One manager as the list reads it: a status per server, its tools, and its startup failures. */
function manager(fake: FakeManager, name: string): Record<string, unknown> {
  return {
    getConnectionStatus: (server: string) =>
      server === name
        ? fake.status
        : fake.status === 'connected'
          ? 'connected'
          : 'disconnected',
    getTools: () =>
      (fake.tools ?? []).map(tool => ({ mcpServerName: name, name: tool })),
    getServerPrompts: () => [],
    getServerResources: () => ({ resources: [], templates: [] }),
    waitForStartup: async () => ({
      connected: fake.status === 'connected' ? [name] : [],
      pending: fake.status === 'connecting' ? [name] : [],
      failed:
        fake.status === 'disconnected' && fake.failure !== undefined
          ? [{ name, error: fake.failure }]
          : [],
    }),
  }
}

interface Fixture {
  readonly paths: HostPaths
  readonly sdk: SdkBundle
  readonly sessions: SessionRegistry
  readonly root: string
}

function fixture(managers: readonly Record<string, unknown>[], global: number): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-mcp-list-'))
  const agentDir = path.join(root, 'agent')
  fs.mkdirSync(agentDir, { recursive: true })
  const sdk = {
    resetCapabilities: () => {},
    readDisabledServers: async () => [],
    readEnabledServers: async () => [],
    mcpServers: async () => ({
      items: [
        {
          name: 'rea',
          command: 'cmd.exe',
          args: ['/d', '/c', 'npx', '-y', 'rea-agents@6.8.0', 'mcp'],
          _source: { provider: 'mcp-json', providerName: 'MCP config', path: path.join(agentDir, 'mcp.json'), level: 'user' },
        },
      ],
      warnings: [],
    }),
    mcpManager: () => managers[global],
  } as unknown as SdkBundle
  const sessions = {
    mcpManager: () => managers[0],
    mcpManagers: () => managers,
  } as unknown as SessionRegistry
  const paths = { agentDir, dataRoot: root, defaultWorkspace: root } as unknown as HostPaths
  return { paths, sdk, sessions, root }
}

test('a server connected in one conversation reads connected, whatever manager is newest', async () => {
  // The blank conversation's manager is the process-global one, as a freshly opened session leaves it.
  const blank = manager({ status: 'disconnected' }, 'rea')
  const connected = manager({ status: 'connected', tools: ['t1', 't2'] }, 'rea')
  const f = fixture([blank, connected], 0)
  try {
    const view = await listMcp(f.paths, f.sdk, f.sessions, {})
    const rows = view.servers as Array<Record<string, unknown>>
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.status, 'connected')
    // The counts belong to the manager that owns the connection, never a sum across managers.
    assert.equal(rows[0]?.toolCount, 2)
    assert.equal(rows[0]?.error, null)
    assert.equal(view.live, true)
    assert.deepEqual(view.summary, { total: 1, enabled: 1, connected: 1 })
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true })
  }
})

test('a real failure keeps the engine reason, and connecting beats a stale failure', async () => {
  const failing = manager({ status: 'disconnected', failure: 'spawn cmd.exe ENOENT' }, 'rea')
  const connecting = manager({ status: 'connecting' }, 'rea')
  const f = fixture([failing, connecting], 0)
  try {
    const view = await listMcp(f.paths, f.sdk, f.sessions, {})
    const rows = view.servers as Array<Record<string, unknown>>
    // `connecting` outranks `disconnected`: the handshake is in flight, not failed.
    assert.equal(rows[0]?.status, 'connecting')
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true })
  }

  const only = manager({ status: 'disconnected', failure: 'spawn cmd.exe ENOENT' }, 'rea')
  const f2 = fixture([only], 0)
  try {
    const view = await listMcp(f2.paths, f2.sdk, f2.sessions, {})
    const rows = view.servers as Array<Record<string, unknown>>
    assert.equal(rows[0]?.status, 'disconnected')
    assert.equal(rows[0]?.error, 'spawn cmd.exe ENOENT')
  } finally {
    fs.rmSync(f2.root, { recursive: true, force: true })
  }
})

test('a host with no manager reports unknown instead of inventing a state', async () => {
  const f = fixture([], 0)
  try {
    const view = await listMcp(f.paths, f.sdk, f.sessions, {})
    const rows = view.servers as Array<Record<string, unknown>>
    assert.equal(rows[0]?.status, 'unknown')
    assert.equal(rows[0]?.error, null)
    assert.equal(view.live, false)
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true })
  }
})

test('a plugin MCP switch hands the manager the discovered transport as its config type', async () => {
  const calls: string[] = []
  const connected: Record<string, Record<string, unknown>> = {}
  const base = manager({ status: 'disconnected' }, 'plugin:one')
  const live = {
    ...base,
    connectServers: async (configs: Record<string, unknown>) => {
      for (const [name, config] of Object.entries(configs)) {
        connected[name] = config as Record<string, unknown>
        calls.push(`connect:${name}`)
      }
    },
    disconnectServer: async (name: string) => {
      calls.push(`disconnect:${name}`)
    },
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-mcp-toggle-'))
  const source = {
    provider: 'claude-plugins',
    providerName: 'Claude plugins',
    path: path.join(root, 'plugin', '.mcp.json'),
    level: 'user',
  }
  const sdk = {
    resetCapabilities: () => {},
    readDisabledServers: async () => [],
    readEnabledServers: async () => [],
    mcpServers: async () => ({
      items: [
        {
          name: 'plugin:http',
          url: 'https://mcp.example.test/mcp',
          transport: 'http',
          _source: source,
        },
        {
          name: 'plugin:sse',
          url: 'https://mcp.example.test/sse',
          transport: 'sse',
          _source: source,
        },
        {
          name: 'plugin:stdio',
          command: 'node',
          args: ['server.js'],
          transport: 'stdio',
          _source: source,
        },
      ],
      warnings: [],
    }),
    setMcpServerEnabled: async () => {},
    mcpManager: () => live,
  } as unknown as SdkBundle
  const sessions = {
    mcpManager: () => live,
    mcpManagers: () => [live],
  } as unknown as SessionRegistry
  const paths = {
    agentDir: path.join(root, 'agent'),
    dataRoot: root,
    defaultWorkspace: root,
  } as unknown as HostPaths
  try {
    for (const name of ['plugin:http', 'plugin:sse', 'plugin:stdio']) {
      await setMcpEnabled(paths, sdk, sessions, { name, enabled: true, cwd: root })
    }
    assert.equal(connected['plugin:http']?.type, 'http')
    assert.equal(connected['plugin:sse']?.type, 'sse')
    assert.equal(connected['plugin:stdio']?.type, 'stdio')
    for (const name of ['plugin:http', 'plugin:sse', 'plugin:stdio']) {
      await setMcpEnabled(paths, sdk, sessions, { name, enabled: false, cwd: root })
    }
    assert.deepEqual(calls.filter((call) => call.startsWith('disconnect:')), [
      'disconnect:plugin:http',
      'disconnect:plugin:sse',
      'disconnect:plugin:stdio',
    ])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
