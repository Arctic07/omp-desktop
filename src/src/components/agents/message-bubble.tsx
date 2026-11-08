"use client";
// beui.dev/components/agents/chat-app

import { ChevronDown } from "lucide-react";
import {
  type HTMLMotionProps,
  motion,
  useReducedMotion,
} from "motion/react";
import {
  cloneElement,
  type ComponentPropsWithRef,
  createContext,
  type ReactElement,
  type ReactNode,
  type Ref,
  useCallback,
  useContext,
  useId,
  useState,
} from "react";
import {
  SPRING_LAYOUT,
  SPRING_SWAP,
} from "@/lib/ease";
import { useCopy, type Localized } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { MessageSideContext } from "@/components/agents/message-context";

/** The collapsible bubble's own wording: the two labels its disclosure trigger swaps between. */
interface MessageBubbleCopy {
  showMore: string
  showLess: string
}

const COPY: Localized<MessageBubbleCopy> = {
  en: {
    showMore: "Show more",
    showLess: "Show less",
  },
  zh: {
    showMore: "展开",
    showLess: "收起",
  },
};

export type MessageBubbleVariant =
  | "solid"
  | "soft"
  | "tint"
  | "outline"
  | "ghost"
  | "danger";
export type MessageBubbleAlign = "start" | "end";

interface MessageBubbleContextValue {
  align?: MessageBubbleAlign;
  animateIn: boolean;
  variant: MessageBubbleVariant;
}

const MessageBubbleContext = createContext<MessageBubbleContextValue>({
  animateIn: true,
  variant: "soft",
});
const MessageBubbleLayoutContext = createContext<() => void>(() => {});

export interface MessageBubbleProps
  extends Omit<HTMLMotionProps<"div">, "children"> {
  variant?: MessageBubbleVariant;
  /** Defaults to the surrounding Message alignment when omitted. */
  align?: MessageBubbleAlign;
  /** Plays the bubble entrance once when this component mounts. */
  animateIn?: boolean;
  children?: ReactNode;
}

export interface MessageBubbleContentProps
  extends ComponentPropsWithRef<"div"> {
  /** Replaces the content element while preserving bubble styling. */
  render?: ReactElement;
}

export interface MessageBubbleGroupProps extends ComponentPropsWithRef<"div"> {
  spacing?: "compact" | "default";
}

export interface MessageBubbleCollapsibleProps
  extends ComponentPropsWithRef<"div"> {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  collapsedLines?: 2 | 3 | 4 | 5 | 6;
  moreLabel?: ReactNode;
  lessLabel?: ReactNode;
  contentClassName?: string;
  triggerClassName?: string;
  children?: ReactNode;
}

function mergeRefs<T>(...refs: Array<Ref<T> | undefined>) {
  return (node: T | null) => {
    for (const ref of refs) {
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    }
  };
}

// Sent bubbles should pop into place quickly with one restrained overshoot.
const BUBBLE_POP = {
  type: "spring",
  stiffness: 520,
  damping: 27,
  mass: 0.52,
} as const;

export function MessageBubble({
  variant = "soft",
  align,
  animateIn = false,
  className,
  children,
  initial,
  animate,
  exit,
  transition,
  layout,
  ...props
}: MessageBubbleProps) {
  const reduce = useReducedMotion() ?? false;
  const messageSide = useContext(MessageSideContext);
  const resolvedAlign = align ?? messageSide ?? "start";

  return (
    <MessageBubbleContext.Provider
      value={{ align: resolvedAlign, animateIn, variant }}
    >
      <motion.div
        data-slot="message-bubble"
        data-align={resolvedAlign}
        data-variant={variant}
        layout={layout}
        initial={initial ?? false}
        animate={animate}
        exit={
          exit ??
          (reduce ? { opacity: 0 } : { opacity: 0, y: -3, scale: 0.99 })
        }
        transition={transition ?? (reduce ? { duration: 0.12 } : SPRING_LAYOUT)}
        className={cn(
          "group/bubble flex w-full flex-col",
          resolvedAlign === "end" ? "items-end" : "items-start",
          className,
        )}
        {...props}
      >
        {children}
      </motion.div>
    </MessageBubbleContext.Provider>
  );
}

function bubbleContentClass(
  variant: MessageBubbleVariant,
  interactive: boolean,
) {
  return cn(
    "relative z-0 min-w-9 max-w-[82%] rounded-2xl px-3.5 py-2.5 text-[length:var(--omp-content-font-size,0.875rem)] leading-6 text-foreground",
    // Paragraphs, lists, code spans, fences and now anchors are drawn by the app's `Markdown`
    // renderer, which owns their spacing, ink, background and underline: descendant rules here
    // styled the same elements a second time, and `[&_pre]`/`[&_code]` reached *inside* a fence's
    // own card — the code block grew a second inset panel with padding and margins of its own
    // (2026-10-24 reader report: the block did not look like `@beui/code-block`). The anchor rule
    // went the same way once `components/agents/markdown-tags.ts` gave every link one class.
    variant === "solid" && "text-bubble-user-ink",
    variant === "ghost" && "w-full max-w-none rounded-none px-0 py-0",
    variant === "danger" && "text-destructive",
    interactive &&
      "cursor-pointer text-left outline-none transition-[background-color,color,transform] duration-150 hover:brightness-[0.98] focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.99]",
  );
}

function bubbleSurfaceClass(
  variant: MessageBubbleVariant,
  align: MessageBubbleAlign,
) {
  return cn(
    "pointer-events-none absolute inset-0 -z-10 rounded-[inherit]",
    align === "end" ? "origin-bottom-right" : "origin-bottom-left",
    variant === "solid" && "bg-bubble-user",
    variant === "soft" && "bg-muted",
    variant === "tint" && "bg-muted",
    variant === "outline" && "border border-border/70 bg-background",
    variant === "danger" && "bg-destructive/10",
  );
}

export function MessageBubbleContent({
  render,
  className,
  children,
  ref,
  ...props
}: MessageBubbleContentProps) {
  const reduce = useReducedMotion() ?? false;
  const { align = "start", animateIn, variant } =
    useContext(MessageBubbleContext);
  const [layoutVersion, setLayoutVersion] = useState(0);
  const notifyLayout = useCallback(
    () => setLayoutVersion((version) => version + 1),
    [],
  );
  const interactive =
    render?.type === "button" || render?.type === "a";
  const classes = cn(bubbleContentClass(variant, interactive), className);
  const composedChildren = (
    <>
      {variant !== "ghost" ? (
        <motion.span
          aria-hidden="true"
          layout={reduce ? false : "size"}
          layoutDependency={layoutVersion}
          initial={
            animateIn && !reduce
              ? {
                  scale: 0.96,
                }
              : false
          }
          animate={{ scale: 1 }}
          transition={
            reduce
              ? { duration: 0 }
              : {
                  scale: BUBBLE_POP,
                  layout: SPRING_LAYOUT,
                }
          }
          className={bubbleSurfaceClass(variant, align)}
        />
      ) : null}
      <MessageBubbleLayoutContext.Provider value={notifyLayout}>
        {/* The bubble's own text is never held back by its entrance: a reveal is drawn at full
            weight from its first frame, and what moves is the surface behind it (above). A text
            surface that waits for an animation is a text surface that can be left blank. */}
        <motion.div className="relative">{children}</motion.div>
      </MessageBubbleLayoutContext.Provider>
    </>
  );

  if (render) {
    const child = render as ReactElement<
      Record<string, unknown> & { className?: string; ref?: Ref<HTMLElement> }
    >;

    return cloneElement(child, {
      ...props,
      ref: mergeRefs(child.props.ref, ref as Ref<HTMLElement> | undefined),
      className: cn(classes, child.props.className),
      children: composedChildren,
      "data-slot": "message-bubble-content",
    });
  }

  return (
    <div
      ref={ref}
      data-slot="message-bubble-content"
      className={classes}
      {...props}
    >
      {composedChildren}
    </div>
  );
}

export function MessageBubbleGroup({
  spacing = "compact",
  className,
  ...props
}: MessageBubbleGroupProps) {
  return (
    <div
      data-slot="message-bubble-group"
      className={cn(
        "flex w-full flex-col",
        spacing === "compact" ? "gap-1.5" : "gap-3",
        className,
      )}
      {...props}
    />
  );
}

const LINE_CLAMP_CLASS = {
  2: "line-clamp-2",
  3: "line-clamp-3",
  4: "line-clamp-4",
  5: "line-clamp-5",
  6: "line-clamp-6",
} as const;

export function MessageBubbleCollapsible({
  open,
  defaultOpen = false,
  onOpenChange,
  collapsedLines = 4,
  moreLabel,
  lessLabel,
  contentClassName,
  triggerClassName,
  className,
  children,
  ...props
}: MessageBubbleCollapsibleProps) {
  const reduce = useReducedMotion() ?? false;
  const copy = useCopy(COPY);
  const contentId = useId();
  const notifyLayout = useContext(MessageBubbleLayoutContext);
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const currentOpen = open ?? internalOpen;

  const setOpen = useCallback(
    (next: boolean) => {
      notifyLayout();
      if (open === undefined) setInternalOpen(next);
      onOpenChange?.(next);
    },
    [notifyLayout, onOpenChange, open],
  );

  return (
    <div
      data-slot="message-bubble-collapsible"
      data-state={currentOpen ? "open" : "closed"}
      className={cn("w-full", className)}
      {...props}
    >
      <div
        id={contentId}
        className={cn(
          "transition-[mask-image] duration-200",
          !currentOpen && LINE_CLAMP_CLASS[collapsedLines],
          !currentOpen &&
            "[mask-image:linear-gradient(to_bottom,#000_68%,transparent_100%)]",
          contentClassName,
        )}
      >
        {children}
      </div>
      <button
        type="button"
        aria-expanded={currentOpen}
        aria-controls={contentId}
        onClick={() => setOpen(!currentOpen)}
        className={cn(
          "mt-2 inline-flex h-7 items-center gap-1 rounded-full px-2 text-xs font-medium text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
          triggerClassName,
        )}
      >
        <span>{currentOpen ? (lessLabel ?? copy.showLess) : (moreLabel ?? copy.showMore)}</span>
        <motion.span
          aria-hidden="true"
          animate={{ rotate: currentOpen ? 180 : 0 }}
          transition={reduce ? { duration: 0 } : SPRING_SWAP}
        >
          <ChevronDown className="size-3.5" />
        </motion.span>
      </button>
    </div>
  );
}
