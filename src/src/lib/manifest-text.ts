/**
 * One manifest string as the wire may carry it.
 *
 * Shared by the plugin list's projections and the marketplace's: both read values a manifest
 * declares, and both draw nothing where the value is absent or not a string.
 */
export function manifestText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}
