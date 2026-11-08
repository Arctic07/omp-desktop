/**
 * Upstream SDK version check: is the engine version pinned in `host/package.json` behind npm's
 * `latest` dist-tag?
 *
 * Why this exists: `rules.md#engine-upgrade-and-distribution` makes an SDK upgrade a deliberate act - the pinned version has
 * to be revisited on purpose, not noticed by accident, and nothing in the app polls upstream on its
 * own. This repo is hosted on Gitee with no CI infrastructure of its own, so the check ships as a
 * script any CI or local scheduler can run on its own clock (hourly in the deployment note).
 *
 * What it does: reads the `@oh-my-pi/pi-coding-agent` version out of `host/package.json` (the local
 * pinned value - `rules.md#version-axes` puts the SDK axis there) and issues one GET against
 * https://registry.npmjs.org/@oh-my-pi/pi-coding-agent/latest. Nothing else: a read-only file read
 * plus that single request, no writes, no state, no cache.
 *
 * Output: exactly one line, `upstream <v> / local <v> (<status>)`, with status `up to date` or
 * `update available`. Failures print the raw values (when they exist) plus the reason; nothing is
 * swallowed, so a broken check cannot look like a green one.
 *
 * Exit codes - a CI job branches on these, so they are part of the contract:
 *   0   local is current (upstream <= local; local being ahead is not an update to install)
 *   10  upstream is newer than the pinned local version
 *   1   everything else: unreadable/unparsable `host/package.json`, missing dependency entry,
 *       network failure, non-2xx response, malformed registry JSON, or versions that cannot be
 *       compared numerically (pre-release tags such as `18.7.0-beta.1`, range specifiers such as
 *       `^18.6.1`). Those print the values as-is and explain - no guessed ordering.
 *
 * Wiring it up (hourly):
 *   - cron:    `0 * * * * cd /path/to/omp-desktop && bun run check:upstream`
 *              (exit 10 is the actionable branch; letting cron mail any non-zero exit also works)
 *   - CI:      a scheduled workflow running `bun run check:upstream`, treating 10 as "open an SDK
 *              upgrade task", 0 as green and 1 as "the check itself is broken".
 *   - Windows: Task Scheduler, hourly trigger, program `bun.exe`, arguments `run check:upstream`,
 *              start-in the repo root.
 *
 * Run it with `bun run check:upstream` from the repo root (equivalently
 * `bun run scripts/check-upstream.mjs`). Node >= 18 works too: the script only uses `fetch`,
 * `node:fs` and `node:url`.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** Exit codes, named because CI branches on them. */
const EXIT_UP_TO_DATE = 0
const EXIT_UPDATE_AVAILABLE = 10
const EXIT_FAILED = 1

/** The engine package whose version is an upgrade axis (`rules.md#version-axes`, the SDK_VERSION row). */
const PACKAGE_NAME = '@oh-my-pi/pi-coding-agent'
const REGISTRY_LATEST_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`

/** The manifest that pins the local SDK version; resolved from this file, not from the cwd. */
const HOST_MANIFEST_PATH = fileURLToPath(new URL('../host/package.json', import.meta.url))

/** An hourly check must not hold a scheduler slot; the request is one small GET. */
const REQUEST_TIMEOUT_MS = 15_000

/**
 * A failure that is the check's own answer (exit 1) rather than a bug in the script. Thrown so the
 * top level can print it and set the exit code without `process.exit`, which can truncate output
 * still queued on a pipe - and a CI job parses that output.
 */
class CheckFailure extends Error {}

/**
 * Parses an `x.y.z` numeric version into its segments, or returns `null` when any segment is not a
 * plain number. `null` is a deliberate "cannot compare": pre-releases and range specifiers have no
 * numeric order we are willing to invent, so the caller reports them instead of guessing.
 *
 * @param {unknown} value
 * @returns {number[] | null}
 */
function parseNumericVersion(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed === '') return null
  const segments = trimmed.split('.')
  // One segment is not a version (`latest`, a tag name); two (`18.6`) is a legitimate shorthand.
  if (segments.length < 2) return null
  const numbers = []
  for (const segment of segments) {
    if (!/^\d+$/.test(segment)) return null
    numbers.push(Number(segment))
  }
  return numbers
}

/**
 * Compares two numeric version segment lists, padding the shorter one with zeros so that `18.6`
 * equals `18.6.0`.
 *
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number} negative when `a < b`, zero when equal, positive when `a > b`
 */
function compareVersions(a, b) {
  const length = Math.max(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    const left = a[index] ?? 0
    const right = b[index] ?? 0
    if (left !== right) return left < right ? -1 : 1
  }
  return 0
}

/** Turns an unknown thrown value into a message; a bare `throw 'x'` must not print as `undefined`. */
function reasonOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Reads the locally pinned engine version from `host/package.json`.
 *
 * @returns {string} the raw version specifier as written in the manifest
 */
function readLocalVersion() {
  let raw
  try {
    raw = readFileSync(HOST_MANIFEST_PATH, 'utf8')
  } catch (error) {
    throw new CheckFailure(`cannot read ${HOST_MANIFEST_PATH}: ${reasonOf(error)}`)
  }
  let manifest
  try {
    manifest = JSON.parse(raw)
  } catch (error) {
    throw new CheckFailure(`${HOST_MANIFEST_PATH} is not valid JSON: ${reasonOf(error)}`)
  }
  // `dependencies` is where the SDK axis is declared today; `devDependencies` is accepted so that
  // moving the entry between the two blocks does not silently turn this check into a no-op.
  const version = manifest?.dependencies?.[PACKAGE_NAME] ?? manifest?.devDependencies?.[PACKAGE_NAME]
  if (typeof version !== 'string' || version.trim() === '') {
    throw new CheckFailure(`no "${PACKAGE_NAME}" version entry in ${HOST_MANIFEST_PATH}`)
  }
  return version.trim()
}

/**
 * Fetches the version behind the registry's `latest` dist-tag.
 *
 * @returns {Promise<string>} the raw version string the registry reports
 */
async function fetchUpstreamVersion() {
  let response
  try {
    response = await fetch(REGISTRY_LATEST_URL, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    throw new CheckFailure(`cannot reach ${REGISTRY_LATEST_URL}: ${reasonOf(error)}`)
  }
  if (!response.ok) {
    throw new CheckFailure(`${REGISTRY_LATEST_URL} answered HTTP ${response.status}`)
  }
  let body
  try {
    body = await response.json()
  } catch (error) {
    throw new CheckFailure(`cannot parse the registry response as JSON: ${reasonOf(error)}`)
  }
  const version = body?.version
  if (typeof version !== 'string' || version.trim() === '') {
    throw new CheckFailure(`${REGISTRY_LATEST_URL} returned no "version" string`)
  }
  return version.trim()
}

try {
  const localRaw = readLocalVersion()
  const upstreamRaw = await fetchUpstreamVersion()

  const local = parseNumericVersion(localRaw)
  const upstream = parseNumericVersion(upstreamRaw)

  if (local === null || upstream === null) {
    const uncomparable = []
    if (local === null) uncomparable.push(`local "${localRaw}"`)
    if (upstream === null) uncomparable.push(`upstream "${upstreamRaw}"`)
    // The values are printed as-is first: whoever reads the CI log needs to see what the two sides
    // actually said before reading why the check refused to order them.
    process.stdout.write(`upstream ${upstreamRaw} / local ${localRaw} (cannot compare)\n`)
    throw new CheckFailure(`${uncomparable.join(' and ')} is not a plain x.y.z numeric version`)
  }

  if (compareVersions(upstream, local) > 0) {
    process.stdout.write(`upstream ${upstreamRaw} / local ${localRaw} (update available)\n`)
    process.exitCode = EXIT_UPDATE_AVAILABLE
  } else {
    process.stdout.write(`upstream ${upstreamRaw} / local ${localRaw} (up to date)\n`)
    process.exitCode = EXIT_UP_TO_DATE
  }
} catch (error) {
  // Only the check's own verdicts are swallowed into exit 1; a genuine bug keeps its stack so it is
  // not mistaken for "the registry is down".
  if (!(error instanceof CheckFailure)) throw error
  process.stderr.write(`check-upstream: ${error.message}\n`)
  process.exitCode = EXIT_FAILED
}
