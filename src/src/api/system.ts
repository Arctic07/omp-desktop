import { call } from '@/api/client'
import { COMMANDS } from '@/api/types'

/**
 * Hands one absolute `http(s)` address to the machine's own browser.
 *
 * The address is the caller's whole request: the desktop validates the scheme and opens it with the
 * platform's default handler. A refusal arrives as an `ApiError`; there is no other answer.
 */
export function openExternal(url: string): Promise<void> {
  return call(COMMANDS.openExternal, { url })
}
