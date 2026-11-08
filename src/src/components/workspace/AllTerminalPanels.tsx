/**
 * Every conversation's terminals, mounted at once.
 *
 * A shell is alive exactly as long as its `TerminalPanel` is, so the panels cannot be scoped to the
 * conversation on screen: switching conversations must leave the other shells running (a tab is
 * closed by its ✕, not by looking away). What the reader sees is one panel per conversation; the rest
 * remain mounted and are visually hidden without collapsing their xterm host.
 *
 * The target of each shell — its session file and its directory — is read from the tab, which
 * resolved it when the tab was created. Reading it here from the active conversation would hand an
 * empty directory to every conversation that is not the one on screen.
 */

import { TerminalPanel } from "@/components/workspace/TerminalPanel";
import { usePanelState } from "@/state/panel-state";

export function AllTerminalPanels({
  visibleSessionId,
  visibleTabId,
  onShellLabel,
}: {
  visibleSessionId: string | null;
  visibleTabId: number | null;
  onShellLabel: (sessionId: string, tabId: number, label: string) => void;
}) {
  const panel = usePanelState();
  return (
    <>
      {Object.entries(panel.tabs).map(([owner, tabs]) =>
        tabs.map((tab) => (
          <TerminalPanel
            key={tab.id}
            ownerSessionId={owner}
            tabId={tab.id}
            terminalId={tab.terminalId}
            mode={tab.mode}
            exited={tab.exited}
            failed={tab.failed}
            ownerSessionFile={tab.ownerSessionFile}
            cwd={tab.cwd}
            visible={owner === visibleSessionId && tab.id === visibleTabId}
            onShellLabel={(label) => onShellLabel(owner, tab.id, label)}
          />
        )),
      )}
    </>
  );
}
