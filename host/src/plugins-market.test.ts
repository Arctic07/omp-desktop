import assert from 'node:assert/strict'
import { test } from 'node:test'

import { pluginSourceField, pluginTargetField } from './plugins-market.ts'
import { HostError } from './protocol/errors.ts'

/**
 * The one boundary both install and marketplace sources cross.
 *
 * The engine's classifier accepts `http://` for a catalog fetch and for a git clone, so a source
 * pasted into the desktop can otherwise put remote content on an unauthenticated wire. The refusal
 * has to be exactly as narrow as the risk: loopback stays open (a local registry, a test catalog),
 * and every source form git authenticates or resolves itself - `https://`, `ssh://`, `git@…`,
 * `owner/repo`, a local path, an npm spec - is unchanged.
 */

/** Whether one source is refused as an unusable input, rather than mapped to another form. */
function refusedAsInput(source: string): boolean {
  try {
    pluginSourceField(source)
    return false
  } catch (error) {
    return error instanceof HostError && error.code === 'invalid_input'
  }
}

test('an https or authenticated source passes through unchanged', () => {
  for (const source of [
    'https://example.test/marketplace.json',
    'https://github.com/owner/repo.git',
    'ssh://git@example.test/owner/repo.git',
    'git@github.com:owner/repo.git',
    'owner/repo',
    './local-marketplace',
    'C:\\plugins\\market',
    'some-package@1.2.3',
  ]) {
    assert.equal(pluginSourceField(source), source)
  }
})

test('a plaintext http source is refused unless its host is this machine', () => {
  for (const source of [
    'http://127.0.0.1:8080/marketplace.json',
    'http://localhost:8080/marketplace.json',
    'http://[::1]:8080/marketplace.json',
  ]) {
    assert.equal(pluginSourceField(source), source)
  }
  for (const source of [
    'http://example.test/marketplace.json',
    'HTTP://EXAMPLE.TEST/repo.git',
    'http://192.168.1.10/marketplace.json',
  ]) {
    assert.equal(refusedAsInput(source), true, source)
  }
})

test('a control character is never part of a source', () => {
  assert.equal(refusedAsInput('https://example.test/market\nplace.json'), true)
  assert.equal(refusedAsInput('   '), true)
})

/**
 * The write commands' target (plan §4.1): a marketplace row passes its install handle, an npm or
 * linked row passes its package name, and the shape decides which - there is no bare-name guess any
 * more, because that guess could act on a plugin the caller never named.
 */
test('targetId is classified by shape: a handle is a marketplace install, a bare name is not', () => {
  const installedIds = ['demo-plugin@market-a', 'demo-plugin@market-b']

  assert.deepEqual(pluginTargetField('demo-plugin@market-a', installedIds), {
    kind: 'marketplace',
    installId: 'demo-plugin@market-a',
  })
  assert.deepEqual(pluginTargetField('demo-plugin', installedIds), { kind: 'npm', name: 'demo-plugin' })
  // A scoped package name is a package, not a handle: the segment before its last `@` is empty.
  assert.deepEqual(pluginTargetField('@scope/pkg', installedIds), { kind: 'npm', name: '@scope/pkg' })
  // Surrounding whitespace is not part of an id.
  assert.deepEqual(pluginTargetField(' demo-plugin@market-a ', installedIds), {
    kind: 'marketplace',
    installId: 'demo-plugin@market-a',
  })
})

test('a marketplace handle the engine does not record is plugin_not_found', () => {
  const installedIds = ['demo-plugin@market-a']
  for (const target of ['demo-plugin@market-b', 'demo-plugin@']) {
    assert.throws(
      () => pluginTargetField(target, installedIds),
      (error: unknown) => error instanceof HostError && error.code === 'plugin_not_found',
      target,
    )
  }
  // A bare name is never resolved to the installed marketplace record it matches, and a handle with
  // a leading `@` has an empty name segment, so it is a package name (the engine's own test).
  assert.deepEqual(pluginTargetField('demo-plugin', installedIds), { kind: 'npm', name: 'demo-plugin' })
  assert.deepEqual(pluginTargetField('@market-a', installedIds), { kind: 'npm', name: '@market-a' })
})

test('a targetId that is not a non-empty string is refused as input', () => {
  for (const target of [undefined, null, '', '   ', 42, { id: 'demo-plugin@market-a' }]) {
    assert.throws(
      () => pluginTargetField(target, ['demo-plugin@market-a']),
      (error: unknown) => error instanceof HostError && error.code === 'invalid_input',
    )
  }
})
