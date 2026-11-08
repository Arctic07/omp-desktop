/**
 * The smoke harness: the pass/fail ledger and the handshake every scenario starts from.
 *
 * Kept out of the driver so scenario bodies can report assertions without importing the driver
 * (and, with it, the scenario table) back.
 */

import { readFileSync } from 'node:fs'

import { PROTOCOL_VERSION } from '../src/constants.ts'
import type { HostProcess } from './client.ts'
import type { MockProvider } from './mock-provider.ts'

/**
 * The SDK the artifact must have been built against: the pin `host/package.json` declares.
 *
 * The greeting's `sdkVersion` comes from the manifest, which `build.ts` reads off the *installed*
 * package at build time — so a host rebuilt before an upgrade keeps reporting the old engine while
 * the pin, `rules.md` and every other check already name the new one. Comparing the greeting against
 * the pin is what turns that stale artifact into a failure instead of a passing handshake.
 */
function pinnedSdk(): string {
  const manifest: unknown = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const dependencies =
    manifest !== null && typeof manifest === 'object' && 'dependencies' in manifest ? manifest.dependencies : null
  const pin = dependencies !== null && typeof dependencies === 'object' && '@oh-my-pi/pi-coding-agent' in dependencies ? dependencies['@oh-my-pi/pi-coding-agent'] : undefined
  if (typeof pin !== 'string') throw new Error('host/package.json pins no @oh-my-pi/pi-coding-agent')
  return pin
}

const PINNED_SDK = pinnedSdk()

/**
 * One scenario body: it drives the host through `client.ts` and answers the numbers its evidence
 * file should carry. Every body reports through the ledger instead of throwing, so one refused
 * command does not hide the assertions after it.
 */
export type Scenario = (
  host: HostProcess,
  report: Report,
  /**
   * The deterministic provider, when this scenario was listed in `MOCK_SCENARIOS`.
   *
   * A scenario that has to prove what the host sent *next* reads the provider's own record of the
   * requests it answered; inferring that from an end state would pass on the bug the scenario
   * exists to catch.
   */
  provider: MockProvider | undefined,
) => Promise<Record<string, unknown>>

/** One assertion outcome, with the evidence an operator needs to re-derive it. */
interface Check {
  readonly name: string
  readonly ok: boolean
  readonly detail: string
}

export class Report {
  readonly checks: Check[] = []

  record(name: string, ok: boolean, detail: string): void {
    this.checks.push({ name, ok, detail })
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`)
  }
}

/** Waits for the greeting and records what it advertises; the handshake's first half. */
export async function helloChecks(host: HostProcess, report: Report): Promise<Record<string, unknown>> {
  const hello = await host.waitFor('hello', frame => frame.type === 'hello', 30_000)
  host.helloMs = Date.now() - host.spawnedAt
  const limits = hello.limits as Record<string, unknown>
  report.record('hello.limits', limits.maxFrameBytes === 1_048_576 && limits.maxReassembledFrameBytes === 67_108_864, JSON.stringify(limits))
  report.record('hello.version', hello.protocol === PROTOCOL_VERSION && hello.sdkVersion === PINNED_SDK, JSON.stringify({ protocol: hello.protocol, sdk: hello.sdkVersion, pinned: PINNED_SDK, bun: hello.bunVersion, target: hello.target }))
  return hello
}

/** Handshake every scenario starts from. */
export async function handshake(host: HostProcess, report: Report): Promise<void> {
  await helloChecks(host, report)
  const okId = host.send({ type: 'hello_ok', protocol: PROTOCOL_VERSION })
  const okResponse = await host.response(okId, 30_000)
  report.record('hello_ok', okResponse.success === true, JSON.stringify(okResponse))
  await host.waitFor('ready', frame => frame.type === 'ready', 60_000)
  host.readyMs = Date.now() - host.spawnedAt
}

