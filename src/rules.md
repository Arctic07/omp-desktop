# `src/` rules — design system, component library, file size

Read `src/AGENTS.md` for structure and behavior; this file states the visual constraints that apply to every surface.

## One component library

Before building or reworking UI, state this as the task's first constraint: exactly one component library is the external visual source for this task, mixing design systems is forbidden, and spacing, colours, radii, font sizes and shadows come from the project's existing global Tailwind variables.

Keep the design system the project already has. When an external reference is genuinely needed, take one per task from: Beautiful UI (<https://beautifului.dev>), BeUI (<https://beui.dev>), Rare UI (<https://rareui.com>), Transitions (<https://transitions.dev>), shadcn/ui (<https://ui.shadcn.com>). This project uses **BeUI**; a library the user names wins over the default.

## No cross-library mixing

Adapt the chosen components to the business need, but never mix components, icons, radii, motion, typography, or colour systems across libraries — the page must not read as a patchwork.

## Global token values

No ad-hoc per-page values in a Tailwind project: reuse the global theme variables, and the nearest existing value when no exact one exists. The same principle applies to design tokens elsewhere.

## Licence and fit

Before importing component code or a dependency, check its license, framework version, accessibility, and responsive behavior. Take only the part this task needs; never copy a whole library.

## Real data only

This frontend is not static: it runs as a Tauri desktop application wired to the real engine over IPC (see `src/AGENTS.md`). No mock data, no demo screens, no invented numbers.

## Line limit

A single file or page does not exceed 1000 lines; extract components or functions beyond that.
