import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const command = process.platform === 'win32' ? process.env.ComSpec ?? 'cmd.exe' : 'tauri'
const args = process.platform === 'win32'
  ? ['/d', '/s', '/c', 'tauri.cmd', 'build', ...process.argv.slice(2)]
  : ['build', ...process.argv.slice(2)]

const child = spawn(command, args, {
  cwd: root,
  stdio: 'inherit',
  shell: false,
})

child.on('error', error => {
  console.error(`[tauri-build] failed to start Tauri CLI: ${error.message}`)
  process.exitCode = 1
})

child.on('exit', (code, signal) => {
  if (signal !== null) {
    process.kill(process.pid, signal)
    return
  }
  if (code !== 0) {
    process.exitCode = code ?? 1
    return
  }

  const cleaner = spawn(process.execPath, ['scripts/clean-build-cache.mjs'], {
    cwd: root,
    stdio: 'inherit',
    shell: false,
  })
  cleaner.on('error', error => {
    console.warn(`[tauri-build] cache cleanup could not start: ${error.message}`)
  })
})
