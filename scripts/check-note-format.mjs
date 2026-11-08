#!/usr/bin/env node
// Gate: decision-record and postmortem structure (AGENTS.md "Where a fact lives", "Agent notes", "Postmortems").
//
// notes/<lifecycle>/<class>/yyyy-mm-dd-topic.md
//   lifecycle: proposed | implemented | rejected | archived
//   class:     feature | bug-fix | simplification | architecture | process | testing
//   `Status:` agrees with the folder; `## Problem` and `## Alternatives considered` are
//   mandatory; an implemented note states `## Decision` and `## Consequences` and carries
//   no proposal-era headings.
//
// postmortems/NNNN-topic.md (the folder appears with its first entry)
//   `# Postmortem NNNN: …`, `Status:`, then Summary / Impact / Timeline / Root cause /
//   Fix / Rules changed.
//
// Missing directories pass: a tier is created by its first record, never as an empty shell.

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const LIFECYCLES = ['proposed', 'implemented', 'rejected', 'archived']
const CLASSES = ['feature', 'bug-fix', 'simplification', 'architecture', 'process', 'testing']
const FORBIDDEN_WHEN_IMPLEMENTED = ['## Proposal', '## Plan', '## Acceptance criteria']
const POSTMORTEM_SECTIONS = ['## Summary', '## Impact', '## Timeline', '## Root cause', '## Fix', '## Rules changed']

const failures = []
let notes = 0
let postmortems = 0

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (entry.name.endsWith('.md')) out.push(full)
  }
  return out
}

function headings(text) {
  return text.split('\n').filter((line) => /^## /.test(line)).map((line) => line.replace(/\s+$/, ''))
}

function checkNote(file) {
  const relative = path.relative(ROOT, file).split(path.sep).join('/')
  const segments = relative.split('/')
  if (segments.length !== 4) {
    failures.push(`${relative}: expected notes/<lifecycle>/<class>/yyyy-mm-dd-topic.md`)
    return
  }
  const [, lifecycle, klass, name] = segments
  if (!LIFECYCLES.includes(lifecycle)) failures.push(`${relative}: unknown lifecycle folder "${lifecycle}"`)
  if (!CLASSES.includes(klass)) failures.push(`${relative}: unknown class folder "${klass}"`)
  if (!/^\d{4}-\d{2}-\d{2}-[a-z0-9]+(-[a-z0-9]+)*\.md$/.test(name)) {
    failures.push(`${relative}: name must be yyyy-mm-dd-topic-with-dashes.md`)
  }

  const lines = readFileSync(file, 'utf8').split('\n')
  const text = lines.join('\n')
  if (!lines[0].startsWith('# Agent Note: ') || !lines[0].slice('# Agent Note: '.length).trim()) {
    failures.push(`${relative}: line 1 must declare "# Agent Note: <title>"`)
  }
  if ((lines[1] ?? '').trim() !== '') failures.push(`${relative}: line 2 must be blank`)
  const status = (lines[2] ?? '').trim()
  if (!status.startsWith('Status: ')) {
    failures.push(`${relative}: line 3 must be "Status: <status>"`)
  } else {
    const value = status.slice('Status: '.length).trim()
    if (lifecycle === 'rejected') {
      if (!/^rejected\s+[—–-]\s+\S/.test(value)) failures.push(`${relative}: a rejected note's status is "rejected — <why, one line>"`)
    } else if (lifecycle === 'archived') {
      if (value !== 'implemented') failures.push(`${relative}: an archived note keeps "Status: implemented"`)
      if (!/^Archived: \d{4}-\d{2}-\d{2}$/.test((lines[3] ?? '').trim())) {
        failures.push(`${relative}: line 4 of an archived note is "Archived: yyyy-mm-dd"`)
      }
    } else if (value !== lifecycle) {
      failures.push(`${relative}: status "${value}" disagrees with folder "${lifecycle}"`)
    }
  }

  const found = headings(text)
  if (!found.includes('## Problem')) failures.push(`${relative}: missing "## Problem"`)
  if (!found.includes('## Alternatives considered')) {
    failures.push(`${relative}: missing "## Alternatives considered" — record what lost and why`)
  }
  if (lifecycle === 'implemented' || lifecycle === 'archived') {
    if (!found.includes('## Decision')) failures.push(`${relative}: an implemented note needs "## Decision"`)
    if (!found.includes('## Consequences')) failures.push(`${relative}: an implemented note needs "## Consequences"`)
    for (const heading of FORBIDDEN_WHEN_IMPLEMENTED) {
      if (found.includes(heading)) failures.push(`${relative}: proposal-era heading "${heading}" in an implemented note`)
    }
  }
  if (lifecycle === 'proposed' && !found.includes('## Proposal')) {
    failures.push(`${relative}: a proposed note needs "## Proposal"`)
  }
  notes += 1
}

function checkPostmortem(file) {
  const relative = path.relative(ROOT, file).split(path.sep).join('/')
  const name = path.basename(relative)
  const lines = readFileSync(file, 'utf8').split('\n')
  const text = lines.join('\n')
  if (!/^\d{4}-[a-z0-9]+(-[a-z0-9]+)*\.md$/.test(name)) {
    failures.push(`${relative}: name must be NNNN-topic-with-dashes.md`)
  }
  const number = name.slice(0, 4)
  if (!lines[0].startsWith(`# Postmortem ${number}: `)) {
    failures.push(`${relative}: line 1 must declare "# Postmortem ${number}: <title>"`)
  }
  if (!(lines[1] ?? '').trim().startsWith('Status: ')) failures.push(`${relative}: line 2 must be "Status: <resolved|open>"`)
  const found = headings(text)
  for (const section of POSTMORTEM_SECTIONS) {
    if (!found.includes(section)) failures.push(`${relative}: missing "${section}"`)
  }
  postmortems += 1
}

const notesDir = path.join(ROOT, 'notes')
if (existsSync(notesDir)) {
  for (const file of walk(notesDir)) {
    if (path.relative(notesDir, file) === 'README.md') continue
    checkNote(file)
  }
}

const postmortemDir = path.join(ROOT, 'postmortems')
if (existsSync(postmortemDir)) {
  for (const entry of readdirSync(postmortemDir)) {
    const full = path.join(postmortemDir, entry)
    if (entry === 'README.md' || !statSync(full).isFile()) continue
    if (entry.endsWith('.md')) checkPostmortem(full)
  }
}

if (failures.length > 0) {
  console.error(`records: ${failures.length} violation(s)`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(`records: ${notes} note(s) and ${postmortems} postmortem(s) match the format`)
