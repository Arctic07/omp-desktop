/**
 * The `/` palette end to end: what the engine advertises, what a builtin does when it runs, and
 * what happens to a skill invocation.
 *
 * Split out of `scenarios.ts` because it is the only scenario that needs the fixture skill below
 * (`rules.md#single-file-line-limit`).
 */

import { workspace } from '../client.ts'
import { OMP_DESKTOP_SMOKE_SKILL, OMP_DESKTOP_SMOKE_SKILL_MARKER } from '../fixtures.ts'
import type { Scenario } from '../harness.ts'

/** The command-palette scenario, keyed the way the driver names it. */
export const slashScenario: Record<string, Scenario> = {
  async slash(host, report) {
    const open = host.send({ type: 'session_open', cwd: workspace })
    const opened = await host.response(open)
    const data = opened.data as Record<string, unknown>
    const sessionId = data.sessionId as string
    report.record('slash.open', opened.success === true && typeof sessionId === 'string', JSON.stringify({ sessionId }))

    const advertisement = await host.waitFor<Record<string, unknown>>(
      'available_commands_update',
      frame => frame.type === 'available_commands_update' && frame.sessionId === sessionId,
    )
    // `waitFor` scans every frame it has, so a wait for a mode to be *absent* must say "after this
    // point": the session's first state has no modes at all and would answer immediately.
    const stateSeq = (): number => {
      const states = host.of('state')
      const last = states.at(-1)
      return typeof last?.seq === 'number' ? last.seq : 0
    };
    const commands = (advertisement.commands ?? []) as Array<Record<string, unknown>>
    const names = commands.map(command => String(command.name))
    const sources = commands.map(command => String(command.source ?? ''))
    report.record('slash.advertised', commands.length > 0, `${commands.length} command(s): ${names.slice(0, 8).join(', ')}`)
    // Where a command came from travels with it: the palette labels a skill or a plugin's command
    // with the capability that registered it, and every entry the engine sent names one.
    report.record('slash.sources', sources.every(source => source.length > 0), [...new Set(sources)].join(', '))
    report.record('slash.builtinAdvertised', commands.some(command => command.name === 'tools' && command.source === 'builtin'), names.includes('tools') ? 'tools present' : 'tools missing')
    // `/vibe` is one of the commands the engine ships only for its terminal; the host advertises it
    // because it runs the mode itself (`host/src/vibe.ts`), so the palette must show it here.
    report.record('slash.vibeAdvertised', commands.some(command => command.name === 'vibe' && command.source === 'builtin'), names.includes('vibe') ? 'vibe present' : 'vibe missing')
    const skillName = `skill:${OMP_DESKTOP_SMOKE_SKILL}`
    report.record('slash.skillAdvertised', commands.some(command => command.name === skillName && command.source === 'skill'), names.join(', ').slice(0, 300))

    // A builtin with a text handler runs in the host: the prompt is acknowledged, reported as not
    // having invoked the agent, and what it printed arrives on the notice channel.
    const toolsPrompt = host.send({ type: 'session_prompt', sessionId, message: '/tools' })
    const ack = await host.response(toolsPrompt)
    report.record('slash.builtin.ack', ack.success === true, JSON.stringify(ack.data ?? ack))
    const result = await host.waitFor<Record<string, unknown>>(
      'prompt_result for /tools',
      frame => frame.type === 'prompt_result' && frame.id === toolsPrompt,
    )
    report.record('slash.builtin.local', result.agentInvoked === false, JSON.stringify(result))
    const notice = await host.waitFor<Record<string, unknown>>(
      'notice for /tools output',
      frame => frame.type === 'notice' && typeof frame.message === 'string' && frame.message.includes('read'),
    )
    report.record('slash.builtin.output', typeof notice.message === 'string' && notice.message.length > 0, String(notice.message).split('\n').slice(0, 3).join(' | '))
    // The `/tools` list names mounted devices as `~ xd://<name>`. The redactor used to read the
    // `d:` as a drive letter and draw `~ x<path>` for each, which is the same fault that turned a
    // mount notice into `x<path>: unmounted …`; a reader cannot tell what the line is about then.
    report.record(
      'slash.builtin.schemeIntact',
      typeof notice.message === 'string' && /^~ xd:\/\/\S+/m.test(String(notice.message)),
      String(notice.message).split('\n').filter(line => line.startsWith('~')).join(' | ') || 'no mounted devices listed',
    )

    report.record('slash.builtin.noTurn', host.of('agent_start').length === 0, `${host.of('agent_start').length} agent_start frame(s)`)
    // The regression this covers: the acknowledgement that ends a local command's turn is also
    // what clears the session's previous notice on the frontend, so output published before it was
    // wiped the instant it appeared. The command's answer has to follow the acknowledgement.
    const resultAt = host.frames.findIndex(entry => entry.direction === 'in' && entry.frame.type === 'prompt_result' && entry.frame.id === toolsPrompt)
    const noticeAt = host.frames.findIndex(entry => entry.direction === 'in' && entry.frame === notice)
    report.record('slash.builtin.outputAfterAck', resultAt >= 0 && noticeAt > resultAt, `prompt_result@${resultAt} notice@${noticeAt}`)

    // Vibe mode end to end, with no model call: the mode is a local toolset swap plus a
    // `mode_change` in the session's journal, and the host publishes the new state right after the
    // command. A second `/vibe` restores the toolset the first one snapshotted.
    const vibeOn = host.send({ type: 'session_prompt', sessionId, message: '/vibe' })
    const vibeOnAck = await host.response(vibeOn)
    report.record('slash.vibe.ack', vibeOnAck.success === true, JSON.stringify(vibeOnAck.data ?? vibeOnAck))
    const vibeOnResult = await host.waitFor<Record<string, unknown>>(
      'prompt_result for /vibe',
      frame => frame.type === 'prompt_result' && frame.id === vibeOn,
    )
    report.record('slash.vibe.local', vibeOnResult.agentInvoked === false, JSON.stringify(vibeOnResult))
    const vibeOnState = await host.waitFor<Record<string, unknown>>(
      'state after /vibe',
      frame => {
        const state = frame.state as Record<string, unknown> | undefined
        const modes = state?.modes as Record<string, unknown> | undefined
        return frame.type === 'state' && frame.sessionId === sessionId && modes?.vibe !== undefined
      },
    )
    report.record(
      'slash.vibe.state',
      (vibeOnState.state as Record<string, unknown> | undefined)?.modes !== undefined,
      JSON.stringify({ modes: (vibeOnState.state as Record<string, unknown> | undefined)?.modes }),
    )

    const vibeOffSeq = stateSeq()
    const vibeOff = host.send({ type: 'session_prompt', sessionId, message: '/vibe' })
    const vibeOffAck = await host.response(vibeOff)
    report.record('slash.vibe.off.ack', vibeOffAck.success === true, JSON.stringify(vibeOffAck.data ?? vibeOffAck))
    const vibeOffState = await host.waitFor<Record<string, unknown>>(
      'state after the second /vibe',
      frame => {
        const state = frame.state as Record<string, unknown> | undefined
        const modes = state?.modes as Record<string, unknown> | undefined
        return (
          frame.type === 'state' &&
          frame.sessionId === sessionId &&
          typeof frame.seq === 'number' &&
          frame.seq > vibeOffSeq &&
          modes?.vibe === undefined
        )
      },
    )
    report.record(
      'slash.vibe.off.state',
      ((vibeOffState.state as Record<string, unknown> | undefined)?.modes as Record<string, unknown> | undefined)?.vibe === undefined,
      JSON.stringify({ modes: (vibeOffState.state as Record<string, unknown> | undefined)?.modes }),
    )

    // Plan mode, including the dialog the exit asks for: entering journals the mode, publishes it,
    // and leaving asks through the same `extension_ui_request` lane a tool approval uses.
    const planOn = host.send({ type: 'session_prompt', sessionId, message: '/plan', streamingBehavior: 'steer' })
    await host.response(planOn)
    const planOnState = await host.waitFor<Record<string, unknown>>(
      'state after /plan',
      frame => {
        const state = frame.state as Record<string, unknown> | undefined
        const modes = state?.modes as Record<string, unknown> | undefined
        return frame.type === 'state' && frame.sessionId === sessionId && modes?.plan !== undefined
      },
    )
    report.record(
      'slash.plan.state',
      ((planOnState.state as Record<string, unknown> | undefined)?.modes as Record<string, unknown> | undefined)?.plan !== undefined,
      JSON.stringify({ modes: (planOnState.state as Record<string, unknown> | undefined)?.modes }),
    )

    const planOffSeq = stateSeq()
    const planOff = host.send({ type: 'session_prompt', sessionId, message: '/plan', streamingBehavior: 'steer' })
    await host.response(planOff)
    const planDialog = await host.waitFor<Record<string, unknown>>(
      'confirm dialog for leaving plan mode',
      frame => frame.type === 'extension_ui_request' && frame.method === 'confirm',
    )
    const planAnswer = host.send({
      type: 'session_ui_response',
      sessionId,
      requestId: planDialog.id,
      response: { confirmed: true },
    })
    await host.response(planAnswer)
    await host.waitFor<Record<string, unknown>>(
      'state after leaving plan mode',
      frame => {
        const state = frame.state as Record<string, unknown> | undefined
        const modes = state?.modes as Record<string, unknown> | undefined
        return (
          frame.type === 'state' &&
          frame.sessionId === sessionId &&
          typeof frame.seq === 'number' &&
          frame.seq > planOffSeq &&
          modes?.plan === undefined
        )
      },
    )

    // Loop mode's toggle, with no prompt to run: enabling only arms the next submitted prompt, so
    // this stays a model-free check of the mode and its state.
    const loopOn = host.send({ type: 'session_prompt', sessionId, message: '/loop', streamingBehavior: 'steer' })
    await host.response(loopOn)
    await host.waitFor<Record<string, unknown>>(
      'state after /loop',
      frame => {
        const state = frame.state as Record<string, unknown> | undefined
        const modes = state?.modes as Record<string, unknown> | undefined
        return frame.type === 'state' && frame.sessionId === sessionId && modes?.loop !== undefined
      },
    )
    const loopOffSeq = stateSeq()
    const loopOff = host.send({ type: 'session_prompt', sessionId, message: '/loop', streamingBehavior: 'steer' })
    await host.response(loopOff)
    await host.waitFor<Record<string, unknown>>(
      'state after the second /loop',
      frame => {
        const state = frame.state as Record<string, unknown> | undefined
        const modes = state?.modes as Record<string, unknown> | undefined
        return (
          frame.type === 'state' &&
          frame.sessionId === sessionId &&
          typeof frame.seq === 'number' &&
          frame.seq > loopOffSeq &&
          modes?.loop === undefined
        )
      },
    )

    // The regression this covers: `/rename` with no arguments hands its work to
    // `runCommandInBackground` and only reports once it is done - after the acknowledgement that
    // already flushed the batched output. Those later lines must still reach the reader (they are
    // the command's only report, including its failures).
    const renamePrompt = host.send({ type: 'session_prompt', sessionId, message: '/rename' })
    const renameAck = await host.response(renamePrompt)
    report.record('slash.background.ack', renameAck.success === true, JSON.stringify(renameAck.data ?? renameAck))
    await host.waitFor<Record<string, unknown>>(
      'prompt_result for /rename',
      frame => frame.type === 'prompt_result' && frame.id === renamePrompt,
    )
    const late = await host.waitFor<Record<string, unknown>>(
      'notice for the background rename',
      frame => frame.type === 'notice' && typeof frame.message === 'string' && frame.message.includes('ename'),
      60_000,
    )
    const renameResultAt = host.frames.findIndex(entry => entry.direction === 'in' && entry.frame.type === 'prompt_result' && entry.frame.id === renamePrompt)
    const lateAt = host.frames.findIndex(entry => entry.direction === 'in' && entry.frame === late)
    report.record('slash.background.output', lateAt > renameResultAt, `prompt_result@${renameResultAt} notice@${lateAt} ${String(late.message).slice(0, 120)}`)

    // A skill invocation is an agent turn by construction: the engine builds the skill body into a
    // user-attributed custom message and prompts with it. Its row is the user's own draft, and the
    // expanded body never becomes a row of its own.
    const skillPrompt = host.send({ type: 'session_prompt', sessionId, message: `/skill:${OMP_DESKTOP_SMOKE_SKILL}` })
    const skillAck = await host.response(skillPrompt)
    report.record('slash.skill.ack', skillAck.success === true, JSON.stringify(skillAck.data ?? skillAck))
    const skillResult = await host.waitFor<Record<string, unknown>>(
      'prompt_result for the skill',
      frame => frame.type === 'prompt_result' && frame.id === skillPrompt,
    )
    report.record('slash.skill.invoked', skillResult.agentInvoked === true, JSON.stringify(skillResult))
    await host.waitFor('agent_start for the skill turn', frame => frame.type === 'agent_start', 60_000)
    // The engine delivers a skill as a user-attributed custom message; the desktop reads that pair
    // as the user's own row, which is the only place the invocation is drawn.
    const skillMessage = (frame: Record<string, unknown>): Record<string, unknown> =>
      (frame.message ?? {}) as Record<string, unknown>
    const row = await host.waitFor<Record<string, unknown>>(
      'message_start for the skill row',
      frame =>
        frame.type === 'message_start' &&
        skillMessage(frame).customType === 'skill-prompt' &&
        skillMessage(frame).attribution === 'user' &&
        skillMessage(frame).display === true,
    )
    report.record('slash.skill.userRow', skillMessage(row).attribution === 'user', JSON.stringify({ customType: skillMessage(row).customType, attribution: skillMessage(row).attribution }))
    // The body reaches the model and nobody else: it is inside the message the engine stored, and
    // no streamed fragment carries it to a row.
    const streamed = host
      .of('message_update')
      .filter(frame => JSON.stringify(frame).includes(OMP_DESKTOP_SMOKE_SKILL_MARKER))
    report.record('slash.skill.bodyNotStreamed', streamed.length === 0, `${streamed.length} message_update frame(s) carried the skill body`)

    // Guided goal: the command itself starts the interview turn with a hidden kickoff. The turn
    // then talks to the fixture provider (which never answers), so what is asserted is the dispatch
    // and the kickoff row, not an interview.
    const guidedSeq = stateSeq()
    const guided = host.send({ type: 'session_prompt', sessionId, message: '/guided-goal write the docs', streamingBehavior: 'steer' })
    await host.response(guided)
    const guidedResult = await host.waitFor<Record<string, unknown>>(
      'prompt_result for /guided-goal',
      frame => frame.type === 'prompt_result' && frame.id === guided,
    )
    report.record('slash.guidedGoal.invoked', guidedResult.agentInvoked === true, JSON.stringify(guidedResult))
    // The kickoff is a *synthetic* prompt: the engine records it as a developer message, so the
    // proof is that message carrying the engine's own interview text (`prompt.render`).
    const guidedKickoff = await host.waitFor<Record<string, unknown>>(
      'kickoff message for /guided-goal',
      frame => {
        const message = frame.message as Record<string, unknown> | undefined;
        return (
          frame.type === 'message_start' &&
          message?.role === 'developer' &&
          JSON.stringify(message).includes('guided-goal')
        );
      },
      60_000,
    )
    report.record('slash.guidedGoal.kickoff', guidedKickoff.type === 'message_start', 'engine interview prompt dispatched')

    // Cleanse: the engine's own run against the fixture workspace. It has no configured checker, so
    // the run ends by saying so rather than spawning repair agents - which is the wiring under test.
    const cleanse = host.send({ type: 'session_prompt', sessionId, message: '/cleanse', streamingBehavior: 'steer' })
    await host.response(cleanse)
    const cleanseNotice = await host.waitFor<Record<string, unknown>>(
      'notice for /cleanse',
      frame => frame.type === 'notice' && typeof frame.message === 'string' && frame.message.includes('Cleanse started'),
    )
    report.record('slash.cleanse.started', typeof cleanseNotice.message === 'string', String(cleanseNotice.message))
    const cleanseEnd = await host.waitFor<Record<string, unknown>>(
      'result line for /cleanse',
      frame =>
        frame.type === 'notice' &&
        typeof frame.message === 'string' &&
        /^Cleanse (unresolved|completed|unsupported|cancelled|failed|stopped)\b/.test(frame.message),
      120_000,
    )
    report.record('slash.cleanse.finished', typeof cleanseEnd.message === 'string', String(cleanseEnd.message))

    // A side question: the answer is its own stream (`btw` frames), never a row of this transcript.
    const btwAsk = host.send({
      type: 'session_prompt',
      sessionId,
      message: '/btw where is the config file',
      streamingBehavior: 'steer',
    })
    await host.response(btwAsk)
    const btwRecord = await host.waitFor<Record<string, unknown>>(
      'btw record for the side question',
      frame => frame.type === 'btw' && frame.kind === 'record' && frame.question === 'where is the config file',
      120_000,
    )
    report.record('slash.btw.question', btwRecord.type === 'btw', String(btwRecord.question))
    // The fixture provider never answers, so the engine's own record ends in `error`; what matters
    // here is that the record is the engine's checkpoint, not a host invention.
    report.record('slash.btw.outcome', typeof btwRecord.status === 'string', String(btwRecord.status))
    const btwClear = host.send({ type: 'session_prompt', sessionId, message: '/btw clear', streamingBehavior: 'steer' })
    await host.response(btwClear)
    await host.waitFor<Record<string, unknown>>(
      'btw cleared',
      frame => frame.type === 'btw' && frame.kind === 'cleared',
    )
    report.record('slash.btw.cleared', true, 'cleared')

    // Tangential work: the dispatch is the engine's own background message, and the job it names
    // runs as a detached background job (`/tan`), so this asserts the dispatch record rather than
    // waiting for the fixture provider to answer.
    const tan = host.send({
      type: 'session_prompt',
      sessionId,
      message: '/tan survey the parser package',
      streamingBehavior: 'steer',
    })
    const tanAck = await host.response(tan)
    report.record('slash.tan.ack', tanAck.success === true, JSON.stringify(tanAck.data ?? tanAck))
    const tanResult = await host.waitFor<Record<string, unknown>>(
      'prompt_result for /tan',
      frame => frame.type === 'prompt_result' && frame.id === tan,
    )
    report.record('slash.tan.local', tanResult.agentInvoked === false, JSON.stringify(tanResult))
    // The dispatch is a detached background job: the state snapshot names it, which is the same
    // roster the composer's background-work pill draws.
    const tanState = await host.waitFor<Record<string, unknown>>(
      'state naming the tan job',
      frame => {
        if (frame.type !== 'state' || frame.sessionId !== sessionId) return false;
        const state = frame.state as Record<string, unknown> | undefined;
        const jobs = Array.isArray(state?.backgroundJobs) ? state.backgroundJobs : [];
        return jobs.some(job => {
          const label = (job as Record<string, unknown>).label;
          return typeof label === 'string' && label.startsWith('/tan ');
        });
      },
      120_000,
    )
    report.record('slash.tan.job', tanState.type === 'state', 'background job listed')

    // Goal mode's whole lifecycle through commands, with the model never answering: create,
    // pause, resume, drop. Each step is read back from the state snapshot the strip draws.
    const goalOn = host.send({ type: 'session_prompt', sessionId, message: '/goal smoke objective' })
    await host.response(goalOn)
    const goalSeq = stateSeq()
    const goalState = (await host.waitFor<Record<string, unknown>>(
      'state after /goal',
      frame => {
        const state = frame.state as Record<string, unknown> | undefined
        const modes = state?.modes as Record<string, unknown> | undefined
        return (
          frame.type === 'state' &&
          frame.sessionId === sessionId &&
          typeof frame.seq === 'number' &&
          frame.seq > goalSeq &&
          modes?.goal !== undefined
        )
      },
    )) as Record<string, unknown>
    const goalMode = ((goalState.state as Record<string, unknown>).modes as Record<string, unknown>).goal as Record<string, unknown>
    report.record('slash.goal.state', goalMode.objective === 'smoke objective', JSON.stringify(goalMode))

    // The objective started a turn (the fixture provider never answers, which is fine): the pause
    // has to wait for that turn to settle, because a prompt without a streaming behaviour is
    // refused while one is running.
    await host.waitFor('agent_end after the goal turn', frame => frame.type === 'agent_end', 120_000)
    // A failed goal turn schedules the next continuation, so the window between turns is not a
    // reliable one: the command is steered so it runs whether or not a turn is already running
    // (a local command runs immediately; the behaviour only satisfies the busy gate).
    const pauseSeq = stateSeq()
    const goalPause = host.send({ type: 'session_prompt', sessionId, message: '/goal pause', streamingBehavior: 'steer' })
    await host.response(goalPause)
    const paused = await host.waitFor<Record<string, unknown>>(
      'state after /goal pause',
      frame => {
        const state = frame.state as Record<string, unknown> | undefined
        const modes = state?.modes as Record<string, unknown> | undefined
        const goal = modes?.goal as Record<string, unknown> | undefined
        return (
          frame.type === 'state' &&
          frame.sessionId === sessionId &&
          typeof frame.seq === 'number' &&
          frame.seq > pauseSeq &&
          goal?.enabled === false
        )
      },
    )
    report.record('slash.goal.pause', paused.type === 'state', JSON.stringify((paused.state as Record<string, unknown> | undefined)?.modes))

    const resumeSeq = stateSeq()
    const goalResume = host.send({ type: 'session_prompt', sessionId, message: '/goal resume', streamingBehavior: 'steer' })
    await host.response(goalResume)
    const resumed = await host.waitFor<Record<string, unknown>>(
      'state after /goal resume',
      frame => {
        const state = frame.state as Record<string, unknown> | undefined
        const modes = state?.modes as Record<string, unknown> | undefined
        const goal = modes?.goal as Record<string, unknown> | undefined
        return (
          frame.type === 'state' &&
          frame.sessionId === sessionId &&
          typeof frame.seq === 'number' &&
          frame.seq > resumeSeq &&
          goal?.enabled === true
        )
      },
    )
    report.record('slash.goal.resume', resumed.type === 'state', JSON.stringify((resumed.state as Record<string, unknown> | undefined)?.modes))

    const dropSeq = stateSeq()
    const goalDrop = host.send({ type: 'session_prompt', sessionId, message: '/goal drop', streamingBehavior: 'steer' })
    await host.response(goalDrop)
    const afterDrop = await host.waitFor<Record<string, unknown>>(
      'state after /goal drop',
      frame => {
        const state = frame.state as Record<string, unknown> | undefined
        const modes = state?.modes as Record<string, unknown> | undefined
        if (frame.type !== 'state' || frame.sessionId !== sessionId) return false
        const goal = modes?.goal as Record<string, unknown> | undefined
        return (
          typeof frame.seq === 'number' &&
          frame.seq > dropSeq &&
          (goal === undefined || goal.enabled === false)
        )
      },
    )
    report.record('slash.goal.droppedState', afterDrop.type === 'state', JSON.stringify((afterDrop.state as Record<string, unknown> | undefined)?.modes))

    // No mode toggle may leave a banner in the conversation column: the composer's chips and their
    // panels are the reading. The notices the commands printed above are checked as a set, so a
    // regression that reintroduces "Plan mode enabled." fails here rather than in a screenshot.
    const banners = host
      .of('notice')
      .filter((frame) => {
        const message = frame.message;
        if (typeof message !== 'string') return false;
        return (
          /\b(Vibe|Plan|Loop) mode (enabled|disabled|paused)\b/.test(message) ||
          /\bGoal (mode (enabled|resumed)|paused|dropped)\b/.test(message)
        );
      })
      .map((frame) => String(frame.message));
    report.record('slash.modeBannersAbsent', banners.length === 0, banners.join(' | ') || 'no mode banners');

    // The engine announces every `xd://` mount change, which makes it one line per toolset swap:
    // entering vibe or plan mode wrote a pair of them into the composer. Nothing about the reader's
    // tool surface comes from that line (the mode chips and `/tools` are the reading), so the host
    // drops it; a regression that lets it back in fails here.
    const mountNotices = host
      .of('notice')
      .filter((frame) => typeof frame.message === 'string' && /^xd:\/\/: (mounted|unmounted)\b/.test(String(frame.message)))
      .map((frame) => String(frame.message));
    report.record('slash.mountNoticesAbsent', mountNotices.length === 0, mountNotices.join(' | ') || 'no mount notices');

    const abortId = host.send({ type: 'session_abort', sessionId })
    await host.response(abortId, 60_000)

    // A `/skill:` invocation is the reader's own message, so the row's own timestamp is the address
    // a rewind cuts at - and one that has to work: the host used to look for a user *message*
    // carrying that stamp, find none (the engine stores the invocation as a custom message) and
    // answer "No user message of this conversation was written at that time." on the row the reader
    // had just sent (2026-10-31, user report: `/skill` then 撤回).
    const before = await host.response(host.send({ type: 'session_history_page', sessionId }), 60_000)
    const page = (before.data ?? {}) as Record<string, unknown>
    const entries = Array.isArray(page.messages) ? (page.messages as Array<Record<string, unknown>>) : []
    // The page is the engine's own entries; the invocation is the custom message the engine delivered.
    const invocation = entries.find(
      (entry) => entry.type === 'custom_message' && entry.customType === 'skill-prompt',
    )
    const stamp = invocation?.timestamp
    const skillAt =
      typeof stamp === 'number' ? stamp : typeof stamp === 'string' ? Date.parse(stamp) : -1
    report.record('slash.skill.rewindAddress', skillAt > 0, JSON.stringify({ entries: entries.length, at: skillAt }))
    const rewind = await host.response(host.send({ type: 'session_rewind', sessionId, at: skillAt }), 60_000)
    const rewound = (rewind.data ?? {}) as Record<string, unknown>
    report.record(
      'slash.skill.rewind',
      rewind.success === true && rewound.cancelled === false,
      JSON.stringify(rewind.data ?? rewind).slice(0, 200),
    )
    const draft = rewound.text
    report.record(
      'slash.skill.rewindDraft',
      typeof draft === 'string' && draft.includes(`/skill:${OMP_DESKTOP_SMOKE_SKILL}`),
      JSON.stringify(draft ?? null).slice(0, 200),
    )
    const after = await host.response(host.send({ type: 'session_history_page', sessionId }), 60_000)
    const cut = (after.data ?? {}) as Record<string, unknown>
    const cutRows = Array.isArray(cut.messages) ? (cut.messages as Array<Record<string, unknown>>) : []
    report.record(
      'slash.skill.rewindCut',
      typeof cut.totalMessages === 'number' &&
        typeof page.totalMessages === 'number' &&
        cut.totalMessages < page.totalMessages &&
        !JSON.stringify(cutRows).includes(`/skill:${OMP_DESKTOP_SMOKE_SKILL}`),
      `${String(page.totalMessages)} -> ${String(cut.totalMessages)}`,
    )

    host.send({ type: 'session_close', sessionId })
    host.send({ type: 'host_shutdown', reason: 'slash' })
    const exit = await host.finish()
    report.record('slash.exit', exit === 0, `exit=${exit}`)
    return { commands: commands.length, sources: [...new Set(sources)], skill: skillName }
  },
}
