# Postmortem 0001: a rebuild step killed the application the session ran in
Status: resolved


## Summary

A rebuild's "close the instances that hold the artifact" step was executed as a
process-name batch kill (`Get-Process omp_desktop,omp-host | Stop-Process -Force`). The process name does not
distinguish the dev instance, the repository release instance and the installed copy — they are all
`omp_desktop.exe` plus `omp-host.exe` — so the kill took the application the agent session was running in, together
with every other instance on the machine.

## Impact

Five conversations on the same host ended as `session_exit: uncaught_exception`. The application wrote no `run ended`,
raised no panic and produced no Windows Error Reporting entry; what the user saw was 运行途中突然崩溃, with no
diagnosis available from the app's own logs. The turn in progress in each of those sessions was lost.

## Timeline

- The agent read `rules.md#artifact-rebuild`, whose step 1 said to close the instances holding the artifact.
- It enumerated processes by name, not by `ExecutablePath`, and stopped them in one pipeline.
- The desktop process that hosted the agent was among them; its host lost its reader and the five sessions were
  written to their terminal state by the engine's own exit path.

## Root cause

The step named the thing to close ("the instances that hold this profile") but gave no criterion for **identity** or
for **relationship**. Process name looks like identity and is not; and nothing said that the instance an agent runs
inside may never be the one it closes. Both facts are cheap to state and were missing, so the cheapest command that
looked right — a batch kill — was the one that ran.

## Fix

`rules.md#artifact-rebuild` step 1 now states identity and relationship separately: identity is `ExecutablePath` (which profile,
which installation), relationship is the parent-process chain under desktop (`bash → omp-host.exe → omp_desktop.exe`),
and a target that is the agent's **ancestor** is never closed by the agent — the whole close → rebuild → relaunch
sequence is handed to the user. A target the agent started itself is fair to close; an unrelated instance is closed
under the profile rule with its name and path in the delivery note.

## Rules changed

- `rules.md#artifact-rebuild` step 1 — identity by `ExecutablePath`, relationship by the parent chain, ancestor targets handed to
  the user, the batch kill named as forbidden.
- `AGENTS.md` 实例区分（强制） — one line: never close an installed ancestor; closing is per profile, never per name.
