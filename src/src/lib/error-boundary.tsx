"use client";

import { AlertCircle } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode } from "react";
import {
  Alert,
  AlertContent,
  AlertDescription,
  AlertIcon,
  AlertTitle,
} from "@/components/motion/alert";
import { Button } from "@/components/motion/button";
import { reportClientError } from "@/lib/client-errors";
import { useCopy, type Localized } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * What a surface says when one of its rows could not be drawn.
 *
 * There was no boundary anywhere in this application, which is the difference between "one row is
 * broken" and "the window is black": a throw anywhere in the tree — a row, a disclosure, a library's
 * own invariant — unmounts the whole React root, and what the reader sees is an empty window with
 * no conversation and no way back. The boundary turns that into a card that says what happened and
 * offers the one action that can help: draw the surface again.
 */
interface ErrorBoundaryCopy {
  title: string
  hint: string
  retry: string
}

const COPY: Localized<ErrorBoundaryCopy> = {
  en: {
    title: "This part of the window could not be drawn.",
    hint: "The rest of the application is still here. Drawing it again usually clears it; the conversation itself is not affected.",
    retry: "Draw it again",
  },
  zh: {
    title: "这块界面没能画出来。",
    hint: "应用的其他部分还在。重新画一次通常就好了；对话本身不受影响。",
    retry: "重新绘制",
  },
};

interface BoundaryProps {
  copy: ErrorBoundaryCopy
  className?: string
  children: ReactNode
}

interface BoundaryState {
  failed: boolean
}

/**
 * The catching half: a class, because only a class can be an error boundary.
 *
 * Retrying flips the flag back, and the subtree it replaces is mounted afresh — the failed render
 * took it out of the document, so there is no stale state for the second attempt to inherit.
 */
class Boundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { failed: false };

  static getDerivedStateFromError(): BoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    // A render failure is the one this boundary sees and nothing else does: it is handed to the
    // page's reporter, which writes it into `app.log` beside the application's own lines, with the
    // component stack that says which surface threw. `console.error` stays as the second copy the
    // webview's own devtools shows while developing.
    reportClientError("a surface failed to render", error, info.componentStack);
    console.error("a surface failed to render", error);
  }

  private retry = (): void => {
    this.setState({ failed: false });
  };

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    const { copy, className } = this.props;
    return (
      <div className={cn("flex min-h-0 flex-1 items-center justify-center p-4", className)}>
        <Alert variant="destructive" className="max-w-md items-start gap-2 py-2 pr-3 pl-3 text-xs">
          <AlertIcon>
            <AlertCircle aria-hidden="true" className="size-3.5" />
          </AlertIcon>
          <AlertContent>
            <AlertTitle className="text-xs">{copy.title}</AlertTitle>
            <AlertDescription className="text-xs">{copy.hint}</AlertDescription>
            <div className="pt-2">
              <Button size="sm" variant="outline" onClick={this.retry}>
                {copy.retry}
              </Button>
            </div>
          </AlertContent>
        </Alert>
      </div>
    );
  }
}

export interface ErrorBoundaryProps {
  children: ReactNode;
  className?: string;
}

/**
 * Keeps one broken surface from taking the window with it.
 *
 * Mounted around the conversation column (so the rail, the composer and the window frame survive a
 * bad row) and around the whole shell (so a failure in a settings page or the rail still leaves a
 * window with a way back).
 */
export function ErrorBoundary({ children, className }: ErrorBoundaryProps) {
  const copy = useCopy(COPY);
  return (
    <Boundary copy={copy} className={className}>
      {children}
    </Boundary>
  );
}
