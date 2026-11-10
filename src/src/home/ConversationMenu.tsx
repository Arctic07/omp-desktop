import { Archive, Copy, Download, FileText, GitFork, MoreHorizontal, Pencil, Pin, Trash2 } from "lucide-react";
import { useCallback, useState } from "react";

import { sessionHistory } from "@/api/agent";
import type { ChatMessage } from "@/api/session-types";
import { ResourceMenuAction } from "@/components/agents/ai-sidebar";
import { MorphPopover, MorphPopoverContent, MorphPopoverTrigger } from "@/components/motion/popover-morph";
import { COPY } from "@/home/homeCopy";
import { readModelReasoning } from "@/home/reasoning-echo";
import { stripModelTags } from "@/home/system-notice";
import { copyText } from "@/lib/clipboard";
import { useCopy } from "@/lib/i18n";
import { messageSegments } from "@/state/composer-draft";
import { findSummary, setSessionArchived, setSessionPinned } from "@/state/session-lists";
import { continueFromEntry, removeSession } from "@/state/session-actions";
import { sessionStore, type SessionStoreState } from "@/state/session-store";
import { useStoreSelector } from "@/state/store";

export interface ConversationMenuProps {
  /** The conversation's id, for the one entry that names it. */
  sessionId: string | null;
  /** The workspace it belongs to, for a transcript this process is not holding. */
  workspaceId: number | null;
  onRename: () => void;
}

/**
 * The conversation's own entries, for any surface that offers them: the button beside its title,
 * and the row it has in the rail.
 *
 * Split out from the popover because the two surfaces open a menu over different conversations —
 * the header over the one on screen, a rail row over one that may never have been opened — and the
 * entries are the same either way. A row this process is not holding rows for is copied from its
 * file (`session_history` answers a whole transcript for a file nothing has open), so a copy entry
 * on a cold row is a read rather than an empty string.
 */
export interface ConversationMenuItemsProps {
  sessionId: string | null;
  workspaceId: number | null;
  onRename: () => void;
  close: () => void;
  /** One line for the caller's own live region. */
  announce: (message: string) => void;
}

/** The assistant's final answer, as the "final summary" entry reads it. */
function finalAnswer(messages: readonly ChatMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    // A step's reasoning envelope is thinking, not an answer (`readModelReasoning`), and a copy that
    // carried its brackets — or that dropped an answer the model left inside its reasoning — would
    // be the same defect the transcript stopped drawing. The model's own wrappers around the answer
    // itself (`stripModelTags`) are markup too: a copy carries the words, not the envelope.
    if (message.kind === "assistant") {
      const answer = stripModelTags(readModelReasoning(message.text, message.thinking).answer)
      if (answer.trim()) return answer
    }
  }
  return ""
}

/**
 * The whole conversation as Markdown, one section per row.
 *
 * A user row is written out as it was composed: the words with each file named where it stood, in
 * the engine's own `@<path>` form — the file's character is this application's address for it and
 * means nothing outside a draft, and a copy that dropped the files would lose half of what the
 * message carried.
 */
function asMarkdown(messages: readonly ChatMessage[]): string {
  return messages
    .map((message) => {
      if (message.kind === "user") {
        // The row draws the prompt with the model's own wrappers taken off (`messageProse`), so a
        // copy reads the same words — a prompt pasted out of an answer carries its envelope, and
        // the envelope is markup on the message rather than something the reader wrote.
        const written = messageSegments(stripModelTags(message.text), message.attachments)
          .map((segment) =>
            segment.attachment === null ? segment.text : `@${segment.attachment.path}`,
          )
          .join("")
        return `## You\n\n${written}`
      }
      if (message.kind === "assistant") {
        // The envelope a model thinks in goes where the transcript draws it — with the reasoning —
        // and the answer is what it said outside it, with the model's own wrappers around that
        // answer taken off (`stripModelTags`).
        const read = readModelReasoning(message.text, message.thinking)
        const thinking = read.reasoning.trim() !== "" ? `> ${read.reasoning.trim()}\n\n` : ""
        return `## Agent\n\n${thinking}${stripModelTags(read.answer)}`
      }
      if (message.kind === "reminder") {
        // A rule check the harness fired: it is not a step of the answer, and a copy of the
        // conversation keeps what the conversation says rather than its scaffolding.
        return ""
      }
      if (message.kind === "notice") {
        // An engine notice kept in the transcript (the idle recap, a compaction's report) is a note
        // about the conversation, not part of it: a copy of what was said carries the words that
        // were said.
        return ""
      }
      return `## Tool · ${message.name}\n\n\`\`\`\n${message.resultText || message.argsText}\n\`\`\``
    })
    .join("\n\n")
}

export function ConversationMenuItems({
  sessionId,
  workspaceId,
  onRename,
  close,
  announce,
}: ConversationMenuItemsProps) {
  const copy = useCopy(COPY);
  const record = useStoreSelector(
    sessionStore,
    useCallback(
      (state: SessionStoreState) =>
        sessionId === null ? null : (state.records[sessionId] ?? null),
      [sessionId],
    ),
  );
  const tipEntryId = record?.runtime?.tipEntryId ?? null;
  /**
   * The row this menu acts on, from the workspace's list: pin and archive draw their own labels
   * from here, so a menu opened on a pinned row offers to unpin it rather than to pin it again.
   *
   * A conversation the list does not carry yet (a blank one the host has not written) answers
   * neither flag, which is what an unpinned, unarchived row means.
   */
  const summary = useStoreSelector(
    sessionStore,
    useCallback(
      (state: SessionStoreState) =>
        sessionId === null || workspaceId === null
          ? null
          : ((state.sessions[workspaceId]?.items ?? []).find((row) => row.id === sessionId) ??
            null),
      [sessionId, workspaceId],
    ),
  );
  const pinned = summary?.pinned === true;
  const archived = summary?.archived === true;

  /**
   * The rows a copy entry reads: the ones this process holds, or a transcript read when the row is
   * a conversation that was never opened here. Null is a read that failed, which is announced
   * rather than copied as nothing.
   */
  const transcript = useCallback(async (): Promise<ChatMessage[] | null> => {
    if (record !== null) return record.messages;
    if (sessionId === null || workspaceId === null) return null;
    const row = findSummary(workspaceId, sessionId);
    if (row === undefined) return null;
    try {
      const history = await sessionHistory(sessionId, () => {}, row.filePath);
      return history.messages;
    } catch {
      return null;
    }
  }, [record, sessionId, workspaceId]);

  const runCopy = (text: (rows: readonly ChatMessage[]) => string) => () => {
    close();
    void transcript().then(async (rows) => {
      if (rows === null) {
        announce(copy.sessionMenu.copyFailed);
        return;
      }
      announce((await copyText(text(rows))) ? copy.sessionMenu.copied : copy.sessionMenu.copyFailed);
    });
  };

  const copyId = () => {
    close();
    if (sessionId === null) return;
    void copyText(sessionId).then((ok) =>
      announce(ok ? copy.sessionMenu.copied : copy.sessionMenu.copyFailed),
    );
  };

  /**
   * Branch the conversation from where it currently ends.
   *
   * The engine forks it into a file of its own, so the conversation the reader is in keeps every
   * message it had and a second one appears beside it. Nothing is re-sent, so nothing is announced
   * on success: the screen has already moved to the new conversation, which is the whole answer.
   */
  const branch = () => {
    close();
    if (sessionId === null || tipEntryId === null) return;
    void continueFromEntry(sessionId, tipEntryId);
  };

  /**
   * Pin or unpin this conversation.
   *
   * The flag is the host's own row, so the workspace's list is read back rather than patched here:
   * the ordering the rail draws comes from that list, and a local patch would be a second copy of
   * the rule. Nothing is announced on success - the row moves, which is the whole answer.
   */
  const togglePin = () => {
    close();
    if (sessionId === null || workspaceId === null) return;
    void setSessionPinned(workspaceId, sessionId, !pinned).catch(() =>
      announce(copy.sessionMenu.flagFailed),
    );
  };

  /**
   * Put this conversation away, or bring it back.
   *
   * Announced either way it lands: the row leaves the list (or comes back into it) at once, and a
   * row that vanished without a word reads as a delete.
   */
  const toggleArchive = () => {
    close();
    if (sessionId === null || workspaceId === null) return;
    void setSessionArchived(workspaceId, sessionId, !archived).then(
      () => announce(archived ? copy.sessionMenu.unarchivedNotice : copy.sessionMenu.archivedNotice),
      () => announce(copy.sessionMenu.flagFailed),
    );
  };

  return (
    <>
      <div className="flex flex-col">
        <ResourceMenuAction
          icon={Pencil}
          onSelect={() => {
            close();
            onRename();
          }}
        >
          {copy.sessionMenu.rename}
        </ResourceMenuAction>
        <ResourceMenuAction icon={Pin} onSelect={togglePin}>
          {pinned ? copy.sessionMenu.unpin : copy.sessionMenu.pin}
        </ResourceMenuAction>
        {tipEntryId === null ? null : (
          <ResourceMenuAction icon={GitFork} onSelect={branch}>
            {copy.sessionMenu.branch}
          </ResourceMenuAction>
        )}
      </div>
      <div aria-hidden="true" className="my-1.5 border-t border-border" />
      <div className="flex flex-col">
        <ResourceMenuAction icon={Copy} onSelect={runCopy(asMarkdown)}>
          {copy.sessionMenu.copyAll}
        </ResourceMenuAction>
        <ResourceMenuAction icon={FileText} onSelect={runCopy((rows) => finalAnswer(rows))}>
          {copy.sessionMenu.copySummary}
        </ResourceMenuAction>
        <ResourceMenuAction icon={Copy} onSelect={copyId}>
          {copy.sessionMenu.copyId}
        </ResourceMenuAction>
        <ResourceMenuAction icon={Download} onSelect={close}>
          {copy.sessionMenu.export}
        </ResourceMenuAction>
      </div>
      <div aria-hidden="true" className="my-1.5 border-t border-border" />
      <div className="flex flex-col">
        <ResourceMenuAction icon={Archive} onSelect={toggleArchive}>
          {archived ? copy.sessionMenu.unarchive : copy.sessionMenu.archive}
        </ResourceMenuAction>
        {/* The rail's row menu used to be the only place a conversation could be deleted. It is
            kept here so replacing that menu's entries does not take the one delete with it. */}
        <ResourceMenuAction
          icon={Trash2}
          destructive
          onSelect={() => {
            close();
            if (sessionId === null || workspaceId === null) return;
            void removeSession(workspaceId, sessionId);
          }}
        >
          {copy.menuDeleteSession}
        </ResourceMenuAction>
      </div>
    </>
  );
}

/**
 * The conversation's own menu, opened from the button beside its title.
 *
 * Everything but the export writes something: the three copy entries put text on the clipboard,
 * rename swaps the title for a field, branch forks the conversation, and pin and archive change the
 * row's place in its workspace's list. Export is drawn but inert — nothing behind it is built yet.
 */
export function ConversationMenu({ sessionId, workspaceId, onRename }: ConversationMenuProps) {
  const copy = useCopy(COPY);
  const [open, setOpen] = useState(false);
  const [announcement, setAnnouncement] = useState("");

  const close = () => setOpen(false);

  return (
    <>
      <MorphPopover open={open} onOpenChange={setOpen}>
        <MorphPopoverTrigger>
          <button
            type="button"
            aria-label={copy.sessionMenu.label}
            className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <MoreHorizontal className="size-4" />
          </button>
        </MorphPopoverTrigger>
        <MorphPopoverContent side="bottom" align="start" sideOffset={8} radius={12} className="w-72 p-1.5">
          <ConversationMenuItems
            sessionId={sessionId}
            workspaceId={workspaceId}
            onRename={() => {
              close();
              onRename();
            }}
            close={close}
            announce={setAnnouncement}
          />
        </MorphPopoverContent>
      </MorphPopover>
      <span aria-live="polite" className="sr-only">
        {announcement}
      </span>
    </>
  );
}
