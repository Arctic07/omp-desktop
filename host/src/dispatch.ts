/**
 * Command routing.
 *
 * Requests are answered by `id`, never by arrival order: sessions run concurrently, so the order
 * a response comes back in says nothing about which command it belongs to.
 *
 * Commands that arrive before this host has published `ready` are not queued here: the host reads
 * stdin only after it has finished process-level initialization and published `ready`, so the
 * operating system's pipe buffer is what holds them (contract §2.3, ruling A15). What this
 * dispatcher does enforce is the other half of the handshake: until `hello_ok` has pinned the
 * protocol, no other command is served - `host_not_ready` names that state instead of guessing at
 * a command whose meaning depends on the version.
 */

import * as path from 'node:path'

import { clearProviderKey, setProviderKey, setProviderKeys } from './auth-keys.ts'
import type { BootServices } from './boot.ts'
import type { HostPaths } from './env.ts'
import { logError, logLine, sanitizeMessage } from './log.ts'
import { listMcp, removeMcp, setMcpEnabled, upsertMcp } from './mcp.ts'
import { readMemory, readMemoryCatalog, runMemoryAction } from './memory.ts'
import { applyMcpSources, scanMcpSources } from './mcp-sources.ts'
import { applyOmpImport, scanOmpImport } from './omp-import.ts'
import { reclaimCaches, reclaimWindow } from './reclaim.ts'
import { draftCommitMessage } from './commit-message.ts'
import { modelSummary, roleCandidates, roleRows, setRole } from './models.ts'
import type { FrameWriter } from './outbound.ts'
import { complete as pluginComplete, readRequest as readCompletionRequest } from './plugin-agent.ts'
import { pluginEngineInfo } from './plugins-engine.ts'
import type { PluginSessionsPort } from './plugin-sessions.ts'
import { sessionGet, sessionList, sessionMessages, usageTurns } from './plugin-sessions.ts'
import { sockets } from './plugin-websocket.ts'
import { text } from './protocol/fields.ts'
import {
  addMarketplace,
  checkPluginUpdates,
  installPlugin,
  listMarketplacePlugins,
  listMarketplaces,
  listPlugins,
  readPluginConfig,
  reloadPlugins,
  removeMarketplace,
  resetPluginConfig,
  setPluginEnabled,
  uninstallPlugin,
  updateMarketplace,
  upgradePlugins,
  writePluginConfig,
} from './plugins.ts'
import { ERROR_CODES, HostError, invalidInput } from './protocol/errors.ts'
import { readRules, writeRules } from './rules.ts'
import type { SessionRegistry } from './sessions.ts'
import type { SdkBundle } from './sdk.ts'
import {
  readApprovalMode,
  readCompaction,
  setApprovalMode,
  setCompaction,
  setCompactionOptions,
} from './settings.ts'
import { listSkills, setSkills } from './skills.ts'
import { settleBrowser, settleTerminal } from './tools.ts'
import { summary as usageSummary } from './usage.ts'

/**
 * Frames this build has no producer for; they are refused, not silently ignored.
 *
 * The four are the RPC-sidecar vocabulary the migration dropped (contract §2.6): this protocol
 * answers the same questions with frames the host composes itself - a `task` child's work travels as
 * `{type:"subagent"}` / `subagent_event`. They stay
 * listed because a caller that asks for one is owed an answer: the refusal is what turns "this build
 * does not do that" into `invalid_input` under the caller's own `id`, instead of a caller waiting out
 * its own timeout against a host that said nothing. The smoke asserts exactly that
 * (`host/scripts/scenarios.ts`), so the branch is covered behaviour rather than a reservation.
 */
const UNPRODUCED_FRAMES: Record<string, true> = {
  host_tool_call: true,
  host_tool_cancel: true,
  host_uri_request: true,
  host_uri_cancel: true,
}

/** Everything one dispatch needs from the process around it. */
export interface DispatchContext {
  readonly paths: HostPaths
  readonly sdk: SdkBundle
  readonly services: BootServices
  readonly registry: SessionRegistry
  readonly writer: FrameWriter
  readonly protocolVersion: number
  readonly hostVersion: string
  readonly sdkVersion: string
  readonly ready: () => boolean
  readonly uptimeMs: () => number
  /** UI dialog timeout in effect, i.e. the F4 test knob once it has been applied. */
  readonly uiRequestTimeoutMs: () => number
  readonly requestShutdown: (reason: string) => void
  readonly requestExit: (code: number) => void
}

/** Routes one inbound command frame. */
export class Dispatcher {
  readonly #context: DispatchContext
  /** Set by `hello_ok`; until then every other command is refused as `host_not_ready`. */
  #negotiated = false

  constructor(context: DispatchContext) {
    this.#context = context
  }

  /** What the P1 session reads need: this host's store, and the engine's own entry stream. */
  #sessionPort(): PluginSessionsPort {
    return { paths: this.#context.paths, sdk: this.#context.sdk }
  }

  /** Handles one inbound command. */
  async accept(frame: Record<string, unknown>): Promise<void> {
    const type = typeof frame.type === 'string' ? frame.type : ''
    if (type === '') {
      this.#context.registry.noteUnknownFrame()
      return
    }
    if (UNPRODUCED_FRAMES[type] === true) {
      this.#context.registry.noteRejectedCommand()
      this.#fail(frame, invalidInput(`${type} has no producer in this engine and is not implemented.`))
      return
    }
    await this.#route(frame, type)
  }

  async #route(frame: Record<string, unknown>, type: string): Promise<void> {
    const id = typeof frame.id === 'string' ? frame.id : null
    try {
      if (type !== 'hello_ok' && !this.#negotiated) {
        throw new HostError(
          ERROR_CODES.host_not_ready,
          'The host has not completed the protocol handshake, so this command is not served yet.',
        )
      }
      switch (type) {
        case 'hello_ok': {
          if (frame.protocol !== this.#context.protocolVersion) {
            this.#fail(frame, new HostError(
              ERROR_CODES.protocol_mismatch,
              `The desktop host speaks protocol ${String(frame.protocol)}, this host speaks ${this.#context.protocolVersion}.`,
            ))
            this.#context.requestExit(3)
            return
          }
          this.#negotiated = true
          this.#ok(id, {
            hostVersion: this.#context.hostVersion,
            sdkVersion: this.#context.sdkVersion,
            ready: this.#context.ready(),
          })
          return
        }
        case 'host_health':
          this.#ok(id, this.#health())
          return
        case 'host_shutdown':
          this.#ok(id, { closed: true })
          this.#context.requestShutdown(typeof frame.reason === 'string' ? frame.reason : 'desktop')
          return
        case 'models_reload':
          this.#detach(type, frame, () => this.#modelsReload())
          return
        case 'engine_reclaim': {
          // The engine's own tree is read-only to everything outside this process (§5.3), so the
          // caches it left there are reclaimed here, by the process that owns it. Blocking and
          // bounded: one pass over a handful of directories inside the engine's tree.
          //
          // `recentMs` is the caller's appetite, resolved by `reclaimWindow`: the settings page's
          // clear sends none (a day), the desktop's automatic pass sends a week.
          const outcome = reclaimCaches(
            { configRoot: path.join(this.#context.paths.home, this.#context.paths.configDir), home: this.#context.paths.home },
            { engineVersion: this.#context.sdkVersion, recentMs: reclaimWindow(frame.recentMs) },
          )
          logLine(
            `engine reclaim: ${String(outcome.freedBytes)} bytes freed, ${String(outcome.removed.length)} removed, ${String(outcome.skipped.length)} kept`,
          )
          this.#ok(id, {
            freedBytes: outcome.freedBytes,
            removed: outcome.removed,
            skipped: outcome.skipped,
          })
          return
        }
        case 'model_roles':
          this.#ok(id, { roles: await roleRows(this.#context.services, this.#context.sdk) })
          return
        case 'model_role_candidates': {
          const candidates = roleCandidates(this.#context.services, this.#context.sdk, this.#role(frame))
          this.#ok(id, { role: candidates.role, models: candidates.models, truncated: candidates.truncated })
          return
        }
        case 'model_role_set':
          this.#ok(id, {
            roles: await setRole(this.#context.services, this.#context.sdk, this.#role(frame), this.#selector(frame)),
          })
          return
        // The desktop's own keyring-backed provider key, pushed into the running engine as an
        // in-memory runtime override. Both are host-level and answered inline: they touch only the
        // engine's auth storage (a map write and a lookup), so there is nothing to detach, and the
        // answers carry the provider id and auth source kind rather than the secret (`auth-keys.ts`).
        case 'provider_key_set':
          this.#ok(id, setProviderKey(this.#context.services, frame.providerId, frame.apiKey))
          return
        case 'provider_keys_set':
          this.#ok(
            id,
            await setProviderKeys(this.#context.services, frame.providerId, frame.apiKeys),
          )
          return
        case 'provider_key_clear':
          this.#ok(
            id,
            await clearProviderKey(this.#context.services, frame.providerId),
          )
          return
        case 'skills_list':
          this.#ok(id, await listSkills(this.#context.paths, this.#context.services, this.#context.sdk, frame))
          return
        case 'skills_set':
          this.#ok(id, await setSkills(this.#context.paths, this.#context.services, this.#context.sdk, frame))
          return
        // The engine's approval mode, not a session's: it is read and written through the engine's
        // settings, and the engine turns it into permission requests on the UI bridge.
        case 'approval_mode':
          this.#ok(id, readApprovalMode(this.#context.services))
          return
        case 'approval_mode_set':
          this.#ok(id, await setApprovalMode(this.#context.services, frame))
          return
        // The engine's compaction switch, not a session's either: it decides whether the engine
        // compacts a filling context by itself, and it is acted on inside the agent loop.
        case 'compaction_status':
          this.#ok(id, readCompaction(this.#context.services))
          return
        case 'compaction_set_enabled':
          this.#ok(id, await setCompaction(this.#context.services, frame))
          return
        // The idle half of the same card: whether a settled conversation is compacted while nobody
        // is looking, and whether an idle stretch is summarized. Both are engine settings the two
        // switches write one at a time (a frame that names neither is refused).
        case 'compaction_set_options':
          this.#ok(id, await setCompactionOptions(this.#context.services, frame))
          return
        // The engine's user-scope sticky rules file, read and replaced whole (`rules.ts`). Host-level
        // like the two above rather than session-scoped: the file lives in the agent directory and
        // applies to every workspace, so neither a session nor a cwd is named by either frame.
        case 'rules_read':
          this.#ok(id, await readRules(this.#context.paths, this.#context.sdk, frame))
          return
        case 'rules_write':
          this.#ok(id, await writeRules(this.#context.paths, this.#context.sdk, frame))
          return
        case 'mcp_list':
          this.#ok(id, await listMcp(this.#context.paths, this.#context.sdk, this.#context.registry, frame))
          return
        case 'mcp_set_enabled':
          this.#ok(id, await setMcpEnabled(this.#context.paths, this.#context.sdk, this.#context.registry, frame))
          return
        case 'mcp_upsert':
          this.#ok(id, await upsertMcp(this.#context.paths, this.#context.sdk, this.#context.registry, frame))
          return
        case 'mcp_remove':
          this.#ok(id, await removeMcp(this.#context.paths, this.#context.sdk, this.#context.registry, frame))
          return
        // Another omp installation's user configuration, read from its agent directory
        // (`omp-import.ts`): the scan reports what is there and what this engine already holds, and
        // the apply copies the selected categories, skipping every identity already present.
        case 'omp_import_scan':
          this.#ok(id, await scanOmpImport(this.#context.paths, this.#context.services, this.#context.sdk, frame))
          return
        // Detached, like every other import that writes: the apply reloads the model registry,
        // copies skill trees and connects MCP servers, and the answer it produces is the same shape
        // whether it lands now or off the read loop. Held here, a prompt sent meanwhile would wait
        // behind all of it (`#detach`).
        case 'omp_import_apply':
          this.#detach(type, frame, () =>
            applyOmpImport(
              this.#context.paths,
              this.#context.services,
              this.#context.sdk,
              this.#context.registry,
              frame,
            ),
          )
          return
        // The other coding agents' own MCP definitions (Claude Code, Codex, omp, legacy pi), read
        // from the real profile the desktop names - the engine's discovery cannot see them, because
        // this host runs with `HOME` pinned into the application's data root (`mcp-sources.ts`).
        case 'mcp_import_scan':
          this.#ok(id, await scanMcpSources(this.#context.paths, this.#context.sdk, frame))
          return
        // Detached for the same reason: the apply writes `mcp.json` and then connects what it wrote
        // (`mcp-sources.ts`'s `connectWritten`), which is a live handshake per server.
        case 'mcp_import_apply':
          this.#detach(type, frame, () =>
            applyMcpSources(this.#context.paths, this.#context.sdk, this.#context.registry, frame),
          )
          return
        case 'memory_status':
          this.#ok(id, await readMemory(this.#context.paths, this.#context.services, this.#context.sdk, frame))
          return
        case 'memory_action':
          this.#ok(id, await runMemoryAction(this.#context.paths, this.#context.services, this.#context.sdk, frame))
          return
        case 'memory_catalog':
          this.#ok(id, await readMemoryCatalog(this.#context.paths, this.#context.services, this.#context.sdk, frame))
          return
        // The plugin registry, for the settings page: the installed set with the facts each row
        // shows, the writes that change it, the marketplace catalogs instances are installed from,
        // and one plugin's own settings. Every write reloads the live sessions before it answers
        // (`plugins.ts`'s `reloadAndList`), so the list a caller reads back is the state those
        // sessions run on rather than the state the registry file has.
        case 'plugins_list':
          this.#ok(id, await listPlugins(this.#context.paths, this.#context.services, this.#context.sdk, frame))
          return
        // Every plugin and marketplace write is detached, not awaited: the heaviest of them run npm
        // and git, fetch catalogues and walk the plugin trees, and the desktop budgets 120 s for the
        // longest (`INSTALL_TIMEOUT_MS` in `src-tauri/src/services/runtime/mod.rs`) before it
        // reports `timeout`. Held on the read loop, an install would park a prompt sent meanwhile,
        // and the caller would read the host's silence as the prompt having timed out. See `#detach`.
        case 'plugins_install':
          this.#detach(type, frame, () =>
            installPlugin(this.#context.paths, this.#context.services, this.#context.sdk, frame, this.#context.registry),
          )
          return
        case 'plugins_uninstall':
          this.#detach(type, frame, () =>
            uninstallPlugin(this.#context.paths, this.#context.services, this.#context.sdk, frame, this.#context.registry),
          )
          return
        // `plugins_set_enabled` is detached for the same reason, at a smaller scale: it spawns
        // nothing and fetches nothing, but it rewrites the engine's registries and then reloads
        // every live conversation - up to `MAX_LIVE_SESSIONS` (8) of them - and each reload awaits
        // engine work (agent discovery, a skill scan). Inline, that parks the read loop for however
        // long those scans take; the answer's shape is unchanged.
        case 'plugins_set_enabled':
          this.#detach(type, frame, () =>
            setPluginEnabled(this.#context.paths, this.#context.services, this.#context.sdk, frame, this.#context.registry),
          )
          return
        case 'plugins_upgrade':
          this.#detach(type, frame, () =>
            upgradePlugins(this.#context.paths, this.#context.services, this.#context.sdk, frame, this.#context.registry),
          )
          return
        case 'plugins_check_updates':
          this.#detach(type, frame, () =>
            checkPluginUpdates(this.#context.paths, this.#context.services, this.#context.sdk, frame),
          )
          return
        // The engine diagnostic behind the plugin page's "can this machine install plugins" line:
        // the loaded engine and protocol plus the external tools an install spawns, all measured in
        // this process rather than asked of the engine (spec §15.1-6).
        case 'plugins_engine':
          this.#ok(id, pluginEngineInfo(this.#context.sdkVersion, this.#context.protocolVersion))
          return
        case 'marketplaces_list':
          this.#ok(id, await listMarketplaces(this.#context.paths, this.#context.services, this.#context.sdk, frame))
          return
        // The catalogue entries the store lists. Read from the engine's cached catalogues - no
        // fetch - so it answers inline like the registry read beside it, and a store that opens on a
        // stale catalogue shows what the last refresh wrote rather than blocking on the network.
        case 'marketplace_plugins':
          this.#ok(id, await listMarketplacePlugins(this.#context.paths, this.#context.services, this.#context.sdk, frame))
          return
        case 'marketplaces_add':
          this.#detach(type, frame, () => addMarketplace(this.#context.paths, this.#context.services, this.#context.sdk, frame))
          return
        case 'marketplaces_remove':
          this.#detach(type, frame, () => removeMarketplace(this.#context.paths, this.#context.services, this.#context.sdk, frame))
          return
        case 'marketplaces_update':
          this.#detach(type, frame, () => updateMarketplace(this.#context.paths, this.#context.services, this.#context.sdk, frame))
          return
        case 'plugins_config_list':
          this.#ok(id, await readPluginConfig(this.#context.paths, this.#context.services, this.#context.sdk, frame))
          return
        case 'plugins_config_set':
          this.#ok(id, await writePluginConfig(this.#context.paths, this.#context.services, this.#context.sdk, frame))
          return
        case 'plugins_config_reset':
          this.#ok(id, await resetPluginConfig(this.#context.paths, this.#context.services, this.#context.sdk, frame))
          return
        // The UI's own refresh: nothing changed through this host, but the plugin files may have
        // (an edit, a checkout, another process's install), and a session only reads them once.
        case 'plugins_reload':
          this.#ok(id, await reloadPlugins(this.#context.registry))
          return
        // The P1 read surfaces (`omp.desktop` API 0.2.0): the index, the accounting and one
        // conversation's messages, answered from what this host already holds. None of them is
        // detached: each is a bounded read out of the store (a page is at most 500 rows), and the
        // page's own budget is the caller's timeout.
        case 'plugins_session_list':
          this.#ok(id, sessionList(this.#sessionPort(), frame))
          return
        case 'plugins_session_get':
          this.#ok(id, sessionGet(this.#sessionPort(), frame))
          return
        case 'plugins_session_messages':
          this.#ok(id, await sessionMessages(this.#sessionPort(), frame))
          return
        // The two plugin-side session *writes* (`omp.desktop` API 0.3.0) have no frame here: a
        // plugin's `session.rename` and `session.delete` are the `session_set_name` /
        // `session_delete` arms below, which take the routing id in place of the desktop's own
        // address (`session-files.ts` resolves it).
        case 'plugins_usage_turns':
          this.#ok(id, await usageTurns(this.#sessionPort(), frame))
          return
        // One completion on the models this process already resolved. Detached for the same reason
        // a commit draft is: it is a model call that may take a minute, and holding the read loop
        // would park every prompt behind it.
        case 'plugins_agent_complete':
          this.#detach(type, frame, async () =>
            pluginComplete(this.#context.sdk, this.#context.services, readCompletionRequest(frame)),
          )
          return
        // The socket calls. `open` waits for a handshake and `receive` may wait out the caller's
        // poll, so both are detached; `send` and `close` answer inline.
        case 'plugins_ws_open': {
          const socketId = text(frame.socketId, 'socketId', true) as string
          const url = text(frame.url, 'url', true) as string
          const owner = text(frame.owner, 'owner', true) as string
          this.#detach(type, frame, async () => {
            await sockets.open(socketId, url, owner)
            return { socketId }
          })
          return
        }
        case 'plugins_ws_send':
          this.#ok(
            id,
            sockets.send(text(frame.socketId, 'socketId', true) as string, text(frame.data, 'data', true) as string),
          )
          return
        case 'plugins_ws_close': {
          sockets.close(text(frame.socketId, 'socketId', true) as string)
          this.#ok(id, { closed: true })
          return
        }
        case 'plugins_ws_receive': {
          const waitMs = typeof frame.waitMs === 'number' ? frame.waitMs : 0
          const limit = typeof frame.limit === 'number' ? frame.limit : 16
          this.#ok(
            id,
            await sockets.receive(text(frame.socketId, 'socketId', true) as string, waitMs, limit),
          )
          return
        }
        case 'plugins_ws_close_owner':
          this.#ok(id, { closed: sockets.closeOwner(text(frame.owner, 'owner', true) as string) })
          return
        case 'usage_summary':
          this.#detach(type, frame, () => usageSummary(this.#context.paths, this.#context.sdk, frame))
          return
        case 'session_open':
          this.#ok(id, await this.#context.registry.open(frame))
          return
        case 'session_close':
          this.#ok(id, await this.#context.registry.close(frame.sessionId, frame.dropFile === true))
          return
        // The desktop's own delete. It addresses the transcript the caller holds, which is what a
        // plugin cannot: a plugin's `session.delete` sends the routing id `session.read` published,
        // and `session-files.ts` resolves it through the conversation index. Both are the same
        // command - one frame, one writer, one set of refusals.
        case 'session_delete':
          this.#ok(id, await this.#context.registry.delete(frame))
          return
        case 'session_prompt':
          this.#ok(id, await this.#context.registry.prompt(frame))
          return
        case 'session_abort':
          this.#ok(id, await this.#context.registry.abort(frame.sessionId, frame.reason))
          return
        case 'session_force_stop':
          this.#ok(id, await this.#context.registry.forceStop(frame.sessionId))
          return
        case 'session_stop_job':
          this.#ok(id, await this.#context.registry.stopJob(frame))
          return
        case 'session_set_model':
          this.#ok(id, await this.#context.registry.setModel(frame))
          return
        case 'session_set_thinking':
          this.#ok(id, await this.#context.registry.setThinking(frame))
          return
        // The registry's rename, which serves both this desktop's own frames and a plugin's
        // `session.rename`: both name the routing id the live record is held under, and both get
        // `session_not_found` for a conversation that is not open here.
        case 'session_set_name':
          this.#ok(id, await this.#context.registry.setName(frame))
          return
        case 'session_state':
          this.#ok(id, await this.#context.registry.state(frame.sessionId))
          return
        case 'session_history_page':
          this.#ok(id, await this.#context.registry.history(frame))
          return
        case 'commit_message':
          this.#detach(type, frame, () => draftCommitMessage(this.#context.sdk, this.#context.services, frame))
          return
        case 'session_branch_points':
          this.#ok(id, this.#context.registry.branchPoints(frame))
          return
        case 'session_branch':
          this.#ok(id, await this.#context.registry.branch(frame))
          return
        case 'session_branch_from':
          this.#ok(id, await this.#context.registry.branchFrom(frame))
          return
        case 'session_rewind':
          this.#ok(id, await this.#context.registry.rewind(frame))
          return
        case 'session_config':
          this.#ok(id, this.#context.registry.config(frame.sessionId))
          return
        case 'session_ui_response':
          this.#ok(id, this.#context.registry.uiResponse(frame))
          return
        // The application's answer to one `terminal_request` the host asked for: the tool call that
        // asked is settled here with what the action produced, and `accepted` says whether a request
        // was still waiting for it.
        case 'session_terminal_response':
          this.#ok(id, { accepted: settleTerminal(frame) })
          return
        // The application's answer to one `browser_request`: the tool call that asked is settled
        // with what the page did, and `accepted` says whether a request was still waiting for it.
        case 'session_browser_response':
          this.#ok(id, { accepted: settleBrowser(frame) })
          return
        case 'session_replay':
          this.#ok(id, this.#context.registry.replay(frame))
          return
        default:
          // A command this build does not know is refused under its own `id`, exactly as an
          // unproduced one is: the caller is waiting for an answer to that id, and silence would
          // cost it its whole timeout - the same failure the version handshake exists to prevent,
          // one command at a time. It is counted as an unknown frame either way, because a command
          // nobody can name is also what a missing case looks like from here.
          this.#context.registry.noteUnknownFrame()
          logLine(`refusing unknown frame type ${type}`)
          this.#fail(frame, invalidInput(`Unknown command type ${type}.`))
          return
      }
    } catch (error) {
      if (!(error instanceof HostError)) logError(`command ${type} failed`, error)
      this.#fail(frame, this.#reject(type, error))
    }
  }

  /**
   * Runs a host-level command off the read loop.
   *
   * The read loop awaits every frame it hands over, which is what keeps one session's commands in
   * their arrival order - an invariant the session commands are written against, because a prompt
   * and an abort for the same session must not race. Everything that calls this is outside that
   * order: either a read of process-wide engine state (the transcripts the usage scan walks, the
   * model caches) or a plugin write that leaves the process. Awaiting one of those would park every
   * frame behind it in the pipe - `usage_summary` reads up to `USAGE_MAX_FILES` files, and an
   * install spends up to 120 s in the npm/git spawn and the network it was given - so a prompt sent
   * meanwhile would wait behind that work before it was even read, and would time out on the
   * desktop side while the host was busy answering something else.
   *
   * Detaching costs the caller nothing it can observe: the answer carries the `id` the frame came
   * with, which is what the desktop correlates a response by, and a plugin write reloads the live
   * sessions before it builds its answer, so the list it returns is the state those sessions run on
   * rather than the state the registry file has.
   *
   * Nothing is on the stack waiting when the work finishes, so every failure is written down before
   * it is answered. A command still running when a shutdown arrives is cut off with the process -
   * the caller asked for the shutdown, and an unsent answer on the way out is what every in-flight
   * request ends with anyway.
   */
  #detach(type: string, frame: Record<string, unknown>, work: () => Promise<Record<string, unknown>>): void {
    const id = typeof frame.id === 'string' ? frame.id : null
    void work().then(
      data => {
        this.#ok(id, data)
      },
      (error: unknown) => {
        logError(`command ${type} failed off the read loop`, error)
        this.#fail(frame, this.#reject(type, error))
      },
    )
  }

  /**
   * Classifies a failed command as the error to answer with.
   *
   * A `HostError` already carries the wire code the caller needs; anything else keeps the useful
   * classification the launcher's, not ours - the reason is real (and redacted downstream), because
   * "the path is illegal" and "the file is corrupt" are different answers to the caller.
   */
  #reject(type: string, error: unknown): HostError {
    if (error instanceof HostError) {
      if (error.code === ERROR_CODES.invalid_input) this.#context.registry.noteRejectedCommand()
      return error
    }
    const reason = error instanceof Error ? error.message : String(error)
    return invalidInput(`The ${type} command failed: ${reason}`)
  }

  #health(): Record<string, unknown> {
    const registry = this.#context.registry
    return {
      ready: this.#context.ready(),
      uptimeMs: this.#context.uptimeMs(),
      liveSessions: registry.size,
      acceptingSessions: this.#context.ready(),
      ...registry.counters,
      rssBytes: process.memoryUsage().rss,
      lspChildren: this.#context.sdk.lspClients(),
      mcpConnections: this.#context.sdk.connectedMcpServers().length,
      uiRequestTimeoutMs: this.#context.uiRequestTimeoutMs(),
      sessions: registry.summaries(),
    }
  }

  /**
   * Re-reads the model configuration, then answers with the catalogue it implies.
   *
   * This is the read a page asks for after it wrote `models.yml`, so it has to include the file
   * itself: `refresh` re-parses the static config when its mtime moved (the SDK gates that read)
   * and re-discovers the runtime catalogues from the local cache underneath it. The credential
   * hydration this used to run alone only rebuilt the latter from that same cache, so a provider,
   * a model or a `reasoning` flag added since the host booted stayed invisible until a restart —
   * exactly the "no hot reload" a user hits when they flip a switch on a custom model.
   */
  async #modelsReload(): Promise<Record<string, unknown>> {
    const started = performance.now()
    await this.#context.services.registry.refresh('offline')
    const models = this.#context.services.registry.getAvailable().map(model => modelSummary(model))
    // The catalogue has just been re-read, and a conversation that is already open is holding the
    // model object it was bound to — so an edit the reader made to a model's context information
    // reaches this point and no further unless the open sessions are put back on their models. The
    // count is reported rather than logged because it is the answer to "did my edit land here".
    const rebound = await this.#context.registry.rebindModels()
    return { models, reloadMs: Math.round((performance.now() - started) * 10) / 10, rebound }
  }

  /** The role a role command addresses: a non-empty string, and nothing else. */
  #role(frame: Record<string, unknown>): string {
    const role = frame.role
    if (typeof role !== 'string' || role.trim() === '') throw invalidInput('A model role id is required.')
    return role.trim()
  }

  /** The selector a role write carries; absent, `null` and `''` all mean "clear this role". */
  #selector(frame: Record<string, unknown>): string | null {
    const selector = frame.selector
    if (selector === undefined || selector === null) return null
    if (typeof selector !== 'string') throw invalidInput('A model selector must be a string or null.')
    const trimmed = selector.trim()
    return trimmed === '' ? null : trimmed
  }

  #ok(id: string | null, data: Record<string, unknown>): void {
    this.#context.writer.send({ type: 'response', id, success: true, data })
  }

  #fail(frame: Record<string, unknown>, error: HostError): void {
    const id = typeof frame.id === 'string' ? frame.id : null
    this.#context.writer.send({
      type: 'response',
      id,
      success: false,
      // Every failure text is redacted here, whichever layer produced it (contract §2.8).
      error: sanitizeMessage(error.message),
      code: error.code,
    })
  }
}
