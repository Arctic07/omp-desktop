import { AlertCircle, AlertTriangle, Info, Plus, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Alert, AlertContent, AlertDescription, AlertIcon } from "@/components/motion/alert";
import { Button } from "@/components/motion/button";
import { Tooltip } from "@/components/motion/tooltip";
import type { ComposerFieldHandle } from "@/components/agents/composer-field";
import {
  PromptInput,
  type PromptModel,
  type PromptSubmitGesture,
} from "@/components/agents/prompt-input";
import { chooseFiles } from "@/api/dialog";
import { toApiError, type ApiError } from "@/api/client";
import { useCopy } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { COPY } from "@/home/homeCopy";
import type { SessionModes } from "@/api/session-types";

/** No modes, as the constant the strip reads between state frames. */
const NO_MODES: SessionModes = {};
import { ConversationBlocks } from "@/home/ConversationBlocks";
import { ModeBar } from "@/home/ModeBar";
import { ConversationDialogs } from "@/home/ConversationDialogs";
import { ConversationStall } from "@/home/ConversationStall";
import { reclaimSession } from "@/state/session-stall";
import { STOP_LEFT_WORK } from "@/state/session-send";
import {
  attachmentFailure,
  composerLevel,
  composerThinkingLevels,
  contextUsageOf,
  failureNotice as makeFailureNotice,
  selectActiveId,
  selectDialogs,
  selectDraftKey,
  selectDroppingOver,
  selectFileDroppingOver,
  selectNotices,
  selectRecordFile,
  selectRecordWorkspaceId,
  selectRuntime,
  selectStopPending,
  selectStoppable,
  selectStreaming,
  type ComposerFailure,
} from "@/home/composer-readings";
import { conversationPhase } from "@/home/conversation-phase";
import { namedModel } from "@/home/composer-model";
import { useComposerPicks } from "@/home/composer-picks";
import { ComposerQueue } from "@/home/ComposerQueue";
import { openSubagentConversation } from "@/state/panel-store";
import {
  addAttachmentPaths,
  addClipboardFiles,
  MAX_COMPOSER_ATTACHMENTS,
  pruneAttachments,
  removeAttachment,
  type AttachmentRefusal,
} from "@/state/composer-attachments";
import {
  attachmentRefs,
  draftAttachments,
  draftFromMessage,
  draftProse,
  type ComposerAttachment,
} from "@/state/composer-draft";
import {
  appendComposerDraftChips,
  carryComposerDraft,
  composerDraftOf,
  composerDraftsStore,
  conversationDraftKey,
  forgetComposerDraft,
  isNewConversationDraftKey,
  NO_CONVERSATION_DRAFT_KEY,
  putComposerDraft,
  setComposerDraftText,
} from "@/state/composer-draft-store";
import { composerFocusStore } from "@/state/composer-prefill";
import { composerHistory, stepHistoryWalk, type ComposerHistoryEntry, type HistoryWalk } from "@/home/composer-history";
import { withDesktopUiCommands } from "@/home/composer-commands";
import {
  desktopDropStore,
  setDesktopDropTarget,
} from "@/state/desktop-drop";
import {
  fileDragStore,
  setFileDragTarget,
} from "@/state/file-drag-store";
import {
  abortTurn,
  answerDialog,
  interruptQueuedPrompt,
  sendPrompt,
  sessionStore,
  startNewSession,
} from "@/state/session-store";
import { loadModels, modelStore, providerLabel, providerNameIndex } from "@/state/model-store";
import { useAppSetting } from "@/state/app-settings";
import {
  enqueuePromptFor,
  MAX_QUEUED_PROMPTS,
  promptQueueStore,
  queuedPromptsFor,
  removeQueuedPrompt,
  resolveSubmitMode,
} from "@/state/prompt-queue-store";
import { useStore, useStoreSelector } from "@/state/store";
import { workspaceStore } from "@/state/workspace-store";

/** The composer's own field, so the rail's "Focus composer" action has something to focus. */
export const COMPOSER_ID = "chat-home-composer";

const NOTICE_ICON = {
  info: Info,
  warning: AlertTriangle,
  error: AlertCircle,
} as const;

export interface ConversationComposerProps {
  /** Focus target, so the rail's "Focus composer" action has something to focus. */
  id?: string;
  className?: string;
}

/**
 * The foot of the conversation column: what the engine is asking, what it plans to do, and the
 * field the next prompt goes in.
 *
 * Read straight from the stores rather than threaded through the shell: these are the conversation's
 * own facts, and the shell has no use for them. What it reads is the conversation on screen — the
 * record the session store holds for it — so a conversation the reader is not looking at can stream
 * in the background without redrawing the field they are typing in.
 */
export function ConversationComposer({ id, className }: ConversationComposerProps) {
  const copy = useCopy(COPY);
  /**
   * The conversation's own facts, each read on its own.
   *
   * Deliberately not the whole record: a streamed token replaces the record on every frame, and a
   * composer subscribed to it re-rendered with it — rebuilding the prompt history (a walk over
   * every message) and re-rendering the field, the model picker and the queue for each frame of
   * any conversation on screen. These selectors return the values they name; the record's
   * transcript is read where it is needed instead (the Up walk below).
   */
  const sessionId = useStoreSelector(sessionStore, selectActiveId);
  const runtime = useStoreSelector(sessionStore, selectRuntime);
  /**
   * Which screen is on: the hero (no conversation), a conversation, or one still being read.
   *
   * The model and thinking controls are pointed by this, not by `sessionId` alone: a conversation
   * the reader has clicked is on screen before the host has its id (`selectActiveId` is null for the
   * length of the open), and a pick made in that window must not be read as "no conversation" —
   * that is the state in which it used to edit the engine's `default` role instead, leaving the
   * conversation on the model it started with while the field showed the new one.
   */
  const phase = useStoreSelector(sessionStore, conversationPhase);
  // One object per state frame, so the strip's own reads stay stable between frames.
  const modes = runtime?.modes ?? NO_MODES;
  const running = useStoreSelector(sessionStore, selectStreaming);
  const stoppable = useStoreSelector(sessionStore, selectStoppable);
  const stopPending = useStoreSelector(sessionStore, selectStopPending);
  const notices = useStoreSelector(sessionStore, selectNotices);
  const dialogs = useStoreSelector(sessionStore, selectDialogs);
  const recordFile = useStoreSelector(sessionStore, selectRecordFile);
  const recordWorkspaceId = useStoreSelector(sessionStore, selectRecordWorkspaceId);
  /**
   * The detached subagents above the field open their own conversation beside this one, the same
   * way a `task` call's roster rows do. The tab belongs to this conversation and the child is
   * resolved against its file, so the composer is where the active conversation is known.
   */
  const openSubagent = useCallback(
    (childId: string, label: string) => {
      if (sessionId === null) return;
      openSubagentConversation(sessionId, recordFile, childId, label);
    },
    [recordFile, sessionId],
  );
  const models = useStore(modelStore);
  const [busyBehavior] = useAppSetting("busyBehavior");
  /**
   * The draft the box is showing, one per conversation (`state/composer-draft-store.ts`).
   *
   * The seat follows the conversation on screen, but a switch through "nothing open yet" keeps the
   * seat it had: the box only moves when there is a conversation to move to, so opening a
   * conversation from disk does not blank the reader's words for a frame. Which seats hand over to
   * each other — and which stay apart — is decided by the two effects below the conversation id.
   */
  const sessionDraftKey = useStoreSelector(sessionStore, selectDraftKey);
  const [draftKey, setDraftKey] = useState(sessionDraftKey);
  /** The same seat for a handler that finishes after an await, when the box may have moved. */
  const draftKeyRef = useRef(draftKey);
  /**
   * The session a blank conversation's seat stood for, while that seat is on screen.
   *
   * A blank conversation stops being blank when its first message arrives; the hand-over from the
   * workspace's blank seat to that conversation's session id carries what was typed meanwhile. Moving
   * from the blank seat to *another* conversation carries nothing, which is what keeps the drafts
   * apart.
   */
  const newSeatSession = useRef<string | null>(null);
  const drafts = useStore(composerDraftsStore);
  const draft = composerDraftOf(drafts, draftKey);
  const input = draft.text;
  const held = draft.attachments;
  /** The Up/Down walk through earlier prompts, and the draft it is standing in front of. */
  const historyRef = useRef<HistoryWalk | null>(null);
  const [dismissed, setDismissed] = useState<readonly number[]>([]);
  /**
   * A write or an import the composer could not carry out, with the conversation it was made in.
   *
   * The conversation is part of it because a failure belongs to the session it happened in: what the
   * engine refused for one is not a fact about the next, and carrying the line across would report a
   * failure that never happened. Comparing on read is what keeps this out of an effect. The notice
   * row itself — id included — is made where the failure happens rather than on every render, which
   * is what lets the reader dismiss it and have it stay dismissed.
   */
  const [failure, setFailure] = useState<ComposerFailure | null>(null);
  const fail = useCallback((error: ApiError, session: string | null) => {
    setFailure({ sessionId: session, notice: makeFailureNotice(error) });
  }, []);

  useEffect(() => {
    if (models.status === "idle") void loadModels();
  }, [models.status]);

  /** The field itself, so an import can put its chips where the reader was. */
  const field = useRef<ComposerFieldHandle>(null);
  /**
   * Focus for a draft another surface wrote.
   *
   * The hand-off itself is a write into the conversation's seat (`state/composer-prefill.ts`), so
   * there is no text to place here — only the caret, and only once per request. The field focuses
   * after the paint that holds the text, and again after the overlay that asked for it settles: the
   * prefill is usually the second half of leaving the settings page, whose close can take the focus
   * back a frame later.
   */
  const focusRequests = useStore(composerFocusStore);
  useEffect(() => {
    if (focusRequests === 0) return;
    historyRef.current = null;
    field.current?.focus();
    const painted = requestAnimationFrame(() => field.current?.focus());
    const settled = window.setTimeout(() => field.current?.focus(), 140);
    return () => {
      cancelAnimationFrame(painted);
      window.clearTimeout(settled);
    };
  }, [focusRequests]);
  /**
   * The conversation as the last commit saw it, for a handler that finishes after an await.
   *
   * An import is a round trip through the desktop and the reader can switch conversations in the
   * middle of it: the files it produced are the conversation it started in, and their chips belong
   * to that draft rather than to whatever is on screen when the answer lands.
   */
  const sessionRef = useRef<string | null>(null);

  /**
   * A refusal in this app's own words, on the notice line.
   *
   * The two refusals this side can name are a folder where an attachment has to be a file and a
   * paste past the desktop's own budget; anything else the desktop said travels as it stands, which
   * is what `attachmentFailure` decides.
   */
  const reportRefusal = useCallback(
    (refusal: AttachmentRefusal | null, session: string | null) => {
      if (refusal === null) return;
      fail(attachmentFailure(refusal, copy), session);
    },
    [copy, fail],
  );

  /**
   * Three readings of the conversation on screen, kept apart because they answer different questions.
   *
   * `running` is the turn, and it is what a submission's mode follows. `stoppable` is the agent still
   * answering — the turn, or a child it spawned that this host can still cancel — and it is what the
   * send/stop pair is drawn on: a detached batch keeps working after its turn ends, and an empty box
   * over it has nothing to send, so the stop is the only honest thing for that button to be. A plain
   * background job is not part of it: a dev server outlives the answer by hours, and a field left
   * wearing the stop for one reads as a conversation that never finished. Those jobs are named in the
   * conversation's own background block, where each row carries the stop that ends it (`state/
   * work-readings.ts::isStoppable`). `hasDraft` is the box. The first two are their own selectors
   * above, so a streamed token does not redraw this component.
   */

  /** What each provider is called: the picker groups by it and the field names the open model with it. */
  const providerNames = useMemo(() => providerNameIndex(models.providers), [models.providers]);

  const modelOptions = useMemo<PromptModel[]>(
    () =>
      models.models.map((model) => ({
        value: `${model.provider}/${model.id}`,
        // The provider is stated once, above the models that belong to it. Written on every row it
        // would be the engine's generated key for the provider (`custom-ba937c28`), repeated.
        group: providerLabel(providerNames, model.provider),
        label: model.name || model.id,
      })),
    [models.models, providerNames],
  );

  const currentModel = useMemo(() => {
    if (runtime === null || runtime.modelProvider === null || runtime.modelId === null) {
      return null;
    }
    const selector = `${runtime.modelProvider}/${runtime.modelId}`;
    // A conversation can be running on a provider this app does not offer — the engine resolves its
    // own roles, and one of them is a pass this application deliberately hides. The field says
    // nothing about that model rather than naming one the reader cannot pick, and the two controls
    // below follow the same reading: no model to name, no model to pin a level to.
    return models.models.some((model) => `${model.provider}/${model.id}` === selector)
      ? selector
      : null;
  }, [models.models, runtime]);

  /**
   * What the composer names before the session reports a model of its own.
   *
   * The engine's `default` role is what decides which model a new conversation starts on, so that is
   * what stands in — not the catalogue's first entry, which is how a conversation this app started
   * came up on a provider its settings do not offer. A role the catalogue no longer carries (one
   * this app hides, say) is left to the field's own default rather than named as if it were offered.
   */
  const defaultModel = useMemo(() => {
    const resolved = models.roles.find((role) => role.id === "default")?.model ?? null;
    if (resolved === null) return undefined;
    const selector = `${resolved.provider}/${resolved.id}`;
    return models.models.some((model) => `${model.provider}/${model.id}` === selector)
      ? selector
      : undefined;
  }, [models.models, models.roles]);

  /**
   * What the composer shows before the open conversation reports its own level.
   *
   * A new conversation starts on the engine's `default` role, so the level pinned there in the
   * model settings is the one it will run at. Nothing is remembered from a previous conversation:
   * a level chosen inside one belongs to that conversation, not to the next one.
   */
  const defaultThinkingLevel = useMemo(
    () => composerLevel(models.roles.find((role) => role.id === "default")?.thinkingLevel ?? null),
    [models.roles],
  );

  useEffect(() => {
    sessionRef.current = sessionId;
    // The prompts a walk was made of belong to the conversation it started in.
    historyRef.current = null;
  }, [sessionId]);
  /**
   * Hands the box on when there is a seat to hand it to.
   *
   * The seat read from the store is empty while a conversation is being opened; that is not a move,
   * so the box keeps the seat it has until the conversation arrives. Two moves carry a draft with
   * them, and only two: the seat before any workspace opened, and a blank conversation's seat once
   * its first message turns it into a real one (the words typed while that message was on its way
   * are still the reader's). Anything else is a switch, and a switch shows the other conversation's
   * own draft and nothing of this one's.
   */
  useLayoutEffect(() => {
    if (sessionDraftKey === NO_CONVERSATION_DRAFT_KEY || sessionDraftKey === draftKey) return;
    const handsOver =
      draftKey === NO_CONVERSATION_DRAFT_KEY ||
      (isNewConversationDraftKey(draftKey) && newSeatSession.current === sessionDraftKey);
    if (handsOver) carryComposerDraft(draftKey, sessionDraftKey);
    draftKeyRef.current = sessionDraftKey;
    setDraftKey(sessionDraftKey);
  }, [draftKey, sessionDraftKey]);

  /**
   * Remembers which session a blank seat is standing for.
   *
   * Declared after the hand-over above, which reads the id this held for the seat being left: in the
   * commit that moves the box, `sessionId` is already the conversation being moved to, and writing it
   * here first would make every switch look like the blank seat's own hand-over.
   */
  useLayoutEffect(() => {
    newSeatSession.current = isNewConversationDraftKey(draftKey) ? sessionId : null;
  }, [draftKey, sessionId]);

  const queued = queuedPromptsFor(useStore(promptQueueStore), sessionId);
  const workspaces = useStore(workspaceStore);
  /**
   * The files this prompt will actually carry: the ones its draft still names, in the order it names
   * them.
   *
   * Read from the draft rather than from the store, because the two can differ for a moment — a
   * record the reader backspaced out of the sentence is one the store has not been told about yet —
   * and the sentence is what the reader is looking at. It is also the order the engine gets: the
   * first file in the prompt is the first one the reader dropped into it.
   */
  const attachments = useMemo(() => draftAttachments(input, held), [held, input]);
  /**
   * Whether the field is holding something to send: words, or a file among them.
   *
   * A file the reader attached and nothing typed is a prompt — the engine takes an empty text beside
   * attachments — so the field's own "nothing typed is nothing to send" rule is relaxed for exactly
   * that case (`PromptInput`'s `allowEmptySubmit`), and the send/stop reading below agrees with it.
   */
  const hasDraft = draftProse(input).trim().length > 0 || attachments.length > 0;
  const failureNotice =
    failure !== null && failure.sessionId === sessionId ? failure.notice : null;

  /**
   * Put one earlier prompt into the field, files and all.
   *
   * The message's own words carry the files' characters, so the draft is rebuilt with fresh tokens
   * and the records that answer them (`draftFromMessage`) — the same reading a rewind restores. The
   * field's list is replaced rather than added to: what the box shows is exactly what this prompt
   * carried, and a file the previous step was holding must not travel with it.
   */
  const recallEntry = useCallback(
    (entry: ComposerHistoryEntry) => {
      const restored = draftFromMessage(entry.text, entry.attachments, MAX_COMPOSER_ATTACHMENTS);
      putComposerDraft(draftKey, restored.text, restored.attachments);
    },
    [draftKey],
  );

  /**
   * One Up or Down, when the composer owns that key.
   *
   * The gate is the one a terminal's history uses: a walk only starts from an empty box, and once
   * it is running both arrows belong to it until the reader edits the draft or walks back past the
   * newest prompt — which restores the draft the walk replaced. At the oldest prompt Up is consumed
   * and does nothing; the caret does not jump into the middle of a recalled prompt.
   *
   * The prompts are read from the store at the moment of the key press, not derived on every
   * render: the walk is a scan of the conversation's messages, and a composer that rebuilt it for
   * every streamed token spent the frame budget on a list only an arrow key ever reads.
   */
  const stepHistory = useCallback(
    (direction: "up" | "down"): boolean => {
      const messages =
        sessionId === null ? [] : (sessionStore.get().records[sessionId]?.messages ?? []);
      const step = stepHistoryWalk(historyRef.current, composerHistory(messages), direction, {
        text: input,
        records: draftAttachments(input, held),
      });
      if (step.kind === "ignore") return false;
      if (step.kind === "show") {
        historyRef.current = step.walk;
        recallEntry(step.entry);
      } else if (step.kind === "restore") {
        historyRef.current = null;
        putComposerDraft(draftKey, step.saved.text, step.saved.records);
      }
      return true;
    },
    [draftKey, held, input, recallEntry, sessionId],
  );

  /** The reader's own edit ends the walk: from here the draft is theirs, and Up is the caret's. */
  const endHistoryWalk = useCallback(() => {
    historyRef.current = null;
  }, []);

  /**
   * The conversation's own notices, and — when a write or an import failed — that failure as one more
   * row of the same list: the reader is already looking here, and a second surface beside the list
   * would be a second place to look for the same answer.
   */
  const shownNotices = [...notices, ...(failureNotice === null ? [] : [failureNotice])].filter(
    (notice) => !dismissed.includes(notice.id),
  );

  /**
   * The folder the file picker opens at: the workspace the conversation on screen belongs to.
   *
   * A file picked for a project should start in that project, and the workspace is where the engine
   * will read it from. With no conversation open the active workspace is the one the next prompt goes
   * to, which is the same answer the model control gives in that state.
   */
  const workspaceRoot = useMemo(() => {
    const workspaceId = recordWorkspaceId ?? workspaces.activeId;
    return workspaces.items.find((item) => item.id === workspaceId)?.rootPath;
  }, [recordWorkspaceId, workspaces]);

  /**
   * Put an import's chips where they belong.
   *
   * Still looking at the draft they were imported for: the chips land at the caret the reader left
   * (`insertChips`). Moved on: the import still belongs to the draft it started in, so the characters
   * go on the end of that draft instead of being typed into the box now on screen — the two
   * conversations keep their own words and their own files.
   */
  const placeChips = useCallback(
    (key: string, records: readonly ComposerAttachment[], pasteId?: number) => {
      if (records.length === 0) {
        if (draftKeyRef.current === key) field.current?.insertChips(records, pasteId);
        return;
      }
      if (draftKeyRef.current === key) {
        field.current?.insertChips(records, pasteId);
        return;
      }
      appendComposerDraftChips(key, records.map((record) => record.token).join(""));
    },
    [],
  );

  /**
   * Take files into this prompt, from the picker, a paste or a drop.
   *
   * The anchor is taken *before* the import — by the caller, or by the field's own paste — because
   * the import is a round trip through the desktop and the reader's caret moves meanwhile. A drop
   * keeps the caret it was anchored at too: the release point is not where the reader was writing.
   * A refusal is the desktop's answer rather than something this side decided, and it belongs on the
   * notice line, where the reader is already looking.
   */
  const attachPaths = useCallback(
    async (paths: readonly string[], pasteId?: number) => {
      const key = draftKey;
      const imported = await addAttachmentPaths(key, paths);
      reportRefusal(imported.refusal, sessionRef.current);
      placeChips(key, imported.added, pasteId);
    },
    [draftKey, placeChips, reportRefusal],
  );

  /** Files pasted into the field: bytes the clipboard holds, which the desktop stages for us. */
  const attachFiles = useCallback(
    async (files: readonly File[], pasteId?: number) => {
      const key = draftKey;
      const imported = await addClipboardFiles(key, sessionRef.current, files);
      reportRefusal(imported.refusal, sessionRef.current);
      placeChips(key, imported.added, pasteId);
    },
    [draftKey, placeChips, reportRefusal],
  );

  /** The ➕: the desktop's own picker, opened in the workspace the conversation belongs to. */
  const pickFiles = useCallback(async () => {
    // Where the chips will land is where the reader left the caret, which the picker's own window
    // takes the focus away from.
    field.current?.captureAnchor();
    let picked: string[] = [];
    try {
      picked = await chooseFiles(copy.chooseFiles, workspaceRoot);
    } catch (error) {
      fail(toApiError(error), sessionRef.current);
      return;
    }
    if (picked.length > 0) await attachPaths(picked);
  }, [attachPaths, copy.chooseFiles, fail, workspaceRoot]);

  /**
   * The level the composer's slider stands at.
   *
   * A conversation that has reported one is showing what the engine will run at, which is the only
   * reading that can be trusted while it is open. Before that — and with no conversation at all —
   * the engine's `default` role answers, because its pinned level is what a new conversation starts
   * on. A level chosen inside one conversation is never read here: it belongs to that conversation.
   */
  const thinkingLevel =
    runtime?.thinkingLevel != null
      ? composerLevel(runtime.thinkingLevel)
      : defaultThinkingLevel;

  /** The engine's own context accounting, rebuilt only when the snapshot it is read from changes. */
  const contextUsage = useMemo(() => contextUsageOf(runtime), [runtime]);
  // What a leading slash can choose: the engine's advertisement plus `/new`, whose body is this
  // column's own navigation.
  const commands = useMemo(
    () => withDesktopUiCommands(runtime?.commands ?? []),
    [runtime?.commands],
  );

  /**
   * The model and thinking controls: both write to the conversation on screen, and only the hero
   * screen has none to write — see `home/composer-picks.ts`, which owns the decision and the pick it
   * holds while a conversation is opening.
   */
  const picks = useComposerPicks({
    sessionId,
    phase,
    defaultModel,
    begin: useCallback(() => setFailure(null), []),
    fail,
  });

  /**
   * The model the field names: this conversation's own, never the engine's default role (see
   * `home/composer-model.ts::namedModel`, which is where that rule is decided and tested).
   */
  const fieldModel = namedModel({
    current: currentModel,
    pending: picks.pending?.model ?? null,
    phase,
    defaultModel: defaultModel ?? null,
  });

  /**
   * The levels the field offers for that model: the conversation's report, or — before it has one —
   * the catalogue's entry for the same model (`composerThinkingLevels`, which owns the rule).
   */
  const fieldThinkingLevels = composerThinkingLevels(
    runtime?.thinkingLevels,
    fieldModel,
    models.models,
  );

  /**
   * Send, hold, or join the running turn.
   *
   * The chord decides the mode against the turn and the reader's preference (`resolveSubmitMode`):
   * plain Enter means holding the message until the turn ends, or interrupting it, and the Ctrl/Cmd
   * chord means the other one. With nothing running both are a plain prompt. A message the queue
   * refused stays in the field, because a composer that swallowed it would be worse than one that
   * kept it.
   *
   * Nothing is sent with no model named: a prompt the reader cannot say the model of is one the
   * engine would answer with its own resolution, and the field's disabled send control is this same
   * rule made visible (`sendLocked` below).
   */
  const submit = useCallback(
    async (gesture: PromptSubmitGesture) => {
      // The prompt is the draft itself: the reader's words with the files' own characters still in
      // them. A sent message is read back as the draft it was written as — the character is where the
      // file stands in the sentence, and pairing the two by position is what makes a reopened
      // conversation draw the file where the reader put it (`state/composer-draft.ts::
      // messageSegments`) — while the paths the engine reads the files from are appended by the host
      // as its own `@<path>` lines.
      const text = input.trim();
      // `/new` is this application's own navigation (the engine implements it only for its
      // terminal): open the workspace's blank conversation and switch to it. The draft is not sent
      // anywhere, and it belongs to the conversation being left.
      if (text === "/new") {
        historyRef.current = null;
        forgetComposerDraft(draftKey);
        void startNewSession();
        return;
      }
      if (
        (draftProse(text).trim().length === 0 && attachments.length === 0) ||
        sessionId === null ||
        fieldModel === null
      ) {
        return;
      }
      // The words and the conversation must be the same one. While a switch is in flight the box
      // follows the reader's click (the opener's pin), but a workspace switch may briefly put the
      // workspace's own newest conversation on screen first; sending from here would deliver this
      // draft to that conversation. The draft's own seat is the test, not the name on screen.
      const active = sessionStore.get().records[sessionId];
      if (active === undefined || conversationDraftKey(active) !== draftKey) return;
      // The files travel with the words: the row this makes in the transcript names them, and a
      // queued message keeps them until its own turn comes (`QueuedPrompt.attachments`).
      const files = attachmentRefs(attachments);
      // A stop this side has asked for is still on its way: the turn is aborting, so a prompt sent
      // into it now would race the abort and be refused as busy (a second error line on top of the
      // stop the reader just pressed). While the stop is in flight the message waits for the turn's
      // end instead, which is the same rule `resolveSubmitMode(running)` follows.
      const mode = running && stopPending ? "queue" : resolveSubmitMode(busyBehavior, running, gesture);
      if (mode === "queue") {
        if (enqueuePromptFor(sessionId, text, files)) {
          historyRef.current = null;
          // The draft was the message: the seat is empty once it is on its way, and a conversation
          // that has its own words half-written behind this one keeps them.
          forgetComposerDraft(draftKey);
        } else {
          // The queue has its own ceiling; a press that cannot queue has to say so, or the field
          // looks deaf (the text stays, which is the one thing it can keep).
          fail({ code: "prompt_queue_full", message: copy.queueFull(MAX_QUEUED_PROMPTS) }, sessionId);
        }
        return;
      }
      historyRef.current = null;
      // The draft is the message from here on. For a blank conversation the seat changes when the
      // first row arrives; anything typed in between is carried with it (`state/composer-draft-store.ts::
      // carryComposerDraft`).
      forgetComposerDraft(draftKey);
      await sendPrompt(text, files, mode === "steer" ? "steer" : null);
    },
    [attachments, draftKey, running, stopPending, busyBehavior, input, fieldModel, sessionId, copy, fail],
  );

  /**
   * The draft as the field now holds it, and the records that go with it.
   *
   * A chip the reader backspaced out of the sentence is a file they took out of the prompt, so the
   * record goes with the character — read from the draft rather than from the ✕ alone, because the
   * ✕ is only one of the ways a chip can leave.
   */
  const changeDraft = useCallback(
    (next: string) => {
      setComposerDraftText(draftKey, next);
      pruneAttachments(draftKey, next);
    },
    [draftKey],
  );

  /**
   * What a press on the send control is about to do, in the reader's own words.
   *
   * The control and plain Enter are one gesture, so it is named by the same rule the submission
   * follows: a queued message while a turn runs, one steered into it, and the field's own name for a
   * prompt when nothing is running to decide between them.
   */
  const plainSubmit = running && stopPending ? "queue" : resolveSubmitMode(busyBehavior, running, "enter");
  const sendLabel =
    plainSubmit === "steer" ? copy.sendSteer : plainSubmit === "queue" ? copy.sendQueue : undefined;

  /**
   * End the running turn so the pressed queued row goes out as the next one.
   *
   * Only a conversation has a queue to press, and the rows are only drawn while one is on screen —
   * the guard is what the type needs, not a state the reader can reach.
   */
  const interrupt = useCallback(
    (id: number) => {
      if (sessionId === null) return;
      void interruptQueuedPrompt(sessionId, id);
    },
    [sessionId],
  );

  /**
   * The field's own box, as the surface an OS drop is released on.
   *
   * `contains` reads the box's own rectangle on every move of a drag, because the drop face is drawn
   * on the surface the pointer is inside: a cached rectangle would keep lighting the field up after
   * the layout moved under it. A release anywhere else in the window attaches nothing — the drop is
   * the field's, not the screen's (`state/desktop-drop.ts`).
   *
   * A release that *is* the field's attaches at the **caret**, not under the pointer: the reader
   * dragged the file in from another window, so where the pointer crossed this one says nothing
   * about where they were writing — the caret they left is that place. The anchor is taken before
   * the import, which is a round trip through the desktop.
   */
  const dropBoxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const contains = (point: { x: number; y: number }) => {
      const box = dropBoxRef.current?.getBoundingClientRect();
      if (box === undefined) return false;
      return (
        point.x >= box.left && point.x <= box.right && point.y >= box.top && point.y <= box.bottom
      );
    };
    setDesktopDropTarget({
      contains,
      accept: (paths) => {
        field.current?.captureAnchor();
        void attachPaths(paths);
      },
    });
    // The same box is the target of a drag that started inside the app (the file tree); HTML5
    // drag-and-drop cannot cross that boundary while Tauri's own file drop is enabled, so the tree
    // reports the release here through `state/file-drag-store.ts`. The same caret decides where the
    // file lands, for the same reason.
    setFileDragTarget({
      contains,
      accept: (payload) => {
        field.current?.captureAnchor();
        void attachPaths([payload.path]);
      },
    });
    return () => {
      setDesktopDropTarget(null);
      setFileDragTarget(null);
    };
  }, [attachPaths]);

  const dropping = useStoreSelector(desktopDropStore, selectDroppingOver);
  const fileDropping = useStoreSelector(fileDragStore, selectFileDroppingOver);
  const dropActive = dropping || fileDropping;

  const answer = useCallback((requestId: string, response: Parameters<typeof answerDialog>[1]) => {
    void answerDialog(requestId, response);
  }, []);

  return (
    <div
      className={cn(
        "bg-pane p-3 omp-composer-frame",
        // The composer is a dock at the foot of the column in every state the column has: the room
        // above it is the body's (the transcript, or the hero's welcome), and the body is the flex
        // remainder. Nothing here reaches for `mt-auto`: an empty body still takes that room, so the
        // field is at the same height on the welcome screen as it is under a conversation.
        "shrink-0",
        className,
      )}
    >
      <div className="omp-composer-stack mx-auto flex max-w-(--omp-conversation-lane) min-w-0 flex-col gap-2.5">
        <ComposerQueue
          queued={queued}
          running={running && !stopPending}
          onInterrupt={interrupt}
          onRemove={removeQueuedPrompt}
        />

        {shownNotices.length > 0 ? (
          // Capped and scrollable: this stack sits above the field, inside a composer that never
          // shrinks, so an uncapped one grows past the bottom of the window and takes the field and
          // its stop control with it (2026-10-27, user report: a column of toasts and no way to press
          // the stop the toasts were about).
          <div className="flex max-h-40 min-w-0 flex-col gap-1.5 overflow-y-auto">
            {shownNotices.map((notice) => {
              const Icon = NOTICE_ICON[notice.level];
              return (
                <Alert
                  key={notice.id}
                  variant={
                    notice.level === "error"
                      ? "destructive"
                      : notice.level === "warning"
                        ? "warning"
                        : "info"
                  }
                  className="py-1.5 pr-1.5 pl-2.5 text-xs"
                  // The row's height is the dismiss button's (24px against the line's 19.5px), so
                  // the line only reads centred if every child centres in it.
                  contentClassName="items-center"
                >
                  <AlertIcon className="mt-0">
                    <Icon aria-hidden="true" className="size-3.5" />
                  </AlertIcon>
                  <AlertContent>
                    <AlertDescription className="text-xs">
                      {notice.code === "stop_found_nothing"
                        ? copy.stopFoundNothing
                        : notice.code === "stop_restored_prompts"
                          ? copy.restoredPrompts
                          : notice.code === "force_stopped"
                          ? copy.forceStopped
                          : notice.code === "stalled_reclaimed"
                            ? copy.stallReclaimed
                            : notice.code === "stalled_reclaim_failed"
                              ? copy.stallReclaimFailed(notice.message)
                              : notice.code === "force_stop_failed"
                                ? copy.forceStopFailed(notice.message)
                                : notice.message}
                    </AlertDescription>
                  </AlertContent>
                  {/* A stop that could not end everything is the one notice with something to do
                      about it: the forced stop takes the conversation's host session down, which is
                      what reaches a turn the engine is still inside. It is the reader's own press
                      here — the stall row's reclaim is the same act offered after a silence nobody
                      answered. */}
                  {notice.code === STOP_LEFT_WORK && sessionId !== null ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-6 shrink-0 px-2 text-xs"
                      onClick={() => void reclaimSession(sessionId, "reader")}
                    >
                      {copy.forceStop}
                    </Button>
                  ) : null}
                  <button
                    type="button"
                    aria-label={copy.cancel}
                    onClick={() => setDismissed((current) => [...current, notice.id])}
                    className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <X aria-hidden="true" className="size-3.5" />
                  </button>
                </Alert>
              );
            })}
          </div>
        ) : null}

        {/* The engine's plan and the work a turn detached, one pill each: a block the engine has not
            reported draws nothing at all, and one the reader opens draws its panel above the row, so
            the pills themselves stay on the field's own edge. */}
        <ConversationBlocks onOpenSubagent={openSubagent} />

        <ConversationStall sessionId={sessionId} />

        <ConversationDialogs dialogs={dialogs} sessionId={sessionId} onAnswer={answer} />

        {/* The field and its drop face. The face is drawn over the field's own box rather than on the
            screen: an OS drag is the field's to take, and a release anywhere else attaches nothing
            (`state/desktop-drop.ts`). */}
        <div ref={dropBoxRef} className="relative">
          <PromptInput
            id={id}
            value={input}
            onValueChange={changeDraft}
            // The files this prompt will carry, inside the field they will leave from: each one a chip
            // at the caret the reader was writing at, with the ✕ that takes it back out. They are the
            // field's own content rather than a row above it — part of the prompt being written, not
            // another block of what the engine is doing.
            attachments={attachments}
            // Undo is the field's own history; the records behind its chips are this side's, so a
            // chip the reader deleted comes back with the character that names it.
            onRestoreDraft={(draft, records) => putComposerDraft(draftKey, draft, records)}
            onRemoveAttachment={(token) => removeAttachment(draftKey, token)}
            onFiles={(files, pasteId) => void attachFiles(files, pasteId)}
            // A paste of a copy this page wrote names its files itself, so they are attached by
            // path — the reader's own file, not a second copy of its bytes.
            onPaths={(paths, pasteId) => void attachPaths(paths, pasteId)}
            onHistoryPrevious={() => stepHistory("up")}
            onHistoryNext={() => stepHistory("down")}
            onDraftEdited={endHistoryWalk}
            // Every slash command this conversation can run, as the engine advertises them: builtins,
            // the `/skill:<name>` command of each enabled skill, extensions, custom and file commands.
            // A leading slash lists them, and picking one writes it into the box.
            commands={commands}
            ref={field}
            removeLabel={(name) => `${copy.attachmentRemove}: ${name}`}
            // The primary is a Stop only when the box is empty: with a draft it stays the gesture plain
            // Enter is, and the stop moves to the control beside it (`onInterrupt`).
            loading={stoppable && !hasDraft}
            onStop={() => void abortTurn()}
            onInterrupt={stoppable && hasDraft ? () => void abortTurn() : undefined}
            stopPending={stopPending}
            stopPendingLabel={copy.stopPending}
            onSubmit={(_value, _model, _thinking, gesture) => void submit(gesture ?? "enter")}
            allowEmptySubmit={attachments.length > 0}
            sendLabel={sendLabel}
            minRows={2}
            // Two lines before it scrolls was too tight to read a paragraph of the prompt being
            // written (2026-10-27, user report): four lines, and the box still cannot push the
            // conversation off the screen.
            maxRows={4}
            placeholder={copy.composerPlaceholder}
            // The field's own ➕, at its bottom-left: the desktop's picker, opened in the workspace
            // this conversation belongs to.
            leadingAction={
              <Tooltip content={copy.addFiles}>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={copy.addFiles}
                  onClick={() => void pickFiles()}
                  className="size-8 rounded-full"
                >
                  <Plus aria-hidden="true" className="size-4" />
                </Button>
              </Tooltip>
            }
            modeBar={<ModeBar modes={modes} />}
            models={modelOptions}
            model={fieldModel ?? ""}
            defaultModel={defaultModel}
            onModelChange={picks.changeModel}
            thinkingLevel={thinkingLevel}
            thinkingLevels={fieldThinkingLevels}
            thinkingLocked={fieldModel === null}
            // Two reasons the primary is locked, and both are the same fact stated twice: there is no
            // model to name (a strength belongs to one), and there is nowhere to send to — with no
            // workspace open there is no conversation behind the box, and a prompt written into one
            // would be a prompt this app could not deliver (`submit` refuses it as well, because a
            // locked control is only the visible half of the rule).
            sendLocked={fieldModel === null || sessionId === null}
            onThinkingLevelChange={picks.changeThinking}
            contextUsage={contextUsage}
          />
          {dropActive ? (
            <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center rounded-2xl border-2 border-border bg-field/95">
              <span className="text-xs text-muted-foreground">{copy.dropFiles}</span>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
