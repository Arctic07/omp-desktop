import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * The `default` arm of a `switch` over a union this repository owns.
 *
 * `rules.md#exhaustiveness-follows-who-owns-the-vocabulary`: a closed vocabulary declared in this
 * codebase makes a new member a compile error at every switch over it, rather than a value that
 * silently draws nothing. The parameter type is what enforces that - passing a non-`never` value is
 * a type error, so adding a member without handling it fails `typecheck` at this line.
 */
export function assertNever(value: never): never {
  throw new Error(`unhandled ${typeof value} member: ${String(value)}`)
}
