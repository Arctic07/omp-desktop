"use client";
// beui.dev/components/agents/chat-app

import { ArrowUp, Check, ChevronDown, Plus, Square } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  Fragment,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
  type Ref,
} from "react";
import { Button } from "@/components/motion/button";
import { CommandMenu } from "@/components/agents/command-menu";
import {
  ComposerField,
  type ComposerFieldHandle,
  type ComposerPopupKey,
} from "@/components/agents/composer-field";
import { ContextGauge, type ContextGaugeUsage } from "@/components/agents/context-gauge";
import {
  PluginSlot,
  PluginSuggestionLine,
  acceptComposerSuggestion,
  dismissComposerSuggestion,
  usePluginSuggestions,
} from "@/components/plugins/plugin-slot";
import { InlineSlider } from "@/components/motion/range-slider-inline";
import {
  MorphPopover,
  MorphPopoverContent,
  MorphPopoverTrigger,
} from "@/components/motion/popover-morph";
import type { ComposerAttachment } from "@/state/composer-draft";
import type { EngineCommand } from "@/api/session-types";
import { commandDraft, commandQuery, matchCommands } from "@/home/composer-commands";
import { SPRING_SWAP } from "@/lib/ease";
import { useCopy, type Localized } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { thinkingLadder } from "@/lib/thinking-levels";

/** The composer's own wording: its field names and controls. */
interface PromptInputCopy {
  placeholder: string
  prompt: string
  addToPrompt: string
  chooseModel: string
  thinkingStrength: string
  stopGenerating: string
  sendPrompt: string
  /** The heading of the list a leading slash opens. */
  commands: string
  /** What that list calls a command an enabled skill registered. */
  skill: string
}

const COPY: Localized<PromptInputCopy> = {
  en: {
    placeholder: "Ask the agent to do something…",
    prompt: "Prompt",
    addToPrompt: "Add to prompt",
    chooseModel: "Choose model",
    thinkingStrength: "Thinking strength",
    stopGenerating: "Stop generating",
    sendPrompt: "Send prompt",
    commands: "Commands",
    skill: "Skill",
  },
  zh: {
    placeholder: "让智能体做点什么…",
    prompt: "提示词",
    addToPrompt: "添加到提示词",
    chooseModel: "选择模型",
    thinkingStrength: "思考强度",
    stopGenerating: "停止生成",
    sendPrompt: "发送",
    commands: "命令",
    skill: "技能",
  },
}

export interface PromptModel {
  value: string;
  /**
   * What this model belongs to, where a caller's list spans several of them.
   *
   * The menu states a group once, above the models that share it — a provider's own name, which is
   * what tells two of them apart. The trigger is left to the model itself: the group is the menu's
   * own structure, not part of a model's name.
   */
  group?: string;
  label: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
}

export interface PromptAction {
  value: string;
  label: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
}

/**
 * Which chord asked for the submitted prompt: plain Enter — which a press on the primary control is,
 * since it delivers exactly what Enter would — or its Ctrl/Cmd chord.
 */
export type PromptSubmitGesture = "enter" | "accelerated";

export interface PromptInputProps {
  /** The field's own id, for a caller that has something to point at it. */
  id?: string
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  /**
   * The files this prompt is carrying, as chips inside the field.
   *
   * They are the field's own content rather than a row above it: a file is part of the prompt being
   * written, and where it sits in the sentence is where it will be read (`state/composer-draft.ts`).
   */
  attachments?: readonly ComposerAttachment[];
  /**
   * The whole draft after an undo — its words and the records behind its chips.
   *
   * The field owns the undo history; the records are the caller's (`state/composer-draft-store.ts`),
   * so a chip that was deleted is only really back once this has written it there too.
   */
  onRestoreDraft: (draft: string, attachments: readonly ComposerAttachment[]) => void;
  onRemoveAttachment?: (token: string) => void;
  /** Files pasted into the field, which the caller imports and hands back as chips. */
  onFiles?: (files: readonly File[], pasteId?: number) => void;
  /**
   * Paths a pasted copy named itself — a copy this page wrote — which the caller attaches as files.
   *
   * The names are the reader's own, so a message copied and pasted back carries its files rather
   * than a second copy of their bytes (`lib/clipboard.ts::recallOwnCopy`). `pasteId` names the paste
   * whose import this is, so its chips can land where its own words were.
   */
  onPaths?: (paths: readonly string[], pasteId?: number) => void;
  /** Up/Down over earlier prompts; each answers whether it consumed the key. */
  onHistoryPrevious?: () => boolean;
  onHistoryNext?: () => boolean;
  /** The reader changed the draft (typed, pasted, removed a chip), not a programmatic paint. */
  onDraftEdited?: () => void;
  /** The ✕'s accessible name for one file. */
  removeLabel?: (name: string) => string;
  /**
   * The field's own API, for a caller that has to put chips where the reader is.
   *
   * An import is a round trip through the desktop, so the caller captures the spot before it starts
   * and writes the chips back into it afterwards — which it can only do through the field's handle.
   * This component is the other reader of that handle (it puts the caret back after a submission), so
   * it hands the caller the same three verbs rather than a second path to the field.
   */
  ref?: Ref<ComposerFieldHandle>;
  models?: PromptModel[];
  model?: string;
  defaultModel?: string;
  onModelChange?: (model: string) => void;
  thinkingLevel?: string;
  defaultThinkingLevel?: string;
  onThinkingLevelChange?: (level: string) => void;
  /**
   * The levels the open model offers, in the engine's own vocabulary.
   *
   * `auto` on its own is the engine saying the model has no controllable effort: the control then
   * says so instead of offering a ladder whose every choice would be discarded. Empty means the
   * session has not reported yet, and the full ladder stands in.
   */
  thinkingLevels?: readonly string[];
  /**
   * Whether there is no model to pin a level to.
   *
   * A conversation running on a model this app does not offer — or on no model at all — has no
   * effort ladder this field can honestly present: the ladder belongs to the model, and a control
   * that offered stops for a model the reader cannot see would write a strength onto a session whose
   * model is not the one on screen. Locked reads as disabled rather than as absent, so the reader can
   * see there is something there and what it is waiting for.
   */
  thinkingLocked?: boolean;
  /**
   * Whether there is no model for a prompt to run on.
   *
   * A prompt sent with no model this application can name would be answered by whatever the engine
   * has resolved on its own — a conversation whose model the reader cannot see, running at a strength
   * the field cannot state. So the field refuses it exactly as it refuses an empty one: the send
   * control is disabled and the gesture does nothing. The box itself stays editable, because writing
   * while deciding which model to use is what a reader does next.
   */
  sendLocked?: boolean;
  /**
   * Whether an empty box is still something to send.
   *
   * The field's own rule is that nothing typed is nothing to send, and that is right for a box with
   * only words in it. A caller holding something *beside* the text — a file the reader picked — has
   * a prompt to send with the box empty, so it says so here; the send control and the Enter gesture
   * then follow that answer instead of the text alone.
   */
  allowEmptySubmit?: boolean;
  actions?: PromptAction[];
  onAction?: (action: string) => void;
  /**
   * The slash commands this conversation can run, as the engine advertises them.
   *
   * A leading slash opens them (`home/composer-commands.ts` decides when the draft is asking), and
   * picking one writes it into the box instead of sending it: a command is the reader's sentence,
   * and the arguments it takes are theirs to finish. Skills arrive here as their own
   * `/skill:<name>` commands, so an enabled skill is one pick away rather than a remembered name.
   */
  commands?: readonly EngineCommand[];
  /** The engine's context accounting, or null before a conversation has reported one. */
  contextUsage?: ContextGaugeUsage | null;
  onSubmit?: (value: string, model?: string, thinkingLevel?: string, gesture?: PromptSubmitGesture) => void | Promise<void>;
  loading?: boolean;
  onStop?: () => void;
  /**
   * A stop that has already been asked for and is still on its way back.
   *
   * The host answers a stop only once the engine is idle, and that wait can be seconds. A control
   * that still takes presses in it turns one gesture into a queue of stops, each answered by work
   * that is already stopping (`state/session-send.ts::abortTurn`): the press is refused here and the
   * control says what it is waiting for.
   */
  stopPending?: boolean;
  /** What that wait is called (`home/homeCopy.ts`), for the control's own label. */
  stopPendingLabel?: string;
  /**
   * What a press on the primary control will do, in the reader's own words.
   *
   * The control and plain Enter are one gesture, and while a turn runs that gesture is either a
   * queued message or one steered into the turn — so the name comes from the caller, which is where
   * the reader's preference and the turn are read. Absent leaves the field's own name for a prompt.
   */
  sendLabel?: string;
  /**
   * A stop offered beside the primary control, for the case where the primary is a Send.
   *
   * A draft keeps the primary a Send — the control and plain Enter stay one gesture — so stopping a
   * run the reader is also typing into needs a control of its own. With an empty box the primary
   * carries the stop itself (`loading`), and this one is not drawn.
   */
  onInterrupt?: () => void;
  minRows?: number;
  maxRows?: number;
  leadingAction?: ReactNode;
  /**
   * The modes this conversation is in, as the field's own chips.
   *
   * They sit at the field's foot beside the model, because a mode is a fact about the whole
   * conversation that a reader needs while typing — not a control in the title bar they have to
   * look away for.
   */
  modeBar?: ReactNode;
  /** The field reads as disabled: it takes no focus, and nothing can be written into it. */
  disabled?: boolean;
  placeholder?: string;
  ariaLabel?: string;
  className?: string;
}

export function PromptInput({
  id,
  value,
  defaultValue = "",
  onValueChange,
  attachments = [],
  onRestoreDraft,
  onRemoveAttachment,
  onFiles,
  onPaths,
  onHistoryPrevious,
  onHistoryNext,
  onDraftEdited,
  removeLabel,
  ref,
  models = [],
  model,
  defaultModel,
  onModelChange,
  thinkingLevel,
  defaultThinkingLevel = "auto",
  onThinkingLevelChange,
  thinkingLevels,
  thinkingLocked = false,
  sendLocked = false,
  allowEmptySubmit = false,
  actions = [],
  onAction,
  commands = [],
  contextUsage = null,
  onSubmit,
  loading = false,
  onStop,
  stopPending = false,
  stopPendingLabel,
  sendLabel,
  onInterrupt,
  minRows = 2,
  maxRows = 8,
  leadingAction,
  modeBar,
  className,
  disabled = false,
  placeholder,
  ariaLabel,
}: PromptInputProps) {
  const copy = useCopy(COPY);
  /**
   * The plugin suggestion line above the field, when there is one.
   *
   * It is read here because the field's key gate is here: while a suggestion is showing, Tab is the
   * accept gesture and Escape folds it away — the same two keys the command list already owns, and
   * the field asks this component before the caret sees either (`onPopupKey`).
   */
  const suggestions = usePluginSuggestions();
  const resolvedPlaceholder = placeholder ?? copy.placeholder;
  const resolvedAriaLabel = ariaLabel ?? copy.prompt;
  const reduce = useReducedMotion() ?? false;
  const field = useRef<ComposerFieldHandle>(null);
  /**
   * One field, two readers of its handle: the caller's, which writes imported chips where the reader
   * is, and this component's own, which puts the caret back after a submission.
   */
  useImperativeHandle(
    ref,
    () => ({
      captureAnchor: () => field.current?.captureAnchor(),
      insertChips: (records, pasteId) => field.current?.insertChips(records, pasteId),
      focus: () => field.current?.focus(),
    }),
    [],
  );
  const [internalValue, setInternalValue] = useState(defaultValue);
  const [internalModel, setInternalModel] = useState(
    defaultModel ?? models[0]?.value,
  );
  const [internalThinkingLevel, setInternalThinkingLevel] = useState(defaultThinkingLevel);
  const [actionsOpen, setActionsOpen] = useState(false);
  const modelRadioGroupName = useId();
  const currentValue = value ?? internalValue;
  const currentModelValue = model ?? internalModel;
  const currentThinkingLevel = thinkingLevel ?? internalThinkingLevel;
  // What the control draws: `undefined` (the session has not reported yet) stands on the full
  // ladder, an empty report is a model with no strength to choose, and a real report is re-laid on
  // the ladder's order (`off` at the floor, `auto` one above it) — all three rules live in
  // `lib/thinking-levels.ts`, beside the ladder itself.
  const thinkingOptions = thinkingLadder(thinkingLevels);
  /**
   * Whether this model has a strength to choose at all.
   *
   * An empty ladder is the model's own answer that it cannot think: the slider, the chip's level and
   * the strength in the trigger's name all go away rather than showing `off` as one more stop a
   * reader might try to raise (2026-10-29, user report).
   */
  const showThinking = thinkingOptions.length > 0;
  const canChooseThinking = thinkingOptions.length > 1 && !thinkingLocked;
  const currentThinkingIndex = Math.max(
    0,
    thinkingOptions.indexOf(currentThinkingLevel),
  );
  const currentModel = models.find(
    (option) => option.value === currentModelValue,
  );
  const canSubmit =
    (Boolean(currentValue.trim()) || allowEmptySubmit) && !disabled && !loading && !sendLocked;

  /**
   * The command list a leading slash opens.
   *
   * The query is the draft itself: only a draft that is one command word asks (`commandQuery`).
   * `dismissed` is what Escape folded away — the list stays closed for that exact draft and the
   * next edit brings it back — and `nav` is the row the keyboard walked to, kept with the query it
   * was walked on so a longer list's row number cannot leak into a shorter one's selection.
   */
  const query = commandQuery(currentValue);
  const matches = useMemo(
    () => (query === null ? [] : matchCommands(commands, query)),
    [commands, query],
  );
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [nav, setNav] = useState<{ query: string; index: number }>({ query: "", index: 0 });
  /** A list with nothing in it is not drawn: Enter then submits the draft exactly as it always did. */
  const menuOpen = query !== null && dismissed !== query && matches.length > 0;
  const activeIndex =
    menuOpen && nav.query === query ? Math.min(nav.index, matches.length - 1) : 0;

  const setValue = (next: string) => {
    if (value === undefined) setInternalValue(next);
    setDismissed(null);
    onValueChange?.(next);
  };

  /** Take one command out of the list: the box holds it, and its arguments are the reader's next. */
  const chooseCommand = (command: EngineCommand) => {
    setValue(commandDraft(command.name));
    field.current?.focus();
  };

  /**
   * What the field hands a list riding on it: arrows walk it, Enter or Tab takes the row, Escape
   * folds it away. `false` means no list is up, and the key is the caret's, the history's or the
   * submission's, exactly as it was before this existed.
   */
  const handlePopupKey = (key: ComposerPopupKey): boolean => {
    if (menuOpen) {
      if (key === "accept") {
        const chosen = matches[activeIndex];
        if (chosen === undefined) return false;
        chooseCommand(chosen);
        return true;
      }
      if (key === "dismiss") {
        setDismissed(query);
        return true;
      }
      const step = key === "previous" ? -1 : 1;
      setNav({ query: query ?? "", index: (activeIndex + step + matches.length) % matches.length });
      return true;
    }
    // A plugin suggestion is the other line above the field, and the same two keys: Tab accepts it
    // (its own `onAccept` runs, then it folds away) and Escape folds it away without accepting.
    // Arrows stay the caret's — a suggestion is one line, not a list to walk.
    if (suggestions.length === 0) return false;
    if (key === "accept") {
      acceptComposerSuggestion();
      return true;
    }
    if (key === "dismiss") {
      dismissComposerSuggestion();
      return true;
    }
    return false;
  };

  const setModel = (next: string) => {
    if (model === undefined) setInternalModel(next);
    onModelChange?.(next);
  };

  const setThinkingLevel = (next: string) => {
    if (thinkingLevel === undefined) setInternalThinkingLevel(next);
    onThinkingLevelChange?.(next);
  };

  const setThinkingLevelAtIndex = (index: number) => {
    const level = thinkingOptions[Math.round(index)];
    if (level !== undefined) setThinkingLevel(level);
  };

  const submit = (event?: FormEvent, gesture: PromptSubmitGesture = "enter") => {
    event?.preventDefault();
    const prompt = currentValue.trim();
    // A locked field does not submit by any road — the button, Enter, or a form gesture: the rule is
    // about what may reach the engine, and the disabled control is only that rule made visible.
    if ((!prompt && !allowEmptySubmit) || disabled || loading || sendLocked) return;

    onSubmit?.(prompt, currentModelValue, currentThinkingLevel, gesture);
    if (value === undefined) setInternalValue("");
    // The box keeps the reader's caret: a prompt that took the focus with it would leave them
    // nowhere to type the next one.
    field.current?.focus();
  };

  return (
    <form
      onSubmit={submit}
      className={cn(
        "relative w-full rounded-2xl border border-border/80 bg-field p-2 transition-colors focus-within:border-foreground/25",
        disabled && "opacity-60",
        className,
      )}
    >
      {/* What a leading slash is building, above the box that is building it: the list is the
          command's own names, so picking one writes the command where the reader is already typing
          rather than running something they cannot see. */}
      <AnimatePresence initial={false}>
        {menuOpen ? (
          <CommandMenu
            key="commands"
            commands={matches}
            activeIndex={activeIndex}
            onActiveChange={(index) => setNav({ query: query ?? "", index })}
            onSelect={chooseCommand}
            label={copy.commands}
            skillLabel={copy.skill}
          />
        ) : null}
      </AnimatePresence>
      {/* The plugin suggestion line: one dismissible line above the field, drawn by the plugin.
          Tab accepts it and Escape dismisses it (see `handlePopupKey`); the ✕ is the pointer's
          version of the same dismissal. Nothing rendered means nothing mounted. */}
      <PluginSuggestionLine />
      {/* The field is the prompt's own surface, so what the prompt is made of is inside it: the
          reader's words and their files in one flow, each chip one character of the draft. */}
      <ComposerField
        ref={field}
        id={id}
        value={currentValue}
        attachments={attachments}
        onValueChange={setValue}
        onRestoreDraft={onRestoreDraft}
        onRemoveAttachment={(token) => onRemoveAttachment?.(token)}
        onFiles={(files, pasteId) => onFiles?.(files, pasteId)}
        onPaths={onPaths}
        onHistoryPrevious={onHistoryPrevious}
        onHistoryNext={onHistoryNext}
        onPopupKey={handlePopupKey}
        onDraftEdited={onDraftEdited}
        onSubmitGesture={(gesture) => submit(undefined, gesture)}
        removeLabel={(name) => removeLabel?.(name) ?? name}
        placeholder={resolvedPlaceholder}
        ariaLabel={resolvedAriaLabel}
        disabled={disabled}
        minRows={minRows}
        maxRows={maxRows}
      />

      <div className="mt-1 flex min-h-8 items-center gap-1">
        {/* Plugin controls on the toolbar's left edge, before this app's own. A slot with nothing
            registered renders nothing at all, so the row is unchanged. */}
        <PluginSlot slot="composer.toolbar" position="left" props={{ position: "left" }} />
        {actions.length ? (
          <MorphPopover open={actionsOpen} onOpenChange={setActionsOpen}>
            <MorphPopoverTrigger>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                disabled={disabled || loading}
                aria-label={copy.addToPrompt}
                className="size-8 rounded-full"
              >
                <motion.span
                  aria-hidden="true"
                  animate={{ rotate: actionsOpen ? 45 : 0 }}
                  transition={reduce ? { duration: 0 } : SPRING_SWAP}
                >
                  <Plus className="size-4" />
                </motion.span>
              </Button>
            </MorphPopoverTrigger>

            <MorphPopoverContent
              side="top"
              align="start"
              sideOffset={8}
              radius={12}
              className="w-56 p-1.5"
            >
              {actions.map((action) => (
                <button
                  key={action.value}
                  type="button"
                  disabled={action.disabled}
                  onClick={() => {
                    onAction?.(action.value);
                    setActionsOpen(false);
                  }}
                  className="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left outline-none transition-colors hover:bg-muted focus-visible:bg-muted disabled:pointer-events-none disabled:opacity-50"
                >
                  {action.icon ? (
                    <span className="mt-0.5 grid size-5 shrink-0 place-items-center text-muted-foreground [&_svg]:size-4">
                      {action.icon}
                    </span>
                  ) : null}
                  <span className="min-w-0">
                    <span className="block text-sm text-foreground">
                      {action.label}
                    </span>
                    {action.description ? (
                      <span className="mt-0.5 block text-xs leading-4 text-muted-foreground">
                        {action.description}
                      </span>
                    ) : null}
                  </span>
                </button>
              ))}
            </MorphPopoverContent>
          </MorphPopover>
        ) : null}
        {leadingAction}
        {modeBar}
        <MorphPopover className="ml-auto min-w-0 shrink-0">
          <MorphPopoverTrigger>
            <Button
              type="button"
              variant="ghost"
              disabled={disabled || loading}
              aria-label={
                currentModel === undefined
                  ? copy.chooseModel
                  : showThinking
                    ? `${copy.chooseModel}: ${String(currentModel.label)}; ${copy.thinkingStrength}: ${currentThinkingLevel}`
                    : `${copy.chooseModel}: ${String(currentModel.label)}`
              }
              className="h-8 w-fit max-w-[min(24rem,60vw)] min-w-0 justify-between gap-2 rounded-full border border-border/80 bg-muted/70 px-3 text-xs"
            >
              <span className="flex min-w-0 flex-1 items-center gap-1.5">
                {/* The field names the model alone: the provider it came from is what the menu's
                    own headings are for, and a chip that led with one pushed the model out of the
                    width it has. */}
                <span className="min-w-0 truncate">
                  {currentModel?.label ?? copy.chooseModel}
                </span>
                {/* No model to name is no level to name either, and a model that cannot think has no
                    level to name: a chip reading "choose a model · max" would state a strength for
                    a model nobody chose, and "gpt-x · off" would state one the model does not
                    have. */}
                {currentModel === undefined || !showThinking ? null : (
                  <>
                    <span className="shrink-0 text-muted-foreground" aria-hidden="true">
                      ·
                    </span>
                    <span className="shrink-0 font-medium">{currentThinkingLevel}</span>
                  </>
                )}
              </span>
              <ChevronDown
                className="size-3.5 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
            </Button>
          </MorphPopoverTrigger>
          <MorphPopoverContent
            side="top"
            align="end"
            sideOffset={8}
            radius={12}
            className="flex w-[min(360px,calc(100vw_-_24px))] flex-col p-3"
          >
            <div className="flex min-h-0 flex-1 flex-col gap-3">
              {models.length > 0 ? (
                <div
                  role="radiogroup"
                  aria-label={copy.chooseModel}
                  /* Ten rows of `h-9` plus the four-pixel gaps between them, and no taller: past that
                     the list scrolls inside itself so the thinking slider below it stays put. The
                     `min-h-0 flex-1` is what lets a short window shrink the list instead of the
                     panel — the panel would otherwise scroll the slider out of reach. */
                  className="flex max-h-[24.75rem] min-h-0 flex-1 flex-col gap-1 overflow-y-auto overscroll-contain"
                >
                  {models.map((option, index) => {
                    const selected = currentModelValue === option.value;
                    // A group is stated once, where the list enters it: repeating it on every row
                    // below would be a column of the same words rather than a heading.
                    const heading =
                      option.group !== undefined && option.group !== models[index - 1]?.group;
                    return (
                      <Fragment key={option.value}>
                        {heading ? (
                          <p className="px-2.5 pt-1 text-[11px] leading-4 font-medium text-muted-foreground">
                            {option.group}
                          </p>
                        ) : null}
                        <label className="block cursor-pointer">
                          <input
                            type="radio"
                            name={modelRadioGroupName}
                            value={option.value}
                            checked={selected}
                            disabled={disabled || loading || option.disabled}
                            onChange={() => setModel(option.value)}
                            className="peer sr-only"
                          />
                          <span
                            className={cn(
                              "flex h-9 w-full min-w-0 items-center gap-2 rounded-lg px-2.5 text-left text-sm transition-colors",
                              selected
                                ? "bg-muted text-foreground"
                                : "text-muted-foreground hover:bg-muted",
                              "peer-focus-visible:ring-2 peer-focus-visible:ring-foreground/20",
                              option.disabled && "cursor-not-allowed opacity-50",
                            )}
                          >
                            {option.icon ? (
                              <span className="grid size-5 shrink-0 place-items-center text-muted-foreground [&_svg]:size-4">
                                {option.icon}
                              </span>
                            ) : null}
                            <span className="min-w-0 flex-1 truncate text-foreground">
                              {option.label}
                            </span>
                            {selected ? (
                              <Check
                                className="size-4 shrink-0"
                                aria-hidden="true"
                              />
                            ) : null}
                          </span>
                        </label>
                      </Fragment>
                    );
                  })}
                </div>
              ) : null}
              {showThinking ? (
                <div className="shrink-0 border-t border-border/60 pt-3">
                  <InlineSlider
                    value={canChooseThinking ? currentThinkingIndex : 0}
                    min={0}
                    max={canChooseThinking ? thinkingOptions.length - 1 : 0}
                    step={1}
                    disabled={disabled || loading || !canChooseThinking}
                    onValueChange={setThinkingLevelAtIndex}
                    label={copy.thinkingStrength}
                    format={(index) =>
                      thinkingOptions[Math.round(index)] ?? thinkingOptions[0]
                    }
                  />
                </div>
              ) : null}
            </div>
          </MorphPopoverContent>

        </MorphPopover>
        <ContextGauge usage={contextUsage ?? null} />
        {/* Plugin controls on the toolbar's right edge: after this app's own model control, before
            the stop and send pair, which stay the outermost controls of the row. */}
        <PluginSlot slot="composer.toolbar" position="right" props={{ position: "right" }} />
        {/* The stop a Send cannot carry: a draft keeps the primary the same gesture plain Enter is,
            so a run the reader is typing into is stopped from here instead — the same control the
            primary becomes when the box is empty, in the smaller slot beside it. */}
        {onInterrupt !== undefined && !loading ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={stopPending ? (stopPendingLabel ?? copy.stopGenerating) : copy.stopGenerating}
            onClick={onInterrupt}
            disabled={stopPending}
            className="size-8 rounded-full"
          >
            <Square aria-hidden="true" className="size-3 fill-current" />
          </Button>
        ) : null}
        <Button
          type={loading ? "button" : "submit"}
          size="icon"
          disabled={loading ? !onStop || stopPending : !canSubmit}
          aria-label={
            loading
              ? stopPending
                ? (stopPendingLabel ?? copy.stopGenerating)
                : copy.stopGenerating
              : (sendLabel ?? copy.sendPrompt)
          }
          aria-busy={loading && stopPending ? true : undefined}
          onClick={loading ? onStop : undefined}
          className="size-8 rounded-full"
        >
          <AnimatePresence initial={false} mode="popLayout">
            <motion.span
              key={loading ? (stopPending ? "stopping" : "stop") : "send"}
              initial={reduce ? { opacity: 1 } : { opacity: 0, y: 3, scale: 0.8 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, y: -3, scale: 0.8 }}
              transition={reduce ? { duration: 0 } : SPRING_SWAP}
              className="grid place-items-center"
            >
              {loading ? (
                stopPending ? (
                  // The stop is on its way: the control draws the wait rather than offering a
                  // second press that cannot do anything the first one is not already doing.
                  <span className="size-3 animate-pulse rounded-sm bg-current" />
                ) : (
                  <Square className="size-3 fill-current" />
                )
              ) : (
                <ArrowUp className="size-4" />
              )}
            </motion.span>
          </AnimatePresence>
        </Button>
      </div>
    </form>
  );
}
