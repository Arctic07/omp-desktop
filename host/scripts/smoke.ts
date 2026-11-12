/**
 * End-to-end smoke: drives a real host process over the frozen NDJSON protocol.
 *
 * Source mode, built-bundle mode and installed-bundle mode all run this same driver, so a difference
 * between them is a packaging bug rather than a difference in what was tested. Evidence lands in
 * `host/evidence/w2-*.{frames.jsonl,stderr.log}` next to a machine-readable summary.
 *
 * This file is the driver: the fixture data root, the scenario loop and the summary. Scenario
 * bodies live in `./scenarios.ts`, the ledger and handshake in `./harness.ts`, and the host
 * client itself in `./client.ts`.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { HostProcess, dataRoot, evidenceDir, repoRoot } from './client.ts'
import type { HostMode } from './client.ts'
import { Report, handshake } from './harness.ts'
import { OMP_DESKTOP_SMOKE_KEYED_ENV, OMP_DESKTOP_SMOKE_KEYED_MODEL, OMP_DESKTOP_SMOKE_KEYED_PROVIDER, OMP_DESKTOP_SMOKE_MODEL, OMP_DESKTOP_SMOKE_PROVIDER, OMP_DESKTOP_SMOKE_SKILL, OMP_DESKTOP_SMOKE_SKILL_MARKER } from './fixtures.ts'
import { startMockProvider } from './mock-provider.ts'
import { MOCK_SCENARIOS, SELF_HANDSHAKE, scenarios } from './scenarios.ts'

/**
 * Writes the fixture `models.yml` the engine reads from the pinned agent directory.
 *
 * `auth: none` is the schema's keyless mode: the provider needs no credential, and the model is
 * still selectable, which is exactly what the non-model scenarios assert. Its deliberately narrow
 * thinking ladder gives the smoke a model limitation to exercise: `max` is unoffered and must be
 * adapted to the nearest available effort instead of refused. The endpoint is only ever dialled
 * by a scenario that actually asks for a completion, and those are the ones that require a real
 * provider anyway.
 *
 * The second provider exists only for `credentials`: its `apiKey:` names an environment variable
 * no host under test has set, which the engine resolves as the literal name - so it is listed as
 * authenticated while holding no real key. The `credentials` scenario pushes a real key into the
 * running engine and asserts this file is never rewritten to hold one.
 *
 * The endpoint is a dead port by default (`OMP_DESKTOP_SMOKE_BASE_URL` overrides it), so a run that
 * needs no model never dials anything. The `write-guard` scenario starts a deterministic mock
 * provider and points this at it.
 */
function writeModelsFixture(): string {
  const baseUrl = process.env.OMP_DESKTOP_SMOKE_BASE_URL ?? 'http://127.0.0.1:9/v1'
  const agentDir = path.join(dataRoot, 'host', 'agent')
  fs.mkdirSync(agentDir, { recursive: true })
  const file = path.join(agentDir, 'models.yml')
  fs.writeFileSync(
    file,
    `# omp-desktop smoke fixture
providers:
  ${OMP_DESKTOP_SMOKE_PROVIDER}:
    baseUrl: ${baseUrl}
    api: openai-completions
    auth: none
    models:
      - id: ${OMP_DESKTOP_SMOKE_MODEL}
        name: Smoke Model
        input: [text]
        reasoning: true
        thinking:
          mode: effort
          efforts: [low, medium]
        contextWindow: 128000
        maxTokens: 4096
  ${OMP_DESKTOP_SMOKE_KEYED_PROVIDER}:
    baseUrl: ${baseUrl}
    api: openai-completions
    apiKey: ${OMP_DESKTOP_SMOKE_KEYED_ENV}
    models:
      - id: ${OMP_DESKTOP_SMOKE_KEYED_MODEL}
        name: Smoke Keyed Model
        input: [text]
        contextWindow: 128000
        maxTokens: 4096
`,
    'utf8',
  )
  return file
}

const MODES = (process.env.OMP_DESKTOP_SMOKE_MODES ?? 'src').split(',') as HostMode[]
/**
 * Scenarios one run drives.
 *
 * The default is every scenario that needs no model, so a credential-free run is green by
 * construction. The three that do need one - `closed-loop`, `concurrency`, `busy` - are named
 * explicitly (`OMP_DESKTOP_SMOKE_SCENARIOS=closed-loop,concurrency,busy` plus `OMP_DESKTOP_SMOKE_PROVIDER`/`OMP_DESKTOP_SMOKE_MODEL`
 * pointed at a provider that can answer): the fixture this driver writes never answers a prompt,
 * and a default list that cannot go green teaches nothing.
 *
 * `write-guard`, `rewind` and `vibe` are also opt-in, but need no key: they start the deterministic
 * mock provider in `scripts/mock-provider.ts`, point the fixture at it, and drive real engine
 * sessions - through the write guard, through two turns and a rewind, and through a vibe-mode entry,
 * a worker, an in-flight turn and the exit.
 */
const SCENARIOS = (process.env.OMP_DESKTOP_SMOKE_SCENARIOS ?? 'health,errors,roles,credentials,model-metadata,capabilities,plugins,mcp-write,cold,frames,transcript,resync,chunks,history,backpressure,preready,id-stability,encode-failure,redaction,ui,close-idempotent,stop,stop-turn,slash').split(',')

/**
 * Writes the engine `config.yml` the fixture data root runs under.
 *
 * One knob only: `retry.maxRetries: 0`. The fixture model's endpoint never answers, so a turn that
 * dials it fails - and the engine's default retry ladder (10 attempts, exponential backoff) holds
 * that turn, and with it the `prompt_result` a skill invocation is asserted on, far past the
 * scenario's wait. Measured on 18.6.1 the failed skill turn was still retrying after 100 s, where
 * 18.2.8 ended it at once; with retries off the same turn settles inside the wait and the `slash`
 * scenario stays what the list above promises - green without a provider. No scenario asserts retry
 * behaviour, so nothing else is affected.
 */
function writeConfigFixture(): string {
  const agentDir = path.join(dataRoot, 'host', 'agent')
  fs.mkdirSync(agentDir, { recursive: true })
  const file = path.join(agentDir, 'config.yml')
  // `keepRecentTokens` is the tail a compaction must leave behind; the engine's 20,000 default needs
  // a conversation far larger than a scenario can build, and the `upstream-compaction` scenario has
  // to give the engine something it will actually cut.
  fs.writeFileSync(
    file,
    '# omp-desktop smoke fixture\nretry:\n  maxRetries: 0\ncompaction:\n  keepRecentTokens: 400\n',
    'utf8',
  )
  return file
}

/**
 * Seeds the skill the `slash` scenario invokes.
 *
 * A user-scope native skill needs no opt-in: the engine scans `<agentDir>/skills` for it, and the
 * fixture agent directory is pinned in the data root this driver owns.
 */
function writeSkillFixture(): string {
  const dir = path.join(dataRoot, 'host', 'agent', 'skills', OMP_DESKTOP_SMOKE_SKILL)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'SKILL.md')
  fs.writeFileSync(
    file,
    `---
name: ${OMP_DESKTOP_SMOKE_SKILL}
description: Fixture skill the smoke invokes through the composer's command palette
---

# Smoke skill

${OMP_DESKTOP_SMOKE_SKILL_MARKER}: a body only the model reads. Nothing on screen may show it.
`,
    'utf8',
  )
  return file
}

async function main(): Promise<void> {
  fs.mkdirSync(evidenceDir, { recursive: true })
  fs.mkdirSync(path.join(dataRoot, 'host', 'xdg', 'omp'), { recursive: true })
  // The opt-in scenarios need real model turns; every other scenario keeps the dead fixture port.
  const mock = SCENARIOS.some(scenario => MOCK_SCENARIOS.has(scenario)) ? await startMockProvider() : null
  if (mock !== null) {
    process.env.OMP_DESKTOP_SMOKE_BASE_URL = mock.url
    console.log(`[smoke] mock provider ${mock.url}`)
  }
  const modelsFixture = writeModelsFixture()
  const configFixture = writeConfigFixture()
  const skillFixture = writeSkillFixture()
  console.log(`[smoke] skill fixture ${path.relative(repoRoot, skillFixture)}`)
  console.log(`[smoke] model fixture ${path.relative(repoRoot, modelsFixture)} provider=${OMP_DESKTOP_SMOKE_PROVIDER} model=${OMP_DESKTOP_SMOKE_MODEL}`)
  console.log(`[smoke] config fixture ${path.relative(repoRoot, configFixture)} retry.maxRetries=0`)
  const report = new Report()
  const summaries: Record<string, unknown> = {
    modelsFixture: { file: modelsFixture, provider: OMP_DESKTOP_SMOKE_PROVIDER, model: OMP_DESKTOP_SMOKE_MODEL },
    configFixture: { file: configFixture, retryMaxRetries: 0 },
    skillFixture: { file: skillFixture, name: OMP_DESKTOP_SMOKE_SKILL },
  }

  for (const mode of MODES) {
    for (const scenario of SCENARIOS) {
      const tag = `${mode}-${scenario}`
      const started = Date.now()
      const host = new HostProcess(mode, tag)
      try {
        if (SELF_HANDSHAKE[scenario] !== true) await handshake(host, report)
        const detail = await scenarios[scenario](host, report, mock ?? undefined)
        summaries[tag] = { ...detail, ms: Date.now() - started }
      } catch (error) {
        report.record(`${tag}.scenario`, false, error instanceof Error ? error.message : String(error))
        summaries[tag] = { error: error instanceof Error ? error.message : String(error), frames: host.frames.length }
      }
      const files = host.flushEvidence()
      summaries[tag] = {
        ...(summaries[tag] as object),
        startup: { spawnToHelloMs: host.helloMs, spawnToReadyMs: host.readyMs },
        framesFile: path.relative(repoRoot, files.frames),
        stderrFile: path.relative(repoRoot, files.stderr),
      }
    }
  }

  const failed = report.checks.filter(check => !check.ok)
  fs.writeFileSync(
    path.join(evidenceDir, `w2-summary.${MODES.join('-')}.json`),
    `${JSON.stringify({ modes: MODES, scenarios: SCENARIOS, checks: report.checks, summaries }, null, 1)}\n`,
    'utf8',
  )
  console.log(`\n${report.checks.length - failed.length}/${report.checks.length} checks passed`)
  mock?.stop()
  process.exit(failed.length === 0 ? 0 : 1)
}

await main()
