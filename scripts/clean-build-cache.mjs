import fs from 'node:fs'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dirname, '..')
const targetRoot = path.join(repoRoot, 'src-tauri', 'target')
const dryRun = process.argv.includes('--dry-run')
const profiles = ['debug', 'release']

function byteSize(filePath) {
  let total = 0
  const stat = fs.statSync(filePath)
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(filePath)) total += byteSize(path.join(filePath, entry))
  } else {
    total = stat.size
  }
  return total
}

function removePath(filePath) {
  const bytes = byteSize(filePath)
  if (dryRun) {
    console.log(`[cache] would remove ${path.relative(repoRoot, filePath)} (${formatBytes(bytes)})`)
    return bytes
  }
  try {
    fs.rmSync(filePath, { recursive: true, force: true, maxRetries: 0 })
    return bytes
  } catch (error) {
    console.warn(`[cache] skipped ${path.relative(repoRoot, filePath)}: ${error.message}`)
    return 0
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KiB', 'MiB', 'GiB']
  let value = bytes
  for (const unit of units) {
    value /= 1024
    if (value < 1024 || unit === units.at(-1)) return `${value.toFixed(1)} ${unit}`
  }
  return `${bytes} B`
}

function entries(directory) {
  if (!fs.existsSync(directory)) return []
  return fs.readdirSync(directory, { withFileTypes: true }).map(entry => ({
    path: path.join(directory, entry.name),
    name: entry.name,
    stat: fs.statSync(path.join(directory, entry.name)),
  }))
}

function cleanTempArchives(profile) {
  const deps = path.join(targetRoot, profile, 'deps')
  return entries(deps)
    .filter(entry => entry.name.startsWith('.tmp') && entry.name.endsWith('.temp-archive'))
    .reduce((total, entry) => total + removePath(entry.path), 0)
}

function cleanOldIncremental(profile) {
  const incremental = path.join(targetRoot, profile, 'incremental')
  const groups = new Map()
  for (const entry of entries(incremental)) {
    if (!entry.stat.isDirectory()) continue
    const match = /^(.*)-[a-z0-9]{12,}$/i.exec(entry.name)
    if (!match) continue
    const group = groups.get(match[1]) ?? []
    group.push(entry)
    groups.set(match[1], group)
  }

  let released = 0
  for (const group of groups.values()) {
    group.sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs)
    for (const entry of group.slice(1)) released += removePath(entry.path)
  }
  return released
}

let released = 0
for (const profile of profiles) {
  released += cleanTempArchives(profile)
  released += cleanOldIncremental(profile)
}

console.log(`[cache] ${dryRun ? 'candidates' : 'released'}: ${formatBytes(released)}`)
