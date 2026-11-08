/**
 * A bounded semver range evaluator, for the one field that needs it: `omp.desktop.engines.ompDesktop`.
 *
 * The manifest contract says a declared range decides whether the desktop part of a plugin loads
 * (spec §3.2), and this host is the only side that reads a manifest - so the comparison lives here
 * rather than in the application that owns the version. It is deliberately a *subset* of the
 * node-semver grammar rather than a re-implementation of it, and the subset is the one a plugin's
 * author actually writes:
 *
 * - operators `>`, `>=`, `<`, `<=`, `=` (a bare version is `=`), `^` and `~`;
 * - versions of one, two or three numeric fields (`1`, `1.2`, `1.2.3`), optionally prefixed `v`;
 * - `*` alone for "any version";
 * - `||` between unions, whitespace or a comma between the comparators of one intersection.
 *
 * Everything else is *unreadable* rather than guessed at, and an unreadable range refuses the
 * plugin's desktop part exactly as an unsatisfied one does: refusing on the safe side matters more
 * than accepting an exotic range, because the alternative is loading a desktop UI whose author
 * asked for a version this build never claimed to be. Concretely, these are refused: prerelease and
 * build suffixes (`1.0.0-beta`, `1.0.0+build`), `x`-ranges inside a comparator (`1.x`), hyphen
 * ranges (`1.0 - 2.0`), and a *partial* version under an ordering operator (`>1.2`, `<=1`) - node
 * semver gives those their own widened meanings, and reading them as the zero-filled version would
 * be a different range than the author wrote.
 *
 * An unreadable range therefore answers `null`, an unsatisfied one `false`, and only a satisfied
 * one `true` - the three values are what the caller branches on.
 */

/** One version as a comparison reads it: the three numeric fields, missing ones filled with zero. */
interface Semver {
  major: number
  minor: number
  patch: number
}

/** How many fields the text spelled; what makes `1.2` a line of versions rather than one version. */
interface ParsedVersion {
  version: Semver
  fields: number
}

/** Longest number a field may hold; a longer one is a version this host will not compare. */
const FIELD_MAX = 999_999_999

/** One version field, or null when the text is not one. */
function field(text: string): number | null {
  if (!/^\d{1,10}$/.test(text)) return null
  const value = Number(text)
  return value > FIELD_MAX ? null : value
}

/** One version string, or null when it is not one this host compares. */
function parseVersion(text: string): ParsedVersion | null {
  const body = text.startsWith('v') ? text.slice(1) : text
  const parts = body.split('.')
  if (parts.length === 0 || parts.length > 3) return null
  const numbers: number[] = []
  for (const part of parts) {
    const value = field(part)
    if (value === null) return null
    numbers.push(value)
  }
  return {
    version: { major: numbers[0] ?? 0, minor: numbers[1] ?? 0, patch: numbers[2] ?? 0 },
    fields: parts.length,
  }
}

/** Orders two versions: a plain tuple order, because no prerelease is ever compared here. */
function compare(left: Semver, right: Semver): number {
  if (left.major !== right.major) return left.major < right.major ? -1 : 1
  if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1
  if (left.patch !== right.patch) return left.patch < right.patch ? -1 : 1
  return 0
}

/** One comparator of a range, or the wildcard that every version satisfies. */
type Comparator =
  | { readonly kind: 'any' }
  | { readonly kind: 'gt' | 'gte' | 'lt' | 'lte'; readonly version: Semver }
  | { readonly kind: 'line'; readonly version: Semver; readonly fields: number }
  | { readonly kind: 'caret' | 'tilde'; readonly version: Semver; readonly fields: number }

/** The operators a comparator may carry; the regex above admits exactly these and `=` for a bare token. */
type ComparatorOperator = '>' | '>=' | '<' | '<=' | '=' | '^' | '~'

/** The comparator one token spells, or null when the token is not one this host reads. */
function parseComparator(token: string): Comparator | null {
  const match = /^(>=|<=|>|<|=|\^|~)?(.*)$/.exec(token)
  if (match === null) return null
  const operator = (match[1] ?? '=') as ComparatorOperator
  const text = match[2] ?? ''
  if (text === '*' || text === 'x' || text === 'X') {
    // A wildcard is a range of its own; `>=*` is not something anyone writes and stays unreadable.
    // A bare `x`/`X` is kept because it is npm's own spelling of `*`: dropping it would refuse a
    // range node-semver accepts. What this host still does not read is an `x` *inside* a partial
    // version (`1.x`, `1.2.x`) - `parseVersion` rejects the non-numeric field, which is the
    // `x`-range §14.4-1 calls unreadable.
    return operator === '=' ? { kind: 'any' } : null
  }
  const parsed = parseVersion(text)
  if (parsed === null) return null
  switch (operator) {
    case '>':
    case '>=':
    case '<':
    case '<=': {
      // Node semver widens a partial version here (`>1.2` means `>=1.3.0`, `<=1.2` means `<1.3.0`);
      // this host does not read those forms rather than reading them as something else.
      if (parsed.fields !== 3) return null
      if (operator === '>') return { kind: 'gt', version: parsed.version }
      if (operator === '>=') return { kind: 'gte', version: parsed.version }
      if (operator === '<') return { kind: 'lt', version: parsed.version }
      return { kind: 'lte', version: parsed.version }
    }
    case '=':
      return { kind: 'line', version: parsed.version, fields: parsed.fields }
    case '^':
      return { kind: 'caret', version: parsed.version, fields: parsed.fields }
    case '~':
      return { kind: 'tilde', version: parsed.version, fields: parsed.fields }
  }
}

/** Whether one version satisfies one comparator. */
function satisfiesComparator(version: Semver, comparator: Comparator): boolean {
  switch (comparator.kind) {
    case 'any':
      return true
    case 'gt':
      return compare(version, comparator.version) > 0
    case 'gte':
      return compare(version, comparator.version) >= 0
    case 'lt':
      return compare(version, comparator.version) < 0
    case 'lte':
      return compare(version, comparator.version) <= 0
    case 'line':
      // `1.2.3` is that one version; `1.2` is every `1.2.x`; `1` is every `1.x.y` - npm's own rule
      // for a partial version, and the reason a bare `1.2.3` is spelled out as three fields.
      if (comparator.fields === 3) return compare(version, comparator.version) === 0
      if (comparator.fields === 2) {
        return version.major === comparator.version.major && version.minor === comparator.version.minor
      }
      return version.major === comparator.version.major
    case 'caret':
      // `^1.2.3` is `>=1.2.3 <2.0.0`; a leading zero moves the ceiling down a field, so `^0.2.3` is
      // `>=0.2.3 <0.3.0` and `^0.0.3` is `>=0.0.3 <0.0.4`. A partial version keeps npm's meaning
      // for the field it spells: `^1` is `>=1.0.0 <2.0.0` and `^0.2` is `>=0.2.0 <0.3.0`.
      return (
        compare(version, comparator.version) >= 0 &&
        compare(version, caretUpper(comparator.version, comparator.fields)) < 0
      )
    case 'tilde':
      // `~1.2.3` is `>=1.2.3 <1.3.0`; `~1.2` is `>=1.2.0 <1.3.0`; `~1` is `>=1.0.0 <2.0.0`.
      return (
        compare(version, comparator.version) >= 0 &&
        compare(version, tildeUpper(comparator.version, comparator.fields)) < 0
      )
  }
}

/** The upper bound `^x.y.z` implies, for a version that spelled this many fields. */
function caretUpper(version: Semver, fields: number): Semver {
  if (fields === 1) return { major: version.major + 1, minor: 0, patch: 0 }
  // A two-field version spells `major.minor`, so the field npm moves is the minor one whatever its
  // value: `^0.0` is `>=0.0.0 <0.1.0`, not the `<0.0.1` the leading-zero rule below would give.
  if (fields === 2 && version.major === 0) return { major: 0, minor: version.minor + 1, patch: 0 }
  if (version.major > 0) return { major: version.major + 1, minor: 0, patch: 0 }
  if (version.minor > 0) return { major: 0, minor: version.minor + 1, patch: 0 }
  return { major: 0, minor: 0, patch: version.patch + 1 }
}

/** The upper bound `~x.y.z` implies, for a version that spelled this many fields. */
function tildeUpper(version: Semver, fields: number): Semver {
  if (fields === 1) return { major: version.major + 1, minor: 0, patch: 0 }
  return { major: version.major, minor: version.minor + 1, patch: 0 }
}

/**
 * Whether `version` satisfies `range`; `null` when this host cannot read the range.
 *
 * A range is a union (`||`) of intersections (whitespace or commas). A member with no comparator is
 * unreadable rather than "everything" - `>=1 <2 ||` is a typo the author should hear about, not a
 * wider range.
 */
export function satisfiesRange(range: string, version: string): boolean | null {
  const wanted = parseVersion(version)
  if (wanted === null) return null
  const members = range.split('||')
  if (members.length === 0 || members.length > 16) return null
  let matched = false
  for (const member of members) {
    const tokens = member.split(/[\s,]+/).filter(token => token !== '')
    if (tokens.length === 0) return null
    let memberMatched = true
    for (const token of tokens) {
      const comparator = parseComparator(token)
      if (comparator === null) return null
      if (!satisfiesComparator(wanted.version, comparator)) {
        memberMatched = false
        break
      }
    }
    if (memberMatched) matched = true
  }
  return matched
}
