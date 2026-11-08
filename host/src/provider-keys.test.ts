import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { test } from 'node:test'

import { AuthStorage, SqliteAuthCredentialStore } from '@oh-my-pi/pi-ai'

import { deriveCustomEnv, parseProviderKeyPools, ProviderKeyStore } from './provider-keys.ts'

/**
 * The pool seam: keys the desktop keeps in its OS keyring must reach the engine's selector without
 * ever being written to the engine's database.
 *
 * What is pinned here is the contract the engine depends on - one stored row per key, stable row
 * ids across reloads, rotation after a key is dropped, and durable rows untouched by any of it.
 */

async function scratch(): Promise<{ dir: string; inner: SqliteAuthCredentialStore; auth: AuthStorage; store: ProviderKeyStore }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-provider-keys-'))
  const inner = await SqliteAuthCredentialStore.open(path.join(dir, 'agent.db'))
  const store = new ProviderKeyStore(inner, parseProviderKeyPools(JSON.stringify({
    pools: { custom: { env: 'OMP_DESKTOP_CUSTOM_CUSTOM_API_KEY', keys: ['k-one', 'k-two'] } },
    env: { custom: 'OMP_DESKTOP_CUSTOM_CUSTOM_API_KEY' },
  })))
  const auth = new AuthStorage(store)
  await auth.credentials.reload()
  return { dir, inner, auth, store }
}

function dispose(dir: string, auth: AuthStorage): void {
  auth.close()
  fs.rmSync(dir, { recursive: true, force: true })
}

test('a pool is one stored api_key row per key, in order', async () => {
  const { dir, auth } = await scratch()
  try {
    const rows = auth.credentials.list('custom')
    assert.deepEqual(rows.map(row => row.credential), [
      { type: 'api_key', key: 'k-one' },
      { type: 'api_key', key: 'k-two' },
    ])
    assert.equal(await auth.keys.get('custom'), 'k-one')
    assert.deepEqual(auth.credentials.list('custom').map(row => row.id), rows.map(row => row.id))
  } finally {
    dispose(dir, auth)
  }
})

test('dropping one key rotates to its sibling and leaves durable rows alone', async () => {
  const { dir, inner, auth } = await scratch()
  try {
    await inner.replaceAuthCredentials('durable', [{ type: 'api_key', key: 'stored' }])
    await auth.credentials.reload()
    assert.equal(auth.credentials.list('durable').length, 1)

    const first = auth.credentials.list('custom')[0]
    assert.equal(await auth.credentials.removeById('custom', first.id), true)
    await auth.credentials.reload()
    assert.equal(await auth.keys.get('custom'), 'k-two')
    assert.equal(auth.credentials.list('durable')[0].credential.type, 'api_key')
  } finally {
    dispose(dir, auth)
  }
})

test('a suspect key is removed for this process without touching the keyring', async () => {
  const { dir, auth, store } = await scratch()
  try {
    const first = auth.credentials.list('custom')[0]
    await store.markCredentialSuspect(first.id)
    await auth.credentials.reload()
    assert.equal(await auth.keys.get('custom'), 'k-two')
  } finally {
    dispose(dir, auth)
  }
})

test('the engine invalidation path rotates to the next pooled key', async () => {
  const { dir, auth } = await scratch()
  try {
    assert.equal(await auth.keys.get('custom'), 'k-one')
    assert.equal(await auth.limits.invalidateMatching('custom', 'k-one'), true)
    assert.equal(await auth.keys.get('custom'), 'k-two')
  } finally {
    dispose(dir, auth)
  }
})

test('an engine-side replace keeps the pool rows after reload', async () => {
  const { dir, auth } = await scratch()
  try {
    const returned = await auth.credentials.set('custom', { type: 'api_key', key: 'login-key', source: 'login' })
    assert.equal(returned, undefined)
    await auth.credentials.reload()
    assert.equal(auth.credentials.list('custom').length, 3)
  } finally {
    dispose(dir, auth)
  }
})

test('an engine-side write of a pooled key never reaches the durable store', async () => {
  const { dir, inner, auth } = await scratch()
  try {
    await auth.credentials.set('custom', { type: 'api_key', key: 'k-one' })
    assert.equal(inner.listAuthCredentials('custom').length, 0)
    assert.equal(auth.credentials.list('custom').length, 2)
  } finally {
    dispose(dir, auth)
  }
})

test('a malformed spawn payload is refused entry by entry, and reported', () => {
  for (const raw of [
    'not-json',
    '[]',
    JSON.stringify({ pools: { 'bad id': { env: 'X', keys: ['k'] } } }),
    JSON.stringify({ pools: { custom: { env: 'not a name', keys: ['k'] } } }),
    JSON.stringify({ pools: { custom: { env: 'X', keys: [] } } }),
    JSON.stringify({ pools: { custom: { env: 'X', keys: ['  '] } } }),
    JSON.stringify({ env: { custom: 42 } }),
  ]) {
    const parsed = parseProviderKeyPools(raw)
    assert.equal(parsed.pools.length, 0, raw)
    assert.ok(parsed.errors.length >= 1, raw)
  }
})

test('a good entry still lands beside a refused one', () => {
  const parsed = parseProviderKeyPools(
    JSON.stringify({
      pools: {
        good: { env: 'GOOD_KEY', keys: ['k'] },
        bad: { env: 'X', keys: [] },
      },
      env: { good: 'GOOD_KEY', bad: 7 },
    }),
  )
  assert.deepEqual(parsed.pools.map(pool => pool.provider), ['good'])
  assert.equal(parsed.envNames.get('good'), 'GOOD_KEY')
  assert.ok(parsed.errors.some(error => error.includes('bad')))
})

test('duplicate and padded keys normalize to one row', () => {
  const parsed = parseProviderKeyPools(JSON.stringify({
    pools: { custom: { env: 'X_API_KEY', keys: [' one ', 'one', 'two'] } },
    env: { custom: 'X_API_KEY' },
  }))
  assert.deepEqual(parsed.pools[0]?.keys, ['one', 'two'])
})

test('the environment allow-list prefers spawn, then the derived custom name', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-provider-keys-'))
  const inner = await SqliteAuthCredentialStore.open(path.join(dir, 'agent.db'))
  const store = new ProviderKeyStore(inner, parseProviderKeyPools(JSON.stringify({
    pools: {},
    env: { anthropic: 'ANTHROPIC_API_KEY' },
    builtin: ['anthropic', 'openai'],
  })))
  try {
    // A spawn entry wins for the provider it belongs to.
    assert.equal(store.allowedEnv('anthropic'), 'ANTHROPIC_API_KEY')
    // A built-in with no spawn entry gets no variable at all: its real name is the table's, and a
    // derived custom name would export the key nowhere.
    assert.equal(store.allowedEnv('openai'), '')
    assert.equal(store.allowedEnv('my-gateway'), 'OMP_DESKTOP_CUSTOM_MY_GATEWAY_API_KEY')
  } finally {
    inner.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('ids that collapse to one spelling keep distinct variables', () => {
  assert.notEqual(deriveCustomEnv('my.gateway'), deriveCustomEnv('my-gateway'))
  assert.notEqual(deriveCustomEnv('Foo'), deriveCustomEnv('foo'))
  assert.equal(deriveCustomEnv('my-gateway'), 'OMP_DESKTOP_CUSTOM_MY_GATEWAY_API_KEY')
})

test('the last pooled key survives a suspect mark so the provider is not keyless', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-provider-keys-'))
  const inner = await SqliteAuthCredentialStore.open(path.join(dir, 'agent.db'))
  const store = new ProviderKeyStore(inner, parseProviderKeyPools(JSON.stringify({
    pools: { solo: { env: 'SOLO_KEY', keys: ['only'] } },
    env: { solo: 'SOLO_KEY' },
  })))
  const auth = new AuthStorage(store)
  await auth.credentials.reload()
  try {
    const only = auth.credentials.list('solo')[0]
    await store.markCredentialSuspect(only.id)
    await auth.credentials.reload()
    assert.equal(auth.credentials.list('solo').length, 1)
    assert.equal(auth.keys.source('solo')?.kind, 'api_key')
  } finally {
    dispose(dir, auth)
  }
})
