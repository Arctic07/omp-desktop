"use client";
// beui.dev/components/motion/loader

import { useEffect } from "react";
import {
  motion,
  motionValue,
  useReducedMotion,
  useTransform,
  type MotionValue,
} from "motion/react";
import { EASE_IN_OUT } from "@/lib/ease";
import { cn } from "@/lib/utils";

// The registry ships seventeen variants; this app renders two — `spinner`, the running row's
// glyph, and `helix`, the transcript's running line
// (`components/agents/loading-states/agent-progress.tsx`). The others are removed rather than kept
// unused, and the variant union is left in place so re-installing `@beui/loader` is recognisable as
// this file.
export type LoaderVariant = "spinner" | "helix";

export interface LoaderProps {
  /** Which animation to render. */
  variant?: LoaderVariant;
  /** Base square size in px. Everything scales from this. */
  size?: number;
  /** Seconds per animation cycle. */
  speed?: number;
  /** Accessible label announced to screen readers. */
  label?: string;
  className?: string;
}

export function Loader({
  variant = "spinner",
  size = 32,
  speed = 1,
  label,
  className,
}: LoaderProps) {
  const reduce = useReducedMotion() ?? false;

  return (
    <span
      role="status"
      // The registry defaults this to the English "Loading". This app's wording lives in a
      // `Localized` record read with `useCopy`, so the announcement is opt-in here: a caller
      // hands the loader its own verb, or hides it — the running row already announces one.
      aria-label={label}
      className={cn(
        "inline-flex items-center justify-center text-foreground",
        className,
      )}
    >
      {variant === "spinner" && <Spinner size={size} speed={speed} reduce={reduce} />}
      {variant === "helix" && <Helix size={size} speed={speed} reduce={reduce} />}
      {label ? <span className="sr-only">{label}</span> : null}
    </span>
  );
}

interface PartProps {
  size: number;
  speed: number;
  reduce: boolean;
}

/**
 * One clock, read by every spinner that is mounted.
 *
 * Motion's own time (`useTime`, `useAnimationFrame`) counts from *each subscriber's* first frame —
 * it subtracts the timestamp its own element first saw — so two rows that mounted a moment apart
 * still turned at different angles (2026-10-21, user report: "角度不一致"). This clock is absolute
 * page time instead: every ring asks the same number what angle the cycle is at, so a column of
 * running conversations turns as one signal. The frame loop exists only while a spinner is on
 * screen; the last one to unmount stops it.
 */
const spinClock = motionValue(0);
let spinClockUsers = 0;
let spinClockFrame = 0;

function useSpinClock(): MotionValue<number> {
  useEffect(() => {
    spinClockUsers += 1;
    if (spinClockUsers === 1) {
      const tick = (): void => {
        spinClock.set(performance.now());
        spinClockFrame = requestAnimationFrame(tick);
      };
      spinClockFrame = requestAnimationFrame(tick);
    }
    return () => {
      spinClockUsers -= 1;
      if (spinClockUsers === 0) cancelAnimationFrame(spinClockFrame);
    };
  }, []);
  return spinClock;
}

function Helix({ size, speed, reduce }: PartProps) {
  const rows = 7;
  const dot = size * 0.14;
  const amp = size * 0.32;
  return (
    // Drawn on its side. The registry's helix is a column of rows whose pair of dots crosses
    // left-to-right, which is the wrong shape for this app's one-line running row: the whole
    // box takes a quarter turn — a transform on the box, not a change to the animation — so the
    // rows read left-to-right and the crossing becomes vertical. The box is square and the dots
    // stay inside it, so the turn costs no layout and the glyph stays in its slot.
    <span className="relative -rotate-90" style={{ width: size, height: size }}>
      {Array.from({ length: rows }, (_, r) => {
        const top = (r / (rows - 1)) * (size - dot);
        const delay = (r / rows) * speed;
        return (
          <span key={`row-${top}`}>
            <motion.span
              className="absolute rounded-full bg-current"
              style={{ width: dot, height: dot, left: size / 2 - dot / 2, top }}
              animate={
                reduce
                  ? { opacity: [0.4, 1, 0.4] }
                  : {
                      x: [amp, -amp, amp],
                      scale: [1, 0.5, 1],
                      opacity: [1, 0.45, 1],
                    }
              }
              transition={{
                duration: speed,
                ease: EASE_IN_OUT,
                repeat: Infinity,
                delay,
              }}
            />
            <motion.span
              className="absolute rounded-full bg-current"
              style={{ width: dot, height: dot, left: size / 2 - dot / 2, top }}
              animate={
                reduce
                  ? { opacity: [0.4, 1, 0.4] }
                  : {
                      x: [-amp, amp, -amp],
                      scale: [0.5, 1, 0.5],
                      opacity: [0.45, 1, 0.45],
                    }
              }
              transition={{
                duration: speed,
                ease: EASE_IN_OUT,
                repeat: Infinity,
                delay,
              }}
            />
          </span>
        );
      })}
    </span>
  );
}

/**
 * The beUI `spinner`: a two-tone ring with a half-length arc, turning on the spot.
 *
 * The angle is read off the clock every spinner shares (`useSpinClock`), not animated per element:
 * a `motion` animation — and motion's own `useTime` — counts from the moment its own element first
 * animates, so a rail whose running conversations began at different moments turned its rings in
 * different directions at the same instant and read as scattered (2026-10-21, user report). Reading
 * the shared clock puts every ring at the same angle — one signal, however many rows carry it. The
 * reduced-motion swap to a calm opacity pulse rides the same clock, so a reader who asked for less
 * motion sees the same 14px footprint.
 */
function Spinner({ size, speed, reduce }: PartProps) {
  const stroke = Math.max(2, size * 0.09);
  const r = (size - stroke) / 2;
  const time = useSpinClock();
  const rotate = useTransform(time, (now) =>
    reduce ? 0 : ((now / (speed * 1000)) % 1) * 360,
  );
  const opacity = useTransform(time, (now) =>
    reduce ? 0.7 + 0.3 * Math.cos((now / 1400) * Math.PI * 2) : 1,
  );
  return (
    <motion.svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      style={{ rotate, opacity }}
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="currentColor"
        strokeOpacity={0.2}
        strokeWidth={stroke}
      />
      <path
        d={`M ${size / 2} ${size / 2 - r} A ${r} ${r} 0 0 1 ${size / 2 + r} ${size / 2}`}
        fill="none"
        stroke="currentColor"
        strokeWidth={stroke}
        strokeLinecap="round"
      />
    </motion.svg>
  );
}
