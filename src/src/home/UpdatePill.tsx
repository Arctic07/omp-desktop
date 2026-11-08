"use client";
// The title bar's update pill: what 帮助's neighbour offers once a release is announced.

import { Download, RefreshCw } from "lucide-react";

import { Button } from "@/components/motion/button";
import { Loader } from "@/components/motion/loader";
import { Tooltip } from "@/components/motion/tooltip";
import { useCopy, type Localized } from "@/lib/i18n";
import { NO_HOVER_GROWTH } from "@/lib/hover-motion";
import { cn } from "@/lib/utils";
import { installUpdate, relaunchForUpdate, updateStore } from "@/state/update-store";
import {
  clampedPercent,
  updateAction,
  updatePillVisible,
  type PillStatus,
} from "@/state/update-view";
import { useStoreSelector } from "@/state/store";

interface UpdatePillCopy {
  update: string;
  downloading: string;
  restart: string;
  retry: string;
  availableHint: (version: string) => string;
  downloadingHint: string;
  restartHint: string;
  retryHint: string;
}

const COPY: Localized<UpdatePillCopy> = {
  en: {
    update: "Update",
    downloading: "Downloading",
    restart: "Restart to update",
    retry: "Retry update",
    availableHint: (version) =>
      version === "" ? "A new version is available" : `Version ${version} is available`,
    downloadingHint: "Downloading the new version",
    restartHint: "The new version is downloaded; restart to finish",
    retryHint: "The download did not finish; click to try again",
  },
  zh: {
    update: "更新",
    downloading: "下载中",
    restart: "重启更新",
    retry: "重试更新",
    availableHint: (version) =>
      version === "" ? "有新版本可用" : `新版本 ${version} 可用`,
    downloadingHint: "正在下载新版本",
    restartHint: "新版本已下载，重启即可完成更新",
    retryHint: "下载未完成，点击重试",
  },
};

/**
 * The one update control in the window's frame.
 *
 * It sits after 帮助 and appears only while there is something to do — an announced release, its
 * download, a downloaded one waiting for a restart, or a failed download that is still retryable.
 * Checking and being current stay in the About page: a pill with nothing to press is noise, and a
 * failed check has no announced version to name.
 */
export function UpdatePill({ className }: { className?: string }) {
  const copy = useCopy(COPY);
  const status = useStoreSelector(updateStore, (state) => state.status);
  if (!updatePillVisible(status)) return null;

  const label = pillLabel(status, copy);
  const hint = pillHint(status, copy);
  const action = updateAction(status);

  return (
    <Tooltip content={hint}>
      <Button
        {...NO_HOVER_GROWTH}
        type="button"
        variant="secondary"
        size="sm"
        aria-label={`${label}. ${hint}`}
        disabled={action === null}
        onClick={() => {
          if (action === "install") void installUpdate();
          else if (action === "relaunch") void relaunchForUpdate();
        }}
        className={cn(
          "ml-1 h-7 shrink-0 gap-1 rounded-full border-transparent px-2.5 text-[12px] font-medium",
          "bg-amber-400 text-amber-950 hover:bg-amber-300",
          "dark:bg-amber-400 dark:text-amber-950 dark:hover:bg-amber-300",
          className,
        )}
      >
        <PillIcon status={status} />
        {label}
      </Button>
    </Tooltip>
  );
}

function PillIcon({ status }: { status: PillStatus }) {
  switch (status.phase) {
    case "available":
      return <Download className="size-3" aria-hidden="true" />;
    case "downloading":
      return <Loader size={12} className="text-current" />;
    case "ready":
    case "error":
      return <RefreshCw className="size-3" aria-hidden="true" />;
    default:
      return assertNever(status.phase);
  }
}

function pillLabel(status: PillStatus, copy: UpdatePillCopy): string {
  switch (status.phase) {
    case "available":
      return copy.update;
    case "downloading": {
      const percent = clampedPercent(status.progress);
      return percent === null ? copy.downloading : `${copy.downloading} ${percent}%`;
    }
    case "ready":
      return copy.restart;
    case "error":
      return copy.retry;
    default:
      return assertNever(status.phase);
  }
}

function pillHint(status: PillStatus, copy: UpdatePillCopy): string {
  switch (status.phase) {
    case "available":
      return copy.availableHint(status.version ?? "");
    case "downloading":
      return copy.downloadingHint;
    case "ready":
      return copy.restartHint;
    case "error":
      return copy.retryHint;
    default:
      return assertNever(status.phase);
  }
}

function assertNever(value: never): never {
  throw new Error(`unhandled update pill phase: ${String(value)}`);
}
