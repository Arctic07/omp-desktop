#!/usr/bin/env node
// The release body for one tag, derived from that tag's own commit range.
//
// Why this exists: the workflow used to publish a fixed English sentence, which meant every release
// carried the same text no matter what shipped (`rules.md#release-versions-and-publishing` requires
// the body to come from the previous stable tag to this one). This script is that derivation, and it
// runs in two places - the release workflow, and by hand when a release is cut locally - so the two
// cannot disagree about what a release says.
//
// What it does: finds the previous stable tag (`vX.Y.Z`, no prerelease suffix) reachable from the
// target, reads the non-merge commit subjects in `previous..target`, drops the release commits
// themselves, groups what is left by conventional-commit type, and prints the markdown body.
//
// Usage:
//   node scripts/release-notes.mjs --tag v0.2.0        # a tag, or a commit to release as a tag
//   node scripts/release-notes.mjs                     # HEAD
//   node scripts/release-notes.mjs --tag v0.2.0 --out release-notes.md
//
// It reads git only; it never tags, commits, or pushes.

import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

/** The repository this script documents. The compare link is the one the release body points at. */
const REPO = 'https://github.com/Arctic07/omp-desktop'

/** Stable tags only: a prerelease never reaches the feed, so it is never a range end either. */
const STABLE_TAG = /^v\d+\.\d+\.\d+$/

/** Conventional-commit types that a reader of a release body wants, in the order they are shown. */
const GROUPS = [
  { heading: 'Features', types: ['feat'] },
  { heading: 'Fixes', types: ['fix', 'revert'] },
  { heading: 'Performance', types: ['perf'] },
  { heading: 'Other changes', types: ['chore', 'refactor', 'docs', 'test', 'ci', 'build', 'style'] },
]

function git(args, options = {}) {
  return execFileSync('git', args, { encoding: 'utf8', ...options }).trim()
}

/** The tag named on the command line, or `HEAD` when none is. */
function parseArgs(argv) {
  let tag = 'HEAD'
  let out = null
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--tag') {
      tag = argv[index + 1]
      index += 1
    } else if (arg === '--out') {
      out = argv[index + 1]
      index += 1
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  if (tag === undefined || tag === '') throw new Error('--tag needs a value')
  return { tag, out }
}

/**
 * The newest stable tag reachable from `target`, excluding `target` itself.
 *
 * `git describe --abbrev=0` answers the nearest tag on the path; `--match` narrows it to the stable
 * spelling so a local `-rc` tag cannot become the range start. An empty answer means this is the
 * first release.
 */
function previousStableTag(target) {
  try {
    return git(
      ['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*.[0-9]*.[0-9]*', `${target}^`],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    )
  } catch {
    return null
  }
}

/**
 * The commit `tag` names, or `HEAD` when it names nothing yet.
 *
 * A release is cut by bumping the versions, committing, then tagging - so the body is generated for
 * a tag that does not exist for a few minutes. Treating an unresolvable name as `HEAD` is what makes
 * the same script work in both places (locally before the tag, and in CI after it).
 */
function resolveTarget(tag) {
  try {
    return git(['rev-parse', '--verify', `${tag}^{commit}`], { stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    if (tag === 'HEAD') throw new Error('HEAD does not resolve; is this a git checkout?')
    return git(['rev-parse', '--verify', 'HEAD^{commit}'])
  }
}

/** `type(scope): subject` as its parts, or `null` when the subject is not conventional. */
function parseSubject(subject) {
  const match = /^([a-z]+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/.exec(subject)
  if (match === null) return null
  const [, type, scope, breaking, rest] = match
  return { type, scope: scope ?? null, breaking: breaking === '!', subject: rest.trim() }
}

/** One line for one commit: the scope in bold, then the sentence the commit already states. */
function render(commit) {
  const breaking = commit.breaking ? ' **BREAKING**' : ''
  const where = commit.scope === null ? '' : `**${commit.scope}**: `
  return `- ${where}${commit.subject}${breaking}`
}

function main() {
  const { tag, out } = parseArgs(process.argv.slice(2))

  // The tag may not exist yet (a release cut locally), so resolve whatever it names to a commit and
  // compare from there. `git describe` needs the commit, not the name; a name that does not resolve
  // yet is the release being prepared, which is `HEAD`.
  const target = resolveTarget(tag)
  const previous = previousStableTag(target)

  if (previous === null) {
    const body = ['Initial release.', '', 'Windows x64 installer. The application checks this release feed for updates.'].join('\n')
    emit(body, out)
    return
  }

  // Subjects only: a merge commit restates a commit that is already in the range, and the release
  // commit itself describes the act of releasing rather than what shipped.
  const subjects = git(['log', '--no-merges', '--pretty=format:%s', `${previous}..${target}`])
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')
    .map(parseSubject)
    .filter(commit => commit !== null)
    .filter(commit => !(commit.type === 'chore' && /^release v\d+\.\d+\.\d+$/.test(commit.subject)))

  const seen = new Set()
  const sections = GROUPS.map(group => ({
    heading: group.heading,
    lines: subjects
      .filter(commit => group.types.includes(commit.type))
      .filter(commit => {
        // One sentence appears once, even when two commits said the same thing.
        const line = render(commit)
        if (seen.has(line)) return false
        seen.add(line)
        return true
      })
      .map(render),
  })).filter(section => section.lines.length > 0)

  const body =
    sections.length === 0
      ? ['No user-visible changes.', '', `Windows x64 installer. The application checks this release feed for updates.`, '', `**Full changelog**: ${REPO}/compare/${previous}...${tag}`].join('\n')
      : [
          ...sections.flatMap(section => [`### ${section.heading}`, ...section.lines, '']),
          'Windows x64 installer. The application checks this release feed for updates.',
          '',
          `**Full changelog**: ${REPO}/compare/${previous}...${tag}`,
        ].join('\n')

  emit(body, out)
}

function emit(body, out) {
  if (out === null) {
    process.stdout.write(`${body}\n`)
    return
  }
  writeFileSync(out, `${body}\n`, 'utf8')
}

main()
