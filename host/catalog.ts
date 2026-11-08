import { BUILTIN_SLASH_COMMANDS_INTERNAL } from '@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry'

for (const command of BUILTIN_SLASH_COMMANDS_INTERNAL) {
  const handle = typeof command.handle === 'function'
  const tui = typeof command.handleTui === 'function'
  console.log(
    [command.name, `handle=${handle}`, `tui=${tui}`, `aliases=${(command.aliases ?? []).join(',')}`].join('\t'),
  )
}
