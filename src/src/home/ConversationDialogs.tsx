import { useCallback, useState } from "react";
import {
  ApprovalCard,
  type ApprovalCardAnswers,
} from "@/components/agents/approval-card";
import { ChoiceDialog } from "@/home/ChoiceDialog";
import { DialogAnswerField, SecretDialogAnswerField } from "@/home/DialogAnswerField";
import { FormCard } from "@/home/FormCard";
import type { UiAskQuestion, UiAskResult, UiRequest, UiResponse } from "@/api/session-types";
import { promptTextWithFiles } from "@/lib/file-mention";
import { useCopy } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { COPY, type HomeCopy } from "@/home/homeCopy";
import {
  holdAttachments,
  importAttachmentPaths,
  importClipboardFiles,
  type AttachmentRefusal,
  type ImportedAttachmentFiles,
} from "@/state/composer-attachments";
import type { ComposerAttachment } from "@/state/composer-draft";

export interface ConversationDialogsProps {
  /** The engine's unanswered dialogs, oldest first. */
  dialogs: UiRequest[];
  /**
   * The conversation the dialogs belong to: the scope a pasted file's bytes are staged under, which
   * is also what the desktop's scratch sweep reads.
   */
  sessionId: string | null;
  onAnswer: (requestId: string, response: UiResponse) => void;
  className?: string;
}

/**
 * The engine's dialogs, in the composer's own slot.
 *
 * They sit directly above the composer and share its width rather than floating: a dialog is the
 * next thing the user has to do, and a panel in a corner would cover the field it is asking about.
 * More than one at a time pages rather than stacking, so the composer never leaves the screen.
 */
export function ConversationDialogs({
  dialogs,
  sessionId,
  onAnswer,
  className,
}: ConversationDialogsProps) {
  const copy = useCopy(COPY);
  const [page, setPage] = useState(0);

  if (dialogs.length === 0) return null;
  const index = Math.min(page, dialogs.length - 1);
  const request = dialogs[index];

  return (
    <div className={cn("flex min-w-0 flex-col gap-2", className)}>
      {dialogs.length > 1 ? (
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span className="tabular-nums">
            {index + 1} / {dialogs.length}
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setPage((current) => Math.max(0, current - 1))}
              disabled={index === 0}
              className="grid size-6 place-items-center rounded-md outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
            >
              <span aria-hidden="true">‹</span>
            </button>
            <button
              type="button"
              onClick={() => setPage((current) => Math.min(dialogs.length - 1, current + 1))}
              disabled={index === dialogs.length - 1}
              className="grid size-6 place-items-center rounded-md outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
            >
              <span aria-hidden="true">›</span>
            </button>
          </div>
        </div>
      ) : null}
      <DialogCard
        key={request.id}
        request={request}
        copy={copy}
        sessionId={sessionId}
        onAnswer={(response) => onAnswer(request.id, response)}
      />
    </div>
  );
}

function DialogCard({
  request,
  copy,
  sessionId,
  onAnswer,
}: {
  request: UiRequest;
  copy: HomeCopy;
  sessionId: string | null;
  onAnswer: (response: UiResponse) => void;
}) {
  if (request.method === "confirm") {
    return (
      <ChoiceDialog
        title={request.title}
        message={request.message}
        options={[]}
        confirm
        onAnswer={(choice) => onAnswer({ confirmed: choice === true })}
        onCancel={() => onAnswer({ confirmed: false, cancelled: true })}
      />
    );
  }

  if (request.method === "ask") {
    return (
      <ApprovalCard
        title={copy.dialogFromEngine}
        questions={request.questions.map(toCardQuestion)}
        status="pending"
        onSubmit={(answers) => onAnswer({ kind: "submit", results: toAskResults(request.questions, answers) })}
      />
    );
  }

  if (request.method === "form") {
    return (
      <FormCard
        sections={request.sections}
        fields={request.fields}
        onSubmit={(answers) => onAnswer({ answers })}
        onCancel={() => onAnswer({ cancelled: true })}
      />
    );
  }

  if (request.method === "select") {
    return (
      <ChoiceDialog
        title={request.title}
        options={request.options}
        onAnswer={(choice) => onAnswer({ value: typeof choice === "string" ? choice : "" })}
        onCancel={() => onAnswer({ cancelled: true })}
      />
    );
  }

  // `input` and `editor` are the same field on this wire: the engine's own prompt and placeholder,
  // with the answer coming back as a plain string.
  return (
    <TextDialogCard
      request={request}
      copy={copy}
      sessionId={sessionId}
      onAnswer={onAnswer}
    />
  );
}

/**
 * The dialog whose answer is a prompt: the box, the files it carries, and the string they become.
 *
 * The answer leaves as one string, because that is all this wire has — so each attached file is
 * written into it as its `@<path>` mention line (`promptTextWithFiles`). That is the shape the
 * desktop's prompt path appends for a composer's attachments, and the engine reads the file from it
 * itself, so a file pasted here is as much part of the answer as one pasted into the composer.
 *
 * `answers` is controlled with the mention lines already in it: the card's submit gate reads the
 * answer, and an answer that is only files must still count as an answer.
 */
function TextDialogCard({
  request,
  copy,
  sessionId,
  onAnswer,
}: {
  request: Extract<UiRequest, { method: "input" | "editor" }>;
  copy: HomeCopy;
  sessionId: string | null;
  onAnswer: (response: UiResponse) => void;
}) {
  const [words, setWords] = useState("");
  const [files, setFiles] = useState<readonly ComposerAttachment[]>([]);
  const [refusal, setRefusal] = useState<AttachmentRefusal | null>(null);

  /** One import, whichever gesture started it: the complaint it may carry, and the chips it adds. */
  const take = useCallback((incoming: Promise<ImportedAttachmentFiles>) => {
    void incoming.then((imported) => {
      setRefusal(imported.refusal);
      setFiles((held) => [...held, ...holdAttachments(held, imported.files)]);
    });
  }, []);

  const answer = promptTextWithFiles(
    words,
    files.map((file) => file.path),
  );
  // A dialog the engine marked `secret` is a credential: one masked line, no files, and the answer
  // is its own text rather than a prompt with mention lines.
  const secret = request.method === "input" && request.secret === true;

  return (
    <ApprovalCard
      title={request.title}
      questions={[
        {
          id: request.id,
          title: request.message,
          field: secret ? (
            <SecretDialogAnswerField
              value={words}
              onChange={setWords}
              placeholder={request.placeholder || copy.dialogPlaceholder}
            />
          ) : (
            <DialogAnswerField
              value={words}
              onChange={setWords}
              placeholder={request.placeholder || copy.dialogPlaceholder}
              attachments={files}
              onRemove={(token) =>
                setFiles((held) => held.filter((file) => file.token !== token))
              }
              onPaths={(paths) => take(importAttachmentPaths(paths))}
              onFiles={(pasted) => take(importClipboardFiles(sessionId, pasted))}
              refusal={refusal}
            />
          ),
        },
      ]}
      answers={{ [request.id]: { selected: [], custom: answer } }}
      status="pending"
      submitLabel={copy.dialogSubmit}
      onSubmit={() => onAnswer({ value: answer })}
    />
  );
}

function toCardQuestion(question: UiAskQuestion) {
  return {
    id: question.id,
    title: question.question,
    description: question.header ?? undefined,
    options: question.options.map((option) => ({
      value: option.label,
      label: option.label,
      description: option.description ?? undefined,
    })),
    multiple: question.multi,
    allowCustom: true,
  };
}

function toAskResults(
  questions: UiAskQuestion[],
  answers: ApprovalCardAnswers,
): UiAskResult[] {
  return questions.map((question) => {
    const answer = answers[question.id];
    return {
      id: question.id,
      question: question.question,
      options: question.options.map((option) => option.label),
      multi: question.multi,
      selectedOptions: answer?.selected ?? [],
      customInput: answer?.custom ?? null,
    };
  });
}
